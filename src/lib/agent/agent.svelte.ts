import { processMessage } from '../core/processor';
import { toolRegistry } from '../core/registries/tool-registry';
import { actionRegistry } from '../core/registries/action-registry';
import { userActionBus, type UserAction } from '../core/registries/event-bus';
import {
	A2UI_EXTENSION_NAMESPACE,
	wrapExtension,
	type ExtensionOptions
} from '../core/extensions';
import type {
	AgentTransport,
	AgentTransportConnectOptions,
	TransportCapabilities
} from './transport';
import { buildSystemPrompt, type PromptInputs } from './prompt-builder';
import { AgentDebugStats, type DebugOutboundKind } from './debug.svelte';
import { AudioRecorder } from './audio-recorder';
import { AudioPlayer } from './audio-player';

export type AgentMode = 'static' | 'dynamic' | 'both';
export type AgentStatus = 'idle' | 'thinking' | 'error';

/**
 * Strip data-model *values* from a serialised surface, leaving only its
 * structure. A static surface carries values in a `dataModel` array
 * (`[{ key, valueString }]`); a dynamic surface in a `data` object. Removing
 * both yields a value-independent structural view, so the sync loop can tell
 * a structural change (navigation, a component appearing) apart from a mere
 * value edit.
 */
function stripDataModel(json: unknown): unknown {
	if (json && typeof json === 'object' && !Array.isArray(json)) {
		const { dataModel: _dataModel, data: _data, ...rest } = json as Record<string, unknown>;
		return rest;
	}
	return json;
}

/**
 * Read a surface's `{ fieldId → value }` data model. Prefers the handle's
 * explicit `getDataModel()`; falls back to deriving it from `getJson()` — the
 * static `dataModel` array or the dynamic `data` object — so hand-rolled
 * handles without the method still get cheap deltas where possible.
 */
function readDataModel(surface: AgentSurface): Record<string, unknown> {
	if (typeof surface.getDataModel === 'function') {
		try {
			return surface.getDataModel() ?? {};
		} catch {
			return {};
		}
	}
	const json = surface.getJson();
	if (json && typeof json === 'object') {
		const obj = json as Record<string, unknown>;
		if (Array.isArray(obj.dataModel)) {
			const out: Record<string, unknown> = {};
			for (const entry of obj.dataModel as Array<{ key?: unknown; valueString?: unknown }>) {
				if (entry && typeof entry.key === 'string') out[entry.key] = entry.valueString;
			}
			return out;
		}
		if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) {
			return { ...(obj.data as Record<string, unknown>) };
		}
	}
	return {};
}

export interface AgentSurface {
	id: string;
	type: 'static' | 'dynamic';
	getJson(): unknown;
	/**
	 * The surface's **data model** — a flat `{ fieldId → value }` map of the
	 * values the user (or agent) has entered, decoupled from the component
	 * tree. This is the unit of `'sync'`-mode delivery (A2UI v0.9
	 * `sendDataModel`): only changed entries are pushed to the agent, so a
	 * keystroke costs tens of bytes instead of the whole tree.
	 *
	 * `<StaticSurface>` / `<DynamicSurface>` implement this from their
	 * registry / data-model state. When a handle omits it, the agent derives
	 * the map from `getJson()` (the static `dataModel` array or the dynamic
	 * `data` object) — so pre-existing hand-rolled handles keep working.
	 */
	getDataModel?(): Record<string, unknown>;
	/**
	 * Per-surface extension flags (see `ExtensionOptions`). When omitted, the
	 * agent treats the surface as `ALL_EXTRAS` (every extension enabled) so
	 * pre-extension-era surface handles keep working unchanged.
	 *
	 * `<StaticSurface>` populates this automatically from its resolved
	 * `options` prop; hosts that publish hand-rolled surface handles can pass
	 * a record explicitly.
	 */
	extensions?: ExtensionOptions;
}

/**
 * How surface changes that the user makes (typing into a field, navigating,
 * editing through the HTML UI) are delivered to the agent. Both modes only
 * apply to surfaces that opted into the `surfaceWatch` extension.
 *
 * - `'sync'` (default): the agent stays **silently aware** via A2UI v0.9
 *   data-model synchronization. The unit of state is the surface's
 *   `{ fieldId → value }` data model — the static component structure is
 *   already in the system prompt and does not change when the user types.
 *   Only **changed entries** are pushed (a tiny delta, not the 21 KB tree),
 *   and only in **idle windows** (a debounced settle tick, `turn-complete`,
 *   or right before a typed message / button action) — **never while the
 *   model is generating** on an interruptible transport, so it can't
 *   barge-in-interrupt the answer. Edits made while the agent is speaking are
 *   buffered and coalesced (latest value per field wins), then flushed in the
 *   next idle slot. Structural changes (navigation, a component
 *   appearing/disappearing) fall back to a full surface re-sync, because a
 *   value delta can't convey new structure. Delivery rides the transport's
 *   `sendContextUpdate` channel (`turnComplete: false`), which appends to
 *   context without provoking a response. So when the user asks "what's in the
 *   text box?", the model already sees what they typed, but it never reacts to
 *   the typing on its own.
 *
 * - `'piggyback'`: **deprecated alias for `'sync'`.** The old implementation
 *   flushed the full tree on the user's first input-transcription chunk,
 *   which on Gemini Live arrives at turn-close and interrupted the answer.
 *   `'sync'` supersedes it; the name is kept so existing configs keep working.
 *
 * - `'proactive'`: the historical reactive behaviour. A timer diffs the
 *   surface and pushes a `<event>SURFACE_UPDATED</event>` text turn (the full
 *   tree) as soon as a change settles, so the agent can react to UI changes
 *   unprompted. Requires a transport that can initiate a turn
 *   (`capabilities.canInitiateTurn`); on transports that can't, it falls back
 *   to `'sync'`. Kept as an opt-in for hosts who prefer a chattier agent.
 */
export type SurfaceWatchMode = 'sync' | 'piggyback' | 'proactive';

/**
 * Non-extension tuning for the surface-watch loop. These are cadence/behaviour
 * knobs — not feature flags — so they live on the agent rather than under
 * `ExtensionOptions`. Whether watching runs at all is decided per-surface via
 * `surface.extensions.surfaceWatch`.
 */
