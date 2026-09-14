import { processMessage } from '../core/processor';
import { toolRegistry } from '../core/registries/tool-registry';
import { actionRegistry } from '../core/registries/action-registry';
import type { AgentSurface } from '../core/registries/surface-index';
import { userActionBus, type UserAction } from '../core/registries/event-bus';
import { A2UI_EXTENSION_NAMESPACE, wrapExtension, getExtensions } from '../core/extensions';
import {
	stripDataModel,
	readDataModelFromJson,
	structuralFingerprint,
	readDataModelsBySurface,
	diffDataModelsBySurface
} from '../core/surface-snapshot';
import type {
	AgentModel,
	AgentModelConnectOptions,
	AgentModelCapabilities
} from './model';
import { buildSystemPrompt, type PromptInputs } from './prompt-builder';
import { AgentDebugStats, type DebugOutboundKind } from './debug.svelte';
import { AudioRecorder } from './audio-recorder';
import { AudioPlayer } from './audio-player';

export type AgentMode = 'static' | 'dynamic' | 'both';
export type AgentStatus = 'idle' | 'thinking' | 'error';

/**
 * Agent-level events — the session's own signals, deliberately narrower than
 * {@link AgentModelEventMap}: a host subscribes to turn boundaries and
 * failures without coupling to the model's event stream.
 */
export interface AgentEventMap {
	/**
	 * The model finished a turn. A turn that called tools completes only after
	 * the model has seen the results and produced its continuation (the
	 * models normalise this — see `AgentModelEventMap['turn-complete']`).
	 */
	'turn-complete': Record<string, never>;
	/** The session failed: a model error, or a close nobody asked for. */
	'error': { message: string; cause?: unknown };
}

/** Default deadline for {@link Agent.send}; override per call with `timeoutMs`. */
const DEFAULT_TURN_TIMEOUT_MS = 60_000;

/** One turn awaited by {@link Agent.send}. */
interface PendingTurn {
	resolve: () => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout> | null;
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
	return readDataModelFromJson(surface.getJson());
}

// The surface handle now lives in core, beside the index that tracks mounted
// surfaces; re-exported here because it is part of the agent's contract.
export type { AgentSurface };

/**
 * How surface changes that the user makes (typing into a field, navigating,
 * editing through the HTML UI) are delivered to the agent. Both modes only
 * apply when the app-wide `surfaceWatch` extension is on.
 *
 * - `'sync'` (default): the agent stays **silently aware** via A2UI v0.9
 *   data-model synchronization. The unit of state is the surface's
 *   `{ fieldId → value }` data model — the static component structure is
 *   already in the system prompt and does not change when the user types.
 *   Only **changed entries** are pushed (a tiny delta, not the 21 KB tree),
 *   and only in **idle windows** (a debounced settle tick, `turn-complete`,
 *   or right before a typed message / button action) — **never while an
 *   interruptible model is generating**, so it can't barge-in-interrupt the
 *   answer. Edits made while the agent is speaking are buffered and coalesced
 *   (latest value per field wins), then flushed in the next idle slot. Structural changes (navigation, a component
 *   appearing/disappearing) fall back to a full surface re-sync, because a
 *   value delta can't convey new structure. Delivery uses the model's
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
 *   unprompted. Requires a model that can initiate a turn
 *   (`capabilities.canInitiateTurn`); on models that can't, it falls back
 *   to `'sync'`. Kept as an opt-in for hosts who prefer a chattier agent.
 */
export type SurfaceWatchMode = 'sync' | 'piggyback' | 'proactive';