export interface SurfaceWatchTuning {
	/**
	 * Delivery mode for user-driven surface changes. Default `'sync'`.
	 * See `SurfaceWatchMode`.
	 */
	mode?: SurfaceWatchMode;
	/**
	 * Poll cadence in milliseconds — the interval at which the watch loop
	 * checks for an undelivered change. Polling does **not** itself deliver;
	 * it only triggers a delivery once a change has settled (and the model is
	 * idle). Default 500 in `'sync'` mode, 3000 in `'proactive'` mode. Only the
	 * poll timer runs on streaming transports; a non-streaming (request/
	 * response) transport relies on the pre-turn flush instead.
	 */
	intervalMs?: number;
	/**
	 * Quiet period a change must hold before it is delivered, in milliseconds.
	 * Debounces in-flight edits: a value still changing (e.g. the user
	 * mid-typing "John") is not delivered until it has been stable for
	 * `settleMs`, so the agent never sees a half-typed value, and multiple
	 * keystrokes coalesce into one delivery. For finer settle resolution, keep
	 * `intervalMs` below `settleMs`. Structural changes (navigation) bypass the
	 * settle window. Default 400 in `'sync'` mode, 3000 in `'proactive'` mode.
	 */
	settleMs?: number;
	/**
	 * `'proactive'` only — cooldown after an agent-driven mutation during which
	 * surface diffs are suppressed (so the agent doesn't get notified of its
	 * own writes). Surface-id changes (navigation) always bypass this.
	 * Default 5000. (In `'sync'` mode the agent's own writes are excluded by
	 * marking them delivered, so no cooldown is needed.)
	 */
	cooldownMs?: number;
}

/**
 * What an agent *is*, independent of how it talks to a model: its persona,
 * the surfaces it can see and act on, and its prompt/watch behaviour. Tools
 * are contributed through the global `toolRegistry` (and per-surface action
 * registrations); future uniform mechanics (guardrails, subagents, lifecycle
 * hooks) will be added here.
 *
 * A definition is a plain object — declare it once and connect it to any
 * {@link AgentTransport}: `new Agent(definition, transport)`. Swapping the
 * transport (voice live-API ↔ request/response text) changes nothing else.
 */
export interface AgentDefinition {
	/** The agent's persona + behaviour prompt (the base system instruction). */
	instructions: string;
	/** Live source of currently-active surfaces. Called on every interval tick. */
	surfaces: () => AgentSurface[];
	/** Live source of page-specific context instructions. Default: none. */
	contextInstructions?: () => string;
	/** Static / dynamic / both. Default 'static'. */
	mode?: AgentMode;
	/** Override prompt assembly entirely. */
	buildPrompt?: (inputs: PromptInputs) => string;
	/**
	 * Cadence tuning for the surface-watch polling loop. Whether the loop
	 * runs is decided per-surface via `surface.extensions.surfaceWatch`;
	 * these knobs only control timing.
	 */
	surfaceWatchTuning?: SurfaceWatchTuning;
	/**
	 * Token/byte debug telemetry. The agent always exposes a `debug`
	 * (`AgentDebugStats`) so a host can render a debug box (see
	 * `<AgentShell debug>`); this option only tunes it:
	 *  - omit / `true`  → default instance, recording on;
	 *  - an `AgentDebugStats` → use this instance (e.g. to share/configure
	 *    `charsPerToken`);
	 *  - `false` → recording off (the instance still exists but stays empty),
	 *    for hosts that don't want the (cheap) measurement overhead.
	 */
	debug?: boolean | AgentDebugStats;
}

/**
 * The agent orchestrator: an {@link AgentDefinition} connected to an
 * {@link AgentTransport}. Owns prompt assembly (via prompt-builder), tool
 * dispatch, the surface-watch engine (sync / proactive), `userActionBus`
 * subscription, transcript + status + debug state, and the thinking-watchdog.
 *
 * One class drives every channel. It adapts to the transport's
 * {@link TransportCapabilities} — never to its identity: the barge-in gates
 * apply when `interruptible`, the poll loop runs when `streaming`, history is
 * embedded or seeded per `historyOwnership`, and the mic recorder / speaker
 * player spin up exactly when `input`/`output` include `'audio'` (with
 * `muted`/`toggleMute` to silence the mic without dropping the session).
 *
 * Does NOT own any UI — pair it with `<AgentShell>` or render your own from
 * its reactive state.
 */
export class Agent {
	connected = $state(false);
	status = $state<AgentStatus>('idle');
	transcript = $state<Array<{ role: 'user' | 'model'; text: string }>>([]);
	hasStarted = $state(false);
	configIssue = $state<string | null>(null);
	/** True while the mic recorder is capturing (audio-input transports only). */
	recording = $state(false);
	/**
	 * Mic muted while the session stays open. When `true`, captured audio chunks
	 * are dropped instead of sent to the transport — the live connection,
	 * playback, and surface-sync all keep running. Lets the user silence a noisy
	 * environment so trailing background noise isn't heard as a barge-in that
	 * cuts the agent off mid-answer. Meaningful only on audio-input transports;
	 * see `toggleMute()`.
	 */
	muted = $state(false);
	/**
	 * Live token/byte telemetry for the session — outbound payload sizes the
	 * agent sends (system prompt, tool results, context syncs, audio) plus the
	 * provider's authoritative usage reports. Reactive; bind a debug box to it
	 * (or pass `debug` to `<AgentShell>`). See `AgentDebugStats`.
	 */
	debug: AgentDebugStats;

	#def: AgentDefinition;
	#transport: AgentTransport;
	#debugEnabled: boolean;
	#mode: AgentMode;
	#surfaceWatchTuning: Required<SurfaceWatchTuning>;
	#unsubs: Array<() => void> = [];
	#surfaceInterval: ReturnType<typeof setInterval> | null = null;
	#lastAgentMutationAt = 0;
	// Audio I/O — created in `start()` only when the transport's capabilities
	// include the matching modality; null on text-only transports.
	#recorder: AudioRecorder | null = null;
	#player: AudioPlayer | null = null;
	// True while the model is producing a turn (audio / transcript out), false
	// once it goes idle (turn-complete / interrupted). On an interruptible
	// transport `'sync'` delivery is gated off while this is true so a
	// `sendContextUpdate` can never barge-in-interrupt an in-progress answer.
	// Skipped deliveries are not lost: the next idle tick (or turn-complete)
	// re-attempts and the diff-vs-last-delivered design coalesces everything
	// that changed. Flipped by text-out, audio-out, turn-complete, interrupted.
	protected modelTurnActive = false;
	// ── Proactive-mode delivery tracking ──
	// What the model currently knows: the last full surface state delivered
	// (via a proactive push or an agent tool-call result).
	#lastDeliveredSnapshot = '';
	#lastDeliveredContext = '';
	#lastDeliveredIds = '';
	// Settle tracking (proactive mode): the snapshot seen on the previous tick
	// and when it last changed, so a still-moving value isn't delivered until
	// it has held steady for `settleMs`.
	#lastObservedSnapshot = '';
	#lastObservedContext = '';
	#lastObservedChangeAt = 0;
	// ── Sync-mode delivery tracking ──
	// The structural snapshot (component tree minus data-model values, plus
	// surface ids) the model last saw — a change here means structure changed
	// (navigation / a component appeared) and forces a full re-sync.
	#lastDeliveredStructure = '';
	// Per-surface `{ fieldId → value }` data model the model last saw. Deltas
	// are computed against this; latest value per field wins.
	#lastDeliveredDataModel: Map<string, Record<string, unknown>> = new Map();
	// Settle tracking (sync mode): combined structure+data-model+context
	// snapshot seen on the previous tick and when it last changed.
	#lastSyncObservedSnapshot = '';
	#lastSyncObservedChangeAt = 0;
	#intentionalDisconnect = false;
	#currentModelText = '';
	// Whether the next inbound text chunk continues the current user turn.
	protected canAppendToUser = false;
	// Watchdog for the `'thinking'` badge. Armed whenever status becomes
	// `'thinking'` and cleared the moment we leave it (model activity / turn-
	// complete / idle / error). If the expected response never materialises
	// within the window — e.g. a turn dropped server-side, or an interruption
	// with no follow-up — the badge self-heals to `'idle'` instead of spinning
	// forever.
	#thinkingTimer: ReturnType<typeof setTimeout> | null = null;
	// How long the badge may show `'thinking'` with zero model activity before
	// it self-heals. A live turn (audio / transcript / tool-call / turn-
	// complete) re-arms or clears this well inside the window.
	#thinkingTimeoutMs = 12_000;