/**
 * Non-extension tuning for the surface-watch loop. These are cadence/behaviour
 * knobs — not extensions — so they live on the agent rather than in
 * `Extensions`. Whether watching runs at all is the app-wide
 * `surfaceWatch` extension.
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
	 * poll timer runs on streaming models; a non-streaming (request/
	 * response) model relies on the pre-turn flush instead.
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
 * {@link AgentModel}: `new Agent(definition, model)`. Swapping the
 * model (voice live-API ↔ request/response text) changes nothing else.
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
	 * runs is the app-wide `surfaceWatch` extension; these knobs only
	 * control timing.
	 */
	surfaceWatchTuning?: SurfaceWatchTuning;
	/**
	 * Serialize surface JSON compactly (single line) wherever it is fed to the
	 * model — the system prompt's surface blocks and the `SURFACE_UPDATED`
	 * sync payloads. Pretty-printing a dense surface roughly doubles its
	 * character count in pure indentation, and on a live session that cost is
	 * re-billed every turn. Semantically identical JSON either way. Default
	 * `false` (pretty) for backwards compatibility; ignored when a custom
	 * `buildPrompt` chooses its own formatting.
	 */
	compactSurfaceJson?: boolean;
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
 * {@link AgentModel}. Owns prompt assembly (via prompt-builder), tool
 * dispatch, the surface-watch engine (sync / proactive), `userActionBus`
 * subscription, transcript + status + debug state, and the thinking-watchdog.
 *
 * One class drives every channel. It adapts to the model's
 * {@link AgentModelCapabilities} — never to its identity: the barge-in gates
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
	/** True while the mic recorder is capturing (audio-input models only). */
	recording = $state(false);
	/**
	 * Mic muted while the session stays open. When `true`, captured audio chunks
	 * are dropped instead of sent to the model — the live connection,
	 * playback, and surface-sync all keep running. Lets the user silence a noisy
	 * environment so trailing background noise isn't heard as a barge-in that
	 * cuts the agent off mid-answer. Meaningful only on audio-input models;
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
	#model: AgentModel;
	#debugEnabled: boolean;
	#mode: AgentMode;
	#surfaceWatchTuning: Required<SurfaceWatchTuning>;
	#unsubs: Array<() => void> = [];
	// Host subscriptions to the agent's own events (`on()`). They belong to the
	// agent, not to a session, so they survive `stop()` / `start()`.
	#listeners: { [E in keyof AgentEventMap]?: Set<(p: AgentEventMap[E]) => void> } = {};
	// Turns awaited by `send()`, oldest first: each `turn-complete` settles the
	// head, so sequential sends resolve in order.
	#pendingTurns: PendingTurn[] = [];
	#surfaceInterval: ReturnType<typeof setInterval> | null = null;
	#lastAgentMutationAt = 0;
	// Audio I/O — created in `start()` only when the model's capabilities
	// include the matching modality; null on text-only models.
	#recorder: AudioRecorder | null = null;
	#player: AudioPlayer | null = null;
	// True while the model is producing a turn (audio / transcript out), false
	// once it goes idle (turn-complete / interrupted). On an interruptible
	// model `'sync'` delivery is gated off while this is true so a
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
	// ── Tool-result echo baseline ──
	// What THIS model last saw, seeded from the system prompt at connect and
	// advanced after every echo it is sent. One per agent, because the echo is
	// page-wide: a click in surface A and a click in surface B diff against the
	// same snapshot, so neither re-reports a change the model already has.
	#echoBaseline: {
		structure: string;
		dataModels: Record<string, Record<string, unknown>>;
		context: string;
		elementIds: string;
	} | null = null;
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

	constructor(definition: AgentDefinition, model: AgentModel) {
		this.#def = definition;
		this.#model = model;
		this.debug =
			definition.debug instanceof AgentDebugStats ? definition.debug : new AgentDebugStats();
		this.#debugEnabled = definition.debug !== false;
		this.#mode = definition.mode ?? 'static';
		// `'piggyback'` is a deprecated alias for `'sync'` — normalise it so the
		// rest of the class only ever sees `'sync'` / `'proactive'`.
		const rawMode = definition.surfaceWatchTuning?.mode ?? 'sync';
		let mode: SurfaceWatchMode = rawMode === 'piggyback' ? 'sync' : rawMode;
		// `'proactive'` needs a model that can start its own turn; fall back
		// to silent `'sync'` when the model can't (e.g. request/response text).
		if (mode === 'proactive' && !model.capabilities.canInitiateTurn) {
			console.warn(
				"[Agent] 'proactive' surface-watch needs a model that can initiate turns; falling back to 'sync'."
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

	/** The model driving this agent. */
	get model(): AgentModel {
		return this.#model;
	}

	/**
	 * What the model can do — the gate for all channel-specific behaviour,
	 * inside the agent and out (e.g. `<AgentShell>` shows the mic exactly when
	 * `capabilities.input` includes `'audio'`).
	 */
	get capabilities(): AgentModelCapabilities {
		return this.#model.capabilities;
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
		// The prompt IS what the model has seen — seed the echo baseline from it,
		// so the first tool result reports only what the call itself changed.
		this.#captureEchoBaseline();

		// Snapshot the connect-time payload sizes. The system prompt embeds the
		// full serialized surface (pretty-printed), so this is usually the
		// single largest item in the session's token budget.
		if (this.#debugEnabled) {
			this.debug.toolCount = tools.length;
			this.rec('system-prompt', systemInstruction);
			this.rec('tools', tools);
		}

		// Client-history models (text) seed prior turns through connect
		// options; server-history models (voice) embed them in the prompt
		// instead (see `#buildPrompt`), so this stays absent there. Auth is the
		// model's own concern (its constructor), so no token passes through here.
		const connectOptions: AgentModelConnectOptions = {
			systemInstruction,
			tools,
			...(this.capabilities.historyOwnership === 'client'
				? { history: this.transcript }
				: {})
		};

		try {
			await this.#model.connect(connectOptions);
		} catch (e) {
			console.error('[Agent] Failed to connect model:', e);
			this.configIssue = (e as Error).message ?? 'Failed to connect';
			this.setStatus('error');
			return;
		}

		this.#wireCommonModelEvents();
		this.#unsubs.push(userActionBus.subscribe((a) => this.#handleUserAction(a)));

		// Spin up the mic/speaker exactly when the model's capabilities say
		// so — never from its identity. No-op on text-only models.
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
			this.#model.close();
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
		this.#failPendingTurns('[Agent] session stopped before the turn completed');
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

	/**
	 * @deprecated Use {@link send} and handle the failure. This is the old
	 * fire-and-forget form: it can only report a failed turn to the console,
	 * which is why it is going away.
	 */
	sendTextMessage(text: string): void {
		void this.send(text).catch((e) => console.error('[Agent] Turn failed:', e));
	}

	/**
	 * Send a typed turn and resolve when the model's turn ends. Rejects when the
	 * turn can never complete: nothing to send, not connected, the model
	 * errored or closed, the session was stopped, or `timeoutMs` elapsed
	 * (default {@link DEFAULT_TURN_TIMEOUT_MS} — pass your own for a channel
	 * that runs longer, e.g. a live voice turn under evaluation).
	 *
	 * Resolution is event-driven (the model's `turn-complete`), never
	 * polled. The model contract carries no turn id, so a boundary produced
	 * by another turn in flight — a forwarded `userAction`, a proactive push —
	 * settles the oldest pending send.
	 */
	send(text: string, opts: { timeoutMs?: number } = {}): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return Promise.reject(new Error('[Agent] send(): message is empty'));
		if (!this.connected) {
			console.warn('[Agent] Cannot send text message: not connected');
			return Promise.reject(new Error('[Agent] send(): not connected — call start() first'));
		}
		const timeoutMs = opts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
		return new Promise<void>((resolve, reject) => {
			const pending: PendingTurn = { resolve, reject, timer: null };
			pending.timer = setTimeout(() => {
				pending.timer = null;
				this.#dropPendingTurn(pending);
				reject(new Error(`[Agent] send(): no turn-complete within ${timeoutMs}ms`));
			}, timeoutMs);
			this.#pendingTurns.push(pending);
			try {
				this.#dispatchText(trimmed);
			} catch (e) {
				this.#dropPendingTurn(pending);
				if (pending.timer) clearTimeout(pending.timer);
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}

	/**
	 * Subscribe to an agent event ({@link AgentEventMap}); returns the
	 * unsubscribe function.
	 */
	on<E extends keyof AgentEventMap>(
		event: E,
		handler: (payload: AgentEventMap[E]) => void
	): () => void {
		let set = this.#listeners[event] as Set<(p: AgentEventMap[E]) => void> | undefined;
		if (!set) {
			set = new Set();
			(this.#listeners[event] as unknown) = set;
		}
		set.add(handler);
		return () => void set!.delete(handler);
	}

	#emit<E extends keyof AgentEventMap>(event: E, payload: AgentEventMap[E]): void {
		const set = this.#listeners[event] as Set<(p: AgentEventMap[E]) => void> | undefined;
		if (!set) return;
		// Snapshot: a handler may unsubscribe itself (or another) while we emit.
		for (const h of [...set]) {
			try {
				h(payload);
			} catch (e) {
				console.error(`[Agent] listener for "${event}" threw:`, e);
			}
		}
	}

	/** The one path that puts a typed turn on the wire. Assumes `connected`. */
	#dispatchText(trimmed: string): void {
		if (this.status !== 'error') this.setStatus('thinking');
		this.transcript = [...this.transcript, { role: 'user', text: trimmed }];
		this.canAppendToUser = false;
		// Sync the current data model onto this typed turn (silently, via the
		// context channel) so the model sees the latest UI before it reads the
		// user's message. A typed message is an idle moment, so this flushes
		// immediately. Ordered before the text turn below.
		if (this.#surfaceWatchTuning.mode === 'sync') this.#syncDataModel();
		this.#model.sendText(trimmed);
		this.rec('text', trimmed);
	}

	/** Resolve the oldest turn awaited by `send()`, if any. */
	#settlePendingTurn(): void {
		const pending = this.#pendingTurns.shift();
		if (!pending) return;
		if (pending.timer) clearTimeout(pending.timer);
		pending.resolve();
	}

	#dropPendingTurn(pending: PendingTurn): void {
		const i = this.#pendingTurns.indexOf(pending);
		if (i >= 0) this.#pendingTurns.splice(i, 1);
	}

	/** Fail every awaited turn — the session can no longer complete them. */
	#failPendingTurns(reason: string, cause?: unknown): void {
		if (this.#pendingTurns.length === 0) return;
		const pending = this.#pendingTurns;
		this.#pendingTurns = [];
		for (const p of pending) {
			if (p.timer) clearTimeout(p.timer);
			p.reject(new Error(reason, { cause }));
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
	 * on models without audio input (no recorder runs there).
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
	 * Serialize an event payload for an XML-tagged model message, honouring
	 * `compactSurfaceJson` (these payloads can embed whole surface trees).
	 */
	#stringifyPayload(payload: unknown): string {
		return JSON.stringify(payload, null, this.#def.compactSurfaceJson ? undefined : 2);
	}

	/**
	 * Capability-gated audio I/O: a speaker player when the model produces
	 * audio, a mic recorder when it accepts audio. Throws if the mic is
	 * unavailable (surfaced as `configIssue` by `start()`).
	 */
	async #startAudio(): Promise<void> {
		if (this.capabilities.output.includes('audio')) {
			this.#player = new AudioPlayer(24000);
		}
		if (!this.capabilities.input.includes('audio')) return;
		if (typeof this.#model.sendAudioChunk !== 'function') {
			console.warn(
				'[Agent] Model advertises audio input but implements no sendAudioChunk — mic disabled.'
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
			// chunks just never reach the model.
			if (this.connected && !this.muted) {
				this.#model.sendAudioChunk!(detail);
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
	 * Wire the model event stream. Every model emits the text/tool
	 * events; `audio-out` / `interrupted` only ever fire from models whose
	 * capabilities include them, so wiring is unconditional and the handlers
	 * are inert elsewhere.
	 */
	#wireCommonModelEvents(): void {
		this.#unsubs.push(
			this.#model.on('tool-call', (p) => {
				void this.#handleToolCall(p.calls);
			}),
			this.#model.on('text-out', (p) => this.#onTextOut(p.text)),
			this.#model.on('text-in', (p) => this.#onTextIn(p.text)),
			this.#model.on('turn-complete', () => this.#onTurnComplete()),
			this.#model.on('audio-out', (p) => {
				// Model is producing a turn — gate sync delivery so we never
				// interrupt the answer in flight.
				this.modelTurnActive = true;
				if (this.#debugEnabled) this.debug.recordInboundAudio(p.base64Pcm24k);
				this.#player?.addToQueue(p.base64Pcm24k);
				this.onModelActivity();
				this.canAppendToUser = false;
			}),
			this.#model.on('interrupted', () => {
				// Generation was cut off (barge-in) — the model is idle again.
				this.modelTurnActive = false;
				this.#player?.stop();
				if (this.status !== 'error') this.setStatus('thinking');
			}),
			this.#model.on('notice', (p) => {
				// Non-fatal model signal (e.g. a rate-limit retry) — log it for
				// the debug box; it does not change session status.
				if (this.#debugEnabled) this.debug.recordNotice(p.message);
			}),
			this.#model.on('error', (p) => {
				console.error('[Agent] Model error:', p.message, p.cause);
				if (!this.#intentionalDisconnect) this.setStatus('error');
				// Before `stop()`, so an awaited turn rejects with the real cause
				// rather than the generic teardown message.
				this.#failPendingTurns(`[Agent] model error: ${p.message}`, p.cause);
				this.#emit('error', { message: p.message, cause: p.cause });
				void this.stop();
			}),
			this.#model.on('close', (p) => {
				console.log('[Agent] Model closed:', p.reason);
				if (!this.#intentionalDisconnect) this.setStatus('error');
				// A close always ends any turn in flight; it is only an *error* when
				// we didn't ask for it (`stop()` / `toggle()` / `reset()` did).
				this.#failPendingTurns(
					`[Agent] model closed before the turn completed${p.reason ? `: ${p.reason}` : ''}`
				);
				if (!this.#intentionalDisconnect) {
					this.#emit('error', { message: `Model closed: ${p.reason ?? '(no reason)'}` });
				}
				void this.stop();
			}),
			this.#model.on('usage', (u) => {
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
		this.modelTurnActive = false;
		if (this.#surfaceWatchTuning.mode === 'sync') this.#syncDataModel();
		this.#emit('turn-complete', {});
		this.#settlePendingTurn();
	}

	#assembleToolDeclarations(): Array<{
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	}> {
		// With `batchTools` on the batched pair REPLACES the singular pair in the
		// prompt (never in the registry — `toolRegistry.execute('click_button')`
		// stays the entry point for an external spec-compliant agent). Declaring
		// both costs prompt tokens twice and makes the model loop item-by-item,
		// while a batch of one is exactly a single call.
		const superseded = getExtensions().batchTools
			? new Set(['click_button', 'update_text_field'])
			: new Set<string>();
		const declarations = toolRegistry
			.getDeclarations()
			.filter((d) => !superseded.has(d.name));

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
			compactSurfaceJson: this.#def.compactSurfaceJson,
			// Server-history models (voice) embed the recent transcript in the
			// prompt for reconnect continuity; client-history models (text)
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
					// `processMessage` reports what it did: a tree that fails
					// validation is rejected, and the model gets the issues back
					// instead of a success it can't learn from.
					result = processMessage({ [call.name]: call.args } as never);
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
			result = this.#withSurfaceEcho(call.name, result);
			try {
				// Tool results are a top quota cost: with the surface-echo
				// extension the result echoes the FULL serialized surface back to
				// the model on every call. Size it so that's visible.
				this.rec('tool-result', result, call.name);
				this.#model.sendToolResult(call.id, call.name, result);
			} catch (e) {
				console.error('[Agent] Failed to send tool result:', e);
				this.setStatus('error');
			}
		}
	}

	/**
	 * Read every surface the definition declares, as serialized JSON — the same
	 * set `#buildPrompt` shows the model, so the echo and the prompt can never
	 * disagree about what is on screen.
	 */
	#surfaceJson(): unknown[] {
		return this.#def
			.surfaces()
			.filter((s) => s)
			.map((s) => s.getJson());
	}

	/** Record the current page state as "what this model has seen". */
	#captureEchoBaseline(): void {
		const surfaces = this.#surfaceJson();
		this.#echoBaseline = {
			structure: structuralFingerprint(surfaces),
			dataModels: readDataModelsBySurface(surfaces),
			context: this.#contextInstructions(),
			elementIds: JSON.stringify(actionRegistry.listActions())
		};
	}

	/**
	 * Attach the surface echo to a tool result, per the app-wide
	 * `toolResultSurfaceEcho` extension:
	 *
	 *   `'changed'` (default): only what changed vs `#echoBaseline` —
	 *                       `updatedSurface` on a structural change,
	 *                       `updatedDataModel` for value changes,
	 *                       context/ids only when they moved. Nothing changed ⇒
	 *                       the result is returned untouched.
	 *   `'full'`:           the whole serialized page under
	 *                       `extensions['a2ui-svelte']`, so a 3P consumer that
	 *                       doesn't know the namespace drops the blob and still
	 *                       sees a clean `results` array.
	 *   `'none'` (STRICT):  untouched.
	 *
	 * Only tools that declare `mutatesSurface` get one: a purely visual gesture
	 * (`point_to_elements`) leaves the model's understanding unchanged, and
	 * echoing the tree back on it is the exact token amplifier we avoid.
	 */
	#withSurfaceEcho(name: string, result: unknown): unknown {
		const mode = getExtensions().toolResultSurfaceEcho;
		if (mode === 'none') return result;
		if (!toolRegistry.get(name)?.mutatesSurface) return result;

		const surfaces = this.#surfaceJson();
		const context = this.#contextInstructions();
		const actions = actionRegistry.listActions();

		let extras: Record<string, unknown>;
		if (mode === 'changed') {
			const structure = structuralFingerprint(surfaces);
			const dataModels = readDataModelsBySurface(surfaces);
			const elementIds = JSON.stringify(actions);
			const prev = this.#echoBaseline;
			extras = {};
			if (!prev || structure !== prev.structure) {
				// A value delta can't convey a component appearing/disappearing,
				// so echo the full tree — the data-model values ride inside it.
				extras.updatedSurface = surfaces;
			} else {
				const delta = diffDataModelsBySurface(prev.dataModels, dataModels);
				// The model already knows the value it just wrote — but a click may
				// have mutated OTHER fields too (a form reset). Report every change;
				// the agent's own writes are a few bytes and double as confirmation.
				if (Object.keys(delta).length > 0) extras.updatedDataModel = delta;
			}
			if (!prev || context !== prev.context) extras.updatedContext = context;
			if (!prev || elementIds !== prev.elementIds) extras.availableElementIds = actions;
			this.#echoBaseline = { structure, dataModels, context, elementIds };
			if (Object.keys(extras).length === 0) return result;
		} else {
			extras = {
				availableElementIds: actions,
				updatedSurface: surfaces,
				updatedContext: context
			};
		}

		const carrier = (result ?? {}) as Record<string, unknown>;
		const existing = (carrier.extensions ?? {}) as Record<string, unknown>;
		return {
			...carrier,
			extensions: {
				...existing,
				[A2UI_EXTENSION_NAMESPACE]: {
					...((existing[A2UI_EXTENSION_NAMESPACE] as Record<string, unknown>) ?? {}),
					...extras
				}
			}
		};
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

		// Prefer the model's typed `sendUserAction` when implemented
		// (spec-aligned models, see B7). Fall back to the legacy
		// XML-tagged-text wrapping otherwise — that's the only way to push the
		// event through voice live-APIs that lack a native event channel.
		try {
			if (typeof this.#model.sendUserAction === 'function') {
				this.#model.sendUserAction(canonical);
				this.rec('user-action', canonical, canonical.name);
				return;
			}
			const payload = { userAction: canonical };
			const message = `<event>USER_ACTION</event>\n<payload>\n${this.#stringifyPayload(payload)}\n</payload>`;
			this.#model.sendText(message);
			this.rec('user-action', message, canonical.name);
		} catch (e) {
			console.warn('[Agent] Failed to forward userAction:', e);
		}
	}

	/**
	 * The surfaces the watch loop delivers changes for — every mounted surface
	 * when the app-wide `surfaceWatch` extension is on, none under STRICT.
	 *
	 * Both static and dynamic surfaces are watched: a dynamic surface's
	 * serialized JSON includes its data model, so polling lets the agent
	 * notice user input written into a path-bound field (e.g. a TextField
	 * the agent rendered, then the user typed into). To exclude one surface,
	 * leave it out of `definition.surfaces()`.
	 */
	#watchedSurfaces(): AgentSurface[] {
		if (!getExtensions().surfaceWatch) return [];
		return this.#def.surfaces().filter((s) => s);
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

		// Only a streaming model has idle windows to poll. A non-streaming
		// (request/response) model has no live session to push into between
		// turns — it relies on the pre-turn flush (`#syncDataModel()` from
		// `send()` / `#handleUserAction()`), which already gives the
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
	 * interruptible model — never while the model is busy. Structural
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
	 * model there's nothing to barge into, so the busy gate is skipped.
	 */
	#syncTick(): void {
		if (!this.connected) return;
		// Barge-in only exists on an interruptible (streaming voice) session; for
		// non-interruptible models an idle-window delivery can't interrupt
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
	 * message, or before a button action). On an interruptible model it's
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
		const message = `<event>SURFACE_UPDATED</event>\n<payload>\n${this.#stringifyPayload(payload)}\n</payload>`;
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
		const message = `<event>SURFACE_UPDATED</event>\n<payload>\n${this.#stringifyPayload(payload)}\n</payload>`;
		if (this.#sendSilently(message)) {
			// The cheap path: only the changed fields, not the tree.
			this.rec('context-update', message, 'data-model-delta');
			this.#markSyncDelivered(structure, dataModels, ctx);
		}
	}

	/**
	 * Deliver a message through the silent context channel
	 * (`sendContextUpdate`, `turnComplete: false`). Models without a silent
	 * channel fall back to `sendText` (which may provoke a turn — acceptable
	 * degradation). Returns whether the send succeeded.
	 */
	#sendSilently(message: string): boolean {
		try {
			if (typeof this.#model.sendContextUpdate === 'function') {
				this.#model.sendContextUpdate(message);
			} else {
				this.#model.sendText(message);
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
	 * `silent`, route through the model's `sendContextUpdate` channel
	 * (`turnComplete: false` — appends to context without triggering a turn);
	 * otherwise send a normal text turn the agent may react to. Models
	 * without a silent channel fall back to a text turn.
	 */
	#deliverSurfaceUpdate(surfacesJson: string, context: string, ids: string, silent: boolean): void {
		const payload = wrapExtension(A2UI_EXTENSION_NAMESPACE, {
			kind: 'surfaceUpdated',
			updatedSurfaces: JSON.parse(surfacesJson),
			updatedContext: context,
			availableElementIds: actionRegistry.listActions()
		});
		const message = `<event>SURFACE_UPDATED</event>\n<payload>\n${this.#stringifyPayload(payload)}\n</payload>`;
		try {
			if (silent && typeof this.#model.sendContextUpdate === 'function') {
				this.#model.sendContextUpdate(message);
			} else {
				this.#model.sendText(message);
			}
			this.rec('context-update', message, 'proactive-surface');
			this.#markDelivered(surfacesJson, context, ids);
		} catch (e) {
			console.warn('[Agent] Failed to deliver surface update:', e);
		}
	}
}