	constructor(definition: AgentDefinition, transport: AgentTransport) {
		this.#def = definition;
		this.#transport = transport;
		this.debug =
			definition.debug instanceof AgentDebugStats ? definition.debug : new AgentDebugStats();
		this.#debugEnabled = definition.debug !== false;
		this.#mode = definition.mode ?? 'static';
		// `'piggyback'` is a deprecated alias for `'sync'` — normalise it so the
		// rest of the class only ever sees `'sync'` / `'proactive'`.
		const rawMode = definition.surfaceWatchTuning?.mode ?? 'sync';
		let mode: SurfaceWatchMode = rawMode === 'piggyback' ? 'sync' : rawMode;
		// `'proactive'` needs a transport that can start its own turn; fall back
		// to silent `'sync'` when the transport can't (e.g. request/response text).
		if (mode === 'proactive' && !transport.capabilities.canInitiateTurn) {
			console.warn(
				"[Agent] 'proactive' surface-watch needs a transport that can initiate turns; falling back to 'sync'."
			);
			mode = 'sync';
		}
		const isSync = mode === 'sync';
		this.#surfaceWatchTuning = {
			mode,
			intervalMs: definition.surfaceWatchTuning?.intervalMs ?? (isSync ? 500 : 3000),
			settleMs: definition.surfaceWatchTuning?.settleMs ?? (isSync ? 400 : 3000),
			cooldownMs: definition.surfaceWatchTuning?.cooldownMs ?? 5000
		};
	}

	/** The transport driving this agent. */
	get transport(): AgentTransport {
		return this.#transport;
	}

	/**
	 * What the transport can do — the gate for all channel-specific behaviour,
	 * inside the agent and out (e.g. `<AgentShell>` shows the mic exactly when
	 * `capabilities.input` includes `'audio'`).
	 */
	get capabilities(): TransportCapabilities {
		return this.#transport.capabilities;
	}

	/** Page context source with the definition's optional field defaulted. */
	#contextInstructions(): string {
		return this.#def.contextInstructions?.() ?? '';
	}

	async start(): Promise<void> {
		this.setStatus('idle');
		this.configIssue = null;
		this.#intentionalDisconnect = false;
		// Fresh session ⇒ fresh telemetry.
		if (this.#debugEnabled) this.debug.reset();

		const tools = this.#assembleToolDeclarations();
		const systemInstruction = this.#buildPrompt(tools);

		// Snapshot the connect-time payload sizes. The system prompt embeds the
		// full serialized surface (pretty-printed), so this is usually the
		// single largest item in the session's token budget.
		if (this.#debugEnabled) {
			this.debug.toolCount = tools.length;
			this.rec('system-prompt', systemInstruction);
			this.rec('tools', tools);
		}

		// Client-history transports (text) seed prior turns through connect
		// options; server-history transports (voice) embed them in the prompt
		// instead (see `#buildPrompt`), so this stays absent there. Auth is the
		// transport's own concern (its constructor), so no token rides here.
		const connectOptions: AgentTransportConnectOptions = {
			systemInstruction,
			tools,
			...(this.capabilities.historyOwnership === 'client'
				? { history: this.transcript }
				: {})
		};

		try {
			await this.#transport.connect(connectOptions);
		} catch (e) {
			console.error('[Agent] Failed to connect transport:', e);
			this.configIssue = (e as Error).message ?? 'Failed to connect';
			this.setStatus('error');
			return;
		}

		this.#wireCommonTransportEvents();
		this.#unsubs.push(userActionBus.subscribe((a) => this.#handleUserAction(a)));

		// Spin up the mic/speaker exactly when the transport's capabilities say
		// so — never from its identity. No-op on text-only transports.
		try {
			await this.#startAudio();
		} catch (e) {
			console.error('[Agent] Failed to start audio input:', e);
			this.configIssue = (e as Error).message ?? 'Microphone unavailable';
			this.setStatus('error');
			void this.stop();
			return;
		}

		this.connected = true;
		this.hasStarted = true;
		this.canAppendToUser = false;
		this.#startSurfaceWatch();
	}

	async stop(): Promise<void> {
		this.#stopSurfaceWatch();
		this.#clearThinkingWatchdog();

		for (const u of this.#unsubs) {
			try {
				u();
			} catch {
				// best-effort
			}
		}
		this.#unsubs = [];

		try {
			this.#transport.close();
		} catch {
			// best-effort
		}

		this.#stopAudio();

		if (this.#currentModelText.trim()) {
			this.transcript = [
				...this.transcript,
				{ role: 'model', text: this.#currentModelText.trim() }
			];
			this.#currentModelText = '';
		}

		this.connected = false;
		this.canAppendToUser = false;
		this.modelTurnActive = false;
	}

	async toggle(): Promise<void> {
		if (this.connected) {
			this.#intentionalDisconnect = true;
			this.setStatus('idle');
			await this.stop();
		} else {
			await this.start();
		}
	}

	sendTextMessage(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (this.status !== 'error') this.setStatus('thinking');
		this.transcript = [...this.transcript, { role: 'user', text: trimmed }];
		this.canAppendToUser = false;
		if (this.connected) {
			// Sync the current data model onto this typed turn (silently, via the
			// context channel) so the model sees the latest UI before it reads the
			// user's message. A typed message is an idle moment, so this flushes
			// immediately. Ordered before the text turn below.
			if (this.#surfaceWatchTuning.mode === 'sync') this.#syncDataModel();
			this.#transport.sendText(trimmed);
			this.rec('text', trimmed);
		} else {
			console.warn('[Agent] Cannot send text message: not connected');
		}
	}

	async reset(): Promise<void> {
		if (this.connected) {
			this.#intentionalDisconnect = true;
			await this.stop();
		}
		this.setStatus('idle');
		this.transcript = [];
		this.#currentModelText = '';
		this.canAppendToUser = false;
		this.hasStarted = false;
		this.configIssue = null;
		if (this.#debugEnabled) this.debug.reset();
	}

	/**
	 * Mute / unmute the microphone **without** tearing down the session. While
	 * muted, captured audio chunks are dropped instead of sent, so the model
	 * hears silence; the live connection, playback, and surface-sync keep
	 * running. The use case is noisy environments — once the user has spoken,
	 * trailing background noise would otherwise be heard as a barge-in and cut
	 * the agent off mid-answer; muting prevents that. Idempotent w.r.t. the
	 * connection: muting/unmuting never connects or disconnects. No-op effect
	 * on transports without audio input (no recorder runs there).
	 */
	toggleMute(): void {
		this.muted = !this.muted;
	}

	// ===== Internals =====

	/** Record an outbound payload to `debug` (no-op when debug is disabled). */
	protected rec(kind: DebugOutboundKind, payload: unknown, note?: string): void {
		if (this.#debugEnabled) this.debug.recordOutbound(kind, payload, note);
	}

	/**
	 * Capability-gated audio I/O: a speaker player when the transport produces
	 * audio, a mic recorder when it accepts audio. Throws if the mic is
	 * unavailable (surfaced as `configIssue` by `start()`).
	 */
	async #startAudio(): Promise<void> {
		if (this.capabilities.output.includes('audio')) {
			this.#player = new AudioPlayer(24000);
		}
		if (!this.capabilities.input.includes('audio')) return;
		if (typeof this.#transport.sendAudioChunk !== 'function') {
			console.warn(
				'[Agent] Transport advertises audio input but implements no sendAudioChunk — mic disabled.'
			);
			return;
		}
		// A fresh session always starts listening — mute is a per-session state.
		this.muted = false;
		this.#recorder = new AudioRecorder();
		this.#recorder.addEventListener('data', (e) => {
			const detail = (e as CustomEvent<string>).detail;
			// Drop captured audio while muted — the recorder keeps running (so
			// unmute resumes instantly without re-prompting for mic access), the
			// chunks just never reach the transport.
			if (this.connected && !this.muted) {
				this.#transport.sendAudioChunk!(detail);
				this.rec('audio-out', detail);
			}
		});
		await this.#recorder.start();
		this.recording = true;
	}

	/** Tear down the recorder + player (no-op when none were started). */
	#stopAudio(): void {
		this.#recorder?.stop();
		this.#player?.stop();
		this.#recorder = null;
		this.#player = null;
		this.recording = false;
	}

	/**
	 * Wire the transport event stream. Every transport emits the text/tool
	 * events; `audio-out` / `interrupted` only ever fire from transports whose
	 * capabilities include them, so wiring is unconditional and the handlers
	 * are inert elsewhere.
	 */
	#wireCommonTransportEvents(): void {
		this.#unsubs.push(
			this.#transport.on('tool-call', (p) => {
				void this.#handleToolCall(p.calls);
			}),
			this.#transport.on('text-out', (p) => this.#onTextOut(p.text)),
			this.#transport.on('text-in', (p) => this.#onTextIn(p.text)),
			this.#transport.on('turn-complete', () => this.#onTurnComplete()),
			this.#transport.on('audio-out', (p) => {
				// Model is producing a turn — gate sync delivery so we never
				// interrupt the answer in flight.
				this.modelTurnActive = true;
				if (this.#debugEnabled) this.debug.recordInboundAudio(p.base64Pcm24k);
				this.#player?.addToQueue(p.base64Pcm24k);
				this.onModelActivity();
				this.canAppendToUser = false;
			}),
			this.#transport.on('interrupted', () => {
				// Generation was cut off (barge-in) — the model is idle again.
				this.modelTurnActive = false;
				this.#player?.stop();
				if (this.status !== 'error') this.setStatus('thinking');
			}),
			this.#transport.on('error', (p) => {
				console.error('[Agent] Transport error:', p.message, p.cause);
				if (!this.#intentionalDisconnect) this.setStatus('error');
				void this.stop();
			}),
			this.#transport.on('close', (p) => {
				console.log('[Agent] Transport closed:', p.reason);
				if (!this.#intentionalDisconnect) this.setStatus('error');
				void this.stop();
			}),
			this.#transport.on('usage', (u) => {
				// Authoritative provider token counts — the real number the quota
				// is measured against.
				if (this.#debugEnabled) this.debug.recordUsage(u);
			})
		);
	}

	/**
	 * Single funnel for status writes so the thinking-watchdog timer stays in
	 * lock-step with the badge. `'thinking'` means "a model response is
	 * expected"; arm a watchdog so a response that never arrives can't leave
	 * the badge spinning. Any other status means we're no longer waiting, so
	 * clear it.
	 */
	protected setStatus(next: AgentStatus): void {
		this.status = next;
		if (next === 'thinking') this.#armThinkingWatchdog();
		else this.#clearThinkingWatchdog();
	}

	#armThinkingWatchdog(): void {
		this.#clearThinkingWatchdog();
		this.#thinkingTimer = setTimeout(() => {
			this.#thinkingTimer = null;
			// The expected response never materialised within the window — most
			// likely a turn dropped server-side, or an interruption with no
			// follow-up. Recover the idle state (and re-open the sync gate) rather
			// than spin indefinitely.
			this.modelTurnActive = false;
			if (this.status === 'thinking') this.setStatus('idle');
		}, this.#thinkingTimeoutMs);
	}

	#clearThinkingWatchdog(): void {
		if (this.#thinkingTimer) {
			clearTimeout(this.#thinkingTimer);
			this.#thinkingTimer = null;
		}
	}

	protected onModelActivity(): void {
		if (this.status === 'thinking') this.setStatus('idle');
	}

	#onTextOut(text: string): void {
		if (!text) return;
		// Model is producing a turn — gate sync delivery (see `modelTurnActive`).
		this.modelTurnActive = true;
		this.onModelActivity();
		this.canAppendToUser = false;
		this.#currentModelText += text;
		const last = this.transcript.length - 1;
		if (last >= 0 && this.transcript[last].role === 'model') {
			this.transcript[last].text = this.#currentModelText;
		} else {
			this.transcript = [...this.transcript, { role: 'model', text: this.#currentModelText }];
		}
	}

	#onTextIn(text: string): void {
		if (!text) return;
		if (this.status !== 'error') this.setStatus('thinking');
		const last = this.transcript.length - 1;
		const isContinuation =
			this.canAppendToUser && last >= 0 && this.transcript[last].role === 'user';
		if (isContinuation) {
			this.transcript[last].text += text;
		} else {
			// First chunk of a new user turn. NOTE: on Gemini Live the whole
			// `inputTranscription` arrives in one burst at turn-close —
			// simultaneously with the model starting to generate — so flushing
			// surface state *here* barge-in-interrupts the answer. We deliberately
			// do NOT sync at speech time; sync happens in idle windows (the settle
			// tick, `turn-complete`, or before a typed message / action) so the
			// model already sees the current data model before it answers.
			this.transcript = [...this.transcript, { role: 'user', text }];
			this.canAppendToUser = true;
		}
	}

	#onTurnComplete(): void {
		if (this.#currentModelText.trim()) {
			const last = this.transcript.length - 1;
			if (last >= 0 && this.transcript[last].role === 'model') {
				this.transcript[last].text = this.#currentModelText;
			}
			this.#currentModelText = '';
		}
		// A turn boundary always ends the current user turn: the next inbound
		// chunk is a fresh user turn, not a continuation. Reset unconditionally —
		// a tool-only turn (common in dynamic mode) produces no model text, so
		// gating this on `#currentModelText` left the flag stuck `true` and merged
		// every following utterance into one turn.
		this.canAppendToUser = false;
		if (this.status === 'thinking') this.setStatus('idle');
		// The model just went idle: clear the gate and flush any change that was
		// buffered (coalesced) during its turn, without waiting for the next poll.
		// WP7 extension point: a turn-lifecycle hook (onTurnComplete) would slot
		// here so guardrails/subagents inherit it across every transport.
		this.modelTurnActive = false;
		if (this.#surfaceWatchTuning.mode === 'sync') this.#syncDataModel();
	}

	#assembleToolDeclarations(): Array<{
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	}> {
		const declarations = toolRegistry.getDeclarations().slice();

		if (this.#mode === 'dynamic' || this.#mode === 'both') {
			declarations.unshift({
				name: 'dataModelUpdate',
				description:
					"Updates the data model of a dynamic surface (A2UI v0.8). Components bound via {path: '...'} automatically re-render when their target path changes. Prefer this over re-sending surfaceUpdate when only content changes.",
				parameters: {
					type: 'object',
					properties: {
						surfaceId: { type: 'string', description: 'Target dynamic surface ID' },
						path: {
							type: 'string',
							description:
								"Optional JSON-Pointer location to update (e.g. '/user' or '/'). If omitted entirely, contents REPLACES the entire data model for the surface — so pass '/' to merge at the root without clobbering siblings."
						},
						contents: {
							type: 'array',
							description:
								'Adjacency list of data entries. Each entry has a `key` and exactly one typed value: `valueString`, `valueNumber`, `valueBoolean`, or `valueMap` (recursive list of further entries).',
							items: {
								type: 'object',
								properties: {
									key: { type: 'string' },
									valueString: { type: 'string' },
									valueNumber: { type: 'number' },
									valueBoolean: { type: 'boolean' },
									valueMap: {
										type: 'array',
										description:
											'Nested adjacency list — builds a nested object under this key.',
										items: { type: 'object' }
									}
								},
								required: ['key']
							}
						}
					},
					required: ['surfaceId', 'contents']
				}
			});

			declarations.unshift({
				name: 'beginRendering',
				description: 'Sets the root component to be rendered on the dynamic surface.',
				parameters: {
					type: 'object',
					properties: {
						surfaceId: { type: 'string' },
						root: { type: 'string', description: 'ID of the root component' }
					},
					required: ['surfaceId', 'root']
				}
			});

			declarations.unshift({
				name: 'surfaceUpdate',
				description: 'Pushes UI component definitions to a dynamic surface.',
				parameters: {
					type: 'object',
					properties: {
						surfaceId: { type: 'string' },
						components: {
							type: 'array',
							items: {
								type: 'object',
								properties: {
									id: { type: 'string' },
									component: { type: 'object' }
								},
								required: ['id', 'component']
							}
						}
					},
					required: ['surfaceId', 'components']
				}
			});
		}

		return declarations;
	}

	#buildPrompt(
		tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
	): string {
		const surfaces = this.#def.surfaces();
		const allowStatic = this.#mode === 'static' || this.#mode === 'both';
		const allowDynamic = this.#mode === 'dynamic' || this.#mode === 'both';

		const inputs: PromptInputs = {
			systemInstruction: this.#def.instructions,
			staticSurfaces: allowStatic
				? surfaces.filter((s) => s && s.type === 'static')
				: [],
			dynamicSurfaces: allowDynamic
				? surfaces.filter((s) => s && s.type === 'dynamic')
				: [],
			toolDeclarations: tools,
			contextInstructions: this.#contextInstructions(),
			// Server-history transports (voice) embed the recent transcript in the
			// prompt for reconnect continuity; client-history transports (text)
			// own `messages[]` and get prior turns via connect options instead, so
			// we omit the history block for them.
			transcriptHistory:
				this.capabilities.historyOwnership === 'server' ? this.transcript : [],
			includeDynamicGuide: this.#mode === 'dynamic'
		};

		return (this.#def.buildPrompt ?? buildSystemPrompt)(inputs);
	}

	async #handleToolCall(
		calls: Array<{ id: string; name: string; args: Record<string, unknown> }>
	): Promise<void> {
		if (this.status !== 'error') this.setStatus('thinking');
		this.#lastAgentMutationAt = Date.now();

		for (const call of calls) {
			// WP7 extension point: an onBeforeToolCall guard would slot here.
			let result: unknown;
			try {
				if (
					call.name === 'surfaceUpdate' ||
					call.name === 'beginRendering' ||
					call.name === 'dataModelUpdate'
				) {
					processMessage({ [call.name]: call.args } as never);
					result = { status: 'success' };
				} else {
					result = await toolRegistry.execute(call.name, call.args);
				}
				// Record the post-action surface state as already-delivered (both
				// the proactive and the sync baselines) so neither loop re-reports
				// the agent's own write back to it. This covers a dynamic render
				// (surfaceUpdate / beginRendering / dataModelUpdate mutates the
				// surface structure) just as much as a backend tool that mutates a
				// static surface — without it, the next sync flush echoes the
				// agent's own render back as a SURFACE_UPDATED event.
				this.#markAllDelivered();
			} catch (e) {
				result = { status: 'error', error: (e as Error).message ?? 'Unknown tool error' };
			}
			try {
				// Tool results are a top quota cost: with the `toolResultExtras`
				// extension the result echoes the FULL serialized surface back to
				// the model on every call. Size it so that's visible.
				this.rec('tool-result', result, call.name);
				this.#transport.sendToolResult(call.id, call.name, result);
			} catch (e) {
				console.error('[Agent] Failed to send tool result:', e);
				this.setStatus('error');
			}
		}
	}

	#handleUserAction(action: UserAction): void {
		if (!this.connected) {
			console.warn('[Agent] Dropping userAction — no active session:', action);
			return;
		}
		if (this.status !== 'error') this.setStatus('thinking');

		// A button click is a user-initiated turn too: in sync mode, attach the
		// current data model (silently) before the action so the agent reacts
		// with up-to-date knowledge of the UI.
		if (this.#surfaceWatchTuning.mode === 'sync') this.#syncDataModel();

		// Always emit the spec-canonical shape — `context` is required by the
		// spec, so default it to `{}` here even though the event-bus types
		// already require it. Belt-and-braces against hand-rolled emitters.
		const canonical: UserAction = {
			name: action.name,
			surfaceId: action.surfaceId,
			sourceComponentId: action.sourceComponentId,
			timestamp: action.timestamp,
			context: action.context ?? {}
		};

		// Prefer the transport's typed `sendUserAction` when implemented
		// (spec-aligned transports, see B7). Fall back to the legacy
		// XML-tagged-text wrapping otherwise — that's the only way to push the
		// event through voice live-APIs that lack a native event channel.
		try {
			if (typeof this.#transport.sendUserAction === 'function') {
				this.#transport.sendUserAction(canonical);
				this.rec('user-action', canonical, canonical.name);
				return;
			}
			const payload = { userAction: canonical };
			const message = `<event>USER_ACTION</event>\n<payload>\n${JSON.stringify(payload, null, 2)}\n</payload>`;
			this.#transport.sendText(message);
			this.rec('user-action', message, canonical.name);
		} catch (e) {
			console.warn('[Agent] Failed to forward userAction:', e);
		}
	}

	/**
	 * Surfaces that have opted into the `surfaceWatch` extension. A surface
	 * with no `extensions` field is treated as `ALL_EXTRAS` (opted in), so
	 * pre-extension-era handles keep their old polling behaviour.
	 *
	 * Both static and dynamic surfaces are watched: a dynamic surface's
	 * serialized JSON includes its data model, so polling lets the agent
	 * notice user input written into a path-bound field (e.g. a TextField
	 * the agent rendered, then the user typed into). STRICT surfaces opt out
	 * via `surfaceWatch === false`.
	 */
	#watchedSurfaces(): AgentSurface[] {
		return this.#def.surfaces().filter((s) => s && s.extensions?.surfaceWatch !== false);
	}

	#getSurfaceSnapshot(): string {
		return JSON.stringify(this.#watchedSurfaces().map((s) => s.getJson()));
	}

	#getSurfaceIds(): string {
		return this.#watchedSurfaces()
			.map((s) => s.id)
			.join(',');
	}

	#startSurfaceWatch(): void {
		// Whatever is on screen at connect time is part of the system prompt, so
		// the model already "knows" it — seed every baseline (proactive + sync) to
		// it so the first change is what gets delivered, not the initial state.
		this.#markAllDelivered();

		// Only a streaming transport has idle windows to poll. A non-streaming
		// (request/response) transport has no live session to push into between
		// turns — it relies on the pre-turn flush (`#syncDataModel()` from
		// `sendTextMessage()` / `#handleUserAction()`), which already gives the
		// model the current UI before it answers. So skip the timer there.
		if (!this.capabilities.streaming) return;

		// Both modes run a poll loop. In `'proactive'` mode the tick pushes a
		// turn-triggering full-tree update once a change settles; in `'sync'`
		// mode the tick delivers a silent data-model delta in the idle window
		// (gated on `modelTurnActive`). Polling never delivers on its own — it
		// only checks for an undelivered, settled change.
		const tick =
			this.#surfaceWatchTuning.mode === 'proactive'
				? () => this.#proactiveTick()
				: () => this.#syncTick();
		this.#surfaceInterval = setInterval(tick, this.#surfaceWatchTuning.intervalMs);
	}

	#stopSurfaceWatch(): void {
		if (this.#surfaceInterval) {
			clearInterval(this.#surfaceInterval);
			this.#surfaceInterval = null;
		}
	}

	/**
	 * Proactive-mode timer tick. Pushes a settled change as a turn-triggering
	 * `SURFACE_UPDATED` text turn so the agent can react unprompted.
	 *
	 * Settle debounce: a change is only delivered once it has held steady for
	 * `settleMs` — so a value still being typed (e.g. "Joh" → "John") is not
	 * reported mid-keystroke. Surface-id changes (navigation) are discrete, so
	 * they bypass both the settle window and the agent-mutation cooldown.
	 */
	#proactiveTick(): void {
		if (!this.connected) return;
		const watched = this.#watchedSurfaces();
		// No surface has opted into the watch extension — nothing to do.
		// (Page transitions may flip this on/off as surfaces mount/unmount.)
		if (watched.length === 0) return;

		const now = Date.now();
		const cur = this.#getSurfaceSnapshot();
		const ctx = this.#contextInstructions();
		const ids = this.#getSurfaceIds();

		// Track when the observed value last moved, independent of delivery, so
		// we can measure how long it has been stable.
		if (cur !== this.#lastObservedSnapshot || ctx !== this.#lastObservedContext) {
			this.#lastObservedSnapshot = cur;
			this.#lastObservedContext = ctx;
			this.#lastObservedChangeAt = now;
		}

		const undelivered = cur !== this.#lastDeliveredSnapshot || ctx !== this.#lastDeliveredContext;
		if (!undelivered) return;

		const idsChanged = ids !== this.#lastDeliveredIds;
		const settled = now - this.#lastObservedChangeAt >= this.#surfaceWatchTuning.settleMs;
		const cooldownPassed = now - this.#lastAgentMutationAt > this.#surfaceWatchTuning.cooldownMs;

		if (idsChanged || (settled && cooldownPassed)) {
			this.#deliverSurfaceUpdate(cur, ctx, ids, false);
		}
	}

	// ===== Sync mode (A2UI v0.9 data-model synchronization) =====

	/**
	 * Sync-mode poll tick. Settle-gated: a change is only delivered once it has
	 * held steady for `settleMs` (so mid-typing values coalesce), and — on an
	 * interruptible transport — never while the model is busy. Structural
	 * changes (navigation) bypass the settle window. Polling here is
	 * *change-detection only* — it sends nothing unless there's an undelivered,
	 * settled change.
	 *
	 * "Busy" spans the whole turn, not just audio playback: `modelTurnActive`
	 * covers the model speaking, and `status === 'thinking'` covers the window
	 * between the user finishing and the first audio/tool-call — including a
	 * *tool-only* turn (dynamic-surface renders) that never emits audio. An
	 * autonomous `sendContextUpdate` in either window barges into the forming
	 * response (no transcript, render stalls; or the turn drops and the badge
	 * sticks on `'thinking'`). The change isn't lost — it's re-attempted at
	 * `turn-complete` (and on the next idle tick). On a non-interruptible
	 * transport there's nothing to barge into, so the busy gate is skipped.
	 */
	#syncTick(): void {
		if (!this.connected) return;
		// Barge-in only exists on an interruptible (streaming voice) session; for
		// non-interruptible transports an idle-window delivery can't interrupt
		// anything, so deliver freely.
		if (this.capabilities.interruptible && (this.modelTurnActive || this.status === 'thinking'))
			return;
		const watched = this.#watchedSurfaces();
		if (watched.length === 0) return;

		const now = Date.now();
		const structure = this.#getStructuralSnapshot(watched);
		const dataModels = this.#getDataModelSnapshot(watched);
		const ctx = this.#contextInstructions();
		const observed = `${structure} ${this.#serializeDataModels(dataModels)} ${ctx}`;

		// Track when the observed state last moved, independent of delivery.
		if (observed !== this.#lastSyncObservedSnapshot) {
			this.#lastSyncObservedSnapshot = observed;
			this.#lastSyncObservedChangeAt = now;
		}

		const structuralChanged = structure !== this.#lastDeliveredStructure;
		const settled = now - this.#lastSyncObservedChangeAt >= this.#surfaceWatchTuning.settleMs;
		if (structuralChanged || settled) {
			this.#deliverSync(watched, structure, dataModels, ctx);
		}
	}

	/**
	 * Sync-mode direct flush (idle moment: `turn-complete`, before a typed
	 * message, or before a button action). On an interruptible transport it's
	 * gated on `modelTurnActive` so it never interrupts an in-progress answer;
	 * if it's gated off the change stays pending and the next idle tick /
	 * turn-complete delivers it.
	 */
	#syncDataModel(): void {
		if (!this.connected) return;
		if (this.capabilities.interruptible && this.modelTurnActive) return;
		const watched = this.#watchedSurfaces();
		if (watched.length === 0) return;
		this.#deliverSync(
			watched,
			this.#getStructuralSnapshot(watched),
			this.#getDataModelSnapshot(watched),
			this.#contextInstructions()
		);
	}

	/**
	 * Decide what (if anything) to deliver and do it:
	 * - structure changed (navigation / component appeared/disappeared) → full
	 *   surface re-sync (a value delta can't convey new structure);
	 * - else only data-model and/or context changed → a data-model delta
	 *   (changed `{ fieldId → value }` entries only).
	 */
	#deliverSync(
		watched: AgentSurface[],
		structure: string,
		dataModels: Map<string, Record<string, unknown>>,
		ctx: string
	): void {
		if (structure !== this.#lastDeliveredStructure) {
			this.#deliverFullSurface(watched, structure, dataModels, ctx);
			return;
		}
		const delta = this.#computeDataModelDelta(dataModels);
		const ctxChanged = ctx !== this.#lastDeliveredContext;
		if (Object.keys(delta).length === 0 && !ctxChanged) return;
		this.#deliverDataModelDelta(delta, ctxChanged, structure, dataModels, ctx);
	}

	/**
	 * Structural change / navigation: send the full component tree (today's
	 * `surfaceUpdated` payload), silently. The agent replaces its structural
	 * understanding and learns the new element ids from it.
	 */
	#deliverFullSurface(
		watched: AgentSurface[],
		structure: string,
		dataModels: Map<string, Record<string, unknown>>,
		ctx: string
	): void {
		const payload = wrapExtension(A2UI_EXTENSION_NAMESPACE, {
			kind: 'surfaceUpdated',
			updatedSurfaces: watched.map((s) => s.getJson()),
			updatedContext: ctx,
			availableElementIds: actionRegistry.listActions()
		});
		const message = `<event>SURFACE_UPDATED</event>\n<payload>\n${JSON.stringify(payload, null, 2)}\n</payload>`;
		if (this.#sendSilently(message)) {
			// Structural re-sync ships the whole tree — the expensive sync path.
			this.rec('context-update', message, 'full-surface');
			this.#markSyncDelivered(structure, dataModels, ctx);
		}
	}

	/**
	 * Value change: send only the changed `{ fieldId → value }` entries
	 * (`a2uiClientDataModel` shape), silently. `updatedContext` rides along as a
	 * sibling only when the page context also changed. Merge semantics: the
	 * agent upserts each key; absent keys are unchanged.
	 */
	#deliverDataModelDelta(
		delta: Record<string, Record<string, unknown>>,
		ctxChanged: boolean,
		structure: string,
		dataModels: Map<string, Record<string, unknown>>,
		ctx: string
	): void {
		const ext: Record<string, unknown> = {
			kind: 'clientDataModel',
			version: 'v0.9',
			delta: true,
			surfaces: delta
		};
		if (ctxChanged) ext.updatedContext = ctx;
		const payload = wrapExtension(A2UI_EXTENSION_NAMESPACE, ext);
		const message = `<event>SURFACE_UPDATED</event>\n<payload>\n${JSON.stringify(payload, null, 2)}\n</payload>`;
		if (this.#sendSilently(message)) {
			// The cheap path: only the changed fields, not the tree.
			this.rec('context-update', message, 'data-model-delta');
			this.#markSyncDelivered(structure, dataModels, ctx);
		}
	}

	/**
	 * Deliver a message through the silent context channel
	 * (`sendContextUpdate`, `turnComplete: false`). Transports without a silent
	 * channel fall back to `sendText` (which may provoke a turn — acceptable
	 * degradation). Returns whether the send succeeded.
	 */
	#sendSilently(message: string): boolean {
		try {
			if (typeof this.#transport.sendContextUpdate === 'function') {
				this.#transport.sendContextUpdate(message);
			} else {
				this.#transport.sendText(message);
			}
			return true;
		} catch (e) {
			console.warn('[Agent] Failed to deliver surface sync:', e);
			return false;
		}
	}

	/**
	 * Structural snapshot = the component tree with data-model *values* removed
	 * (the static `dataModel` array / the dynamic `data` object), keyed by
	 * surface id so navigation (the id set changing) is detected too. For
	 * path-bound / `fieldName` inputs this is value-independent — typing changes
	 * only the data model, not the structure — so the common case stays on the
	 * cheap delta path. Inputs that inline their value in the tree fall back to
	 * a full re-sync per keystroke (correct, just not economical).
	 */
	#getStructuralSnapshot(watched: AgentSurface[]): string {
		return JSON.stringify(
			watched.map((s) => ({ id: s.id, structure: stripDataModel(s.getJson()) }))
		);
	}

	/** Current `{ fieldId → value }` data model per watched surface. */
	#getDataModelSnapshot(watched: AgentSurface[]): Map<string, Record<string, unknown>> {
		const map = new Map<string, Record<string, unknown>>();
		for (const s of watched) map.set(s.id, readDataModel(s));
		return map;
	}

	#serializeDataModels(dataModels: Map<string, Record<string, unknown>>): string {
		return JSON.stringify(Array.from(dataModels.entries()));
	}

	/**
	 * Changed `{ fieldId → value }` entries per surface, vs the last-delivered
	 * data model. Edits to the same field across a buffered window collapse to
	 * its final value (latest wins); edits to different fields accumulate.
	 * Cleared fields surface as `key: ""` (an empty TextField reads as ""), so
	 * they're delivered, not silently dropped.
	 */
	#computeDataModelDelta(
		current: Map<string, Record<string, unknown>>
	): Record<string, Record<string, unknown>> {
		const delta: Record<string, Record<string, unknown>> = {};
		for (const [id, model] of current) {
			const prev = this.#lastDeliveredDataModel.get(id) ?? {};
			const surfaceDelta: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(model)) {
				if (JSON.stringify(prev[key]) !== JSON.stringify(value)) surfaceDelta[key] = value;
			}
			if (Object.keys(surfaceDelta).length > 0) delta[id] = surfaceDelta;
		}
		return delta;
	}

	/** Advance the sync baselines after a successful sync-mode delivery. */
	#markSyncDelivered(
		structure: string,
		dataModels: Map<string, Record<string, unknown>>,
		ctx: string
	): void {
		this.#lastDeliveredStructure = structure;
		this.#lastDeliveredDataModel = dataModels;
		this.#lastDeliveredContext = ctx;
		this.#lastSyncObservedSnapshot = `${structure} ${this.#serializeDataModels(dataModels)} ${ctx}`;
		this.#lastSyncObservedChangeAt = Date.now();
	}

	/**
	 * Seed *every* delivery baseline (proactive + sync) to the current surface
	 * state — used at connect time (the state is already in the system prompt)
	 * and after an agent tool-call write (so the agent's own change isn't echoed
	 * back). No delivery happens.
	 */
	#markAllDelivered(): void {
		const watched = this.#watchedSurfaces();
		const ctx = this.#contextInstructions();
		// Proactive baselines.
		this.#markDelivered(this.#getSurfaceSnapshot(), ctx, this.#getSurfaceIds());
		// Sync baselines.
		this.#markSyncDelivered(
			this.#getStructuralSnapshot(watched),
			this.#getDataModelSnapshot(watched),
			ctx
		);
	}

	// ===== Proactive mode =====

	/** Mark a surface state as already known to the model (no delivery). */
	#markDelivered(snapshot: string, context: string, ids: string): void {
		this.#lastDeliveredSnapshot = snapshot;
		this.#lastDeliveredContext = context;
		this.#lastDeliveredIds = ids;
		// Keep the settle baseline aligned so the next proactive tick doesn't
		// treat this as a fresh, just-changed value.
		this.#lastObservedSnapshot = snapshot;
		this.#lastObservedContext = context;
		this.#lastObservedChangeAt = Date.now();
	}

	/**
	 * Emit a `SURFACE_UPDATED` payload and record it as delivered. When
	 * `silent`, route through the transport's `sendContextUpdate` channel
	 * (`turnComplete: false` — appends to context without triggering a turn);
	 * otherwise send a normal text turn the agent may react to. Transports
	 * without a silent channel fall back to a text turn.
	 */
	#deliverSurfaceUpdate(surfacesJson: string, context: string, ids: string, silent: boolean): void {
		const payload = wrapExtension(A2UI_EXTENSION_NAMESPACE, {
			kind: 'surfaceUpdated',
			updatedSurfaces: JSON.parse(surfacesJson),
			updatedContext: context,
			availableElementIds: actionRegistry.listActions()
		});
		const message = `<event>SURFACE_UPDATED</event>\n<payload>\n${JSON.stringify(payload, null, 2)}\n</payload>`;
		try {
			if (silent && typeof this.#transport.sendContextUpdate === 'function') {
				this.#transport.sendContextUpdate(message);
			} else {
				this.#transport.sendText(message);
			}
			this.rec('context-update', message, 'proactive-surface');
			this.#markDelivered(surfacesJson, context, ids);
		} catch (e) {
			console.warn('[Agent] Failed to deliver surface update:', e);
		}
	}
}
