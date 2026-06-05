import { processMessage } from '../core/processor';
import { toolRegistry } from '../core/registries/tool-registry';
import { actionRegistry } from '../core/registries/action-registry';
import { userActionBus, type UserAction } from '../core/registries/event-bus';
import {
	A2UI_EXTENSION_NAMESPACE,
	wrapExtension,
	type ExtensionOptions
} from '../core/extensions';
import type { VoiceTransport } from './transport';
import { AudioRecorder } from './audio-recorder';
import { AudioPlayer } from './audio-player';
import { buildSystemPrompt, type PromptInputs } from './prompt-builder';
import { VoiceDebugStats, type DebugOutboundKind } from './debug.svelte';

export type VoiceMode = 'static' | 'dynamic' | 'both';
export type VoiceStatus = 'idle' | 'thinking' | 'error';

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
function readDataModel(surface: VoiceAgentSurface): Record<string, unknown> {
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

export interface VoiceAgentSurface {
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
 *   model is generating**, so it can't barge-in-interrupt the answer. Edits
 *   made while the agent is speaking are buffered and coalesced (latest value
 *   per field wins), then flushed in the next idle slot. Structural changes
 *   (navigation, a component appearing/disappearing) fall back to a full
 *   surface re-sync, because a value delta can't convey new structure.
 *   Delivery rides the transport's `sendContextUpdate` channel
 *   (`turnComplete: false`), which appends to context without provoking a
 *   response. So when the user asks "what's in the text box?", the model
 *   already sees what they typed, but it never reacts to the typing on its
 *   own.
 *
 * - `'piggyback'`: **deprecated alias for `'sync'`.** The old implementation
 *   flushed the full tree on the user's first input-transcription chunk,
 *   which on Gemini Live arrives at turn-close and interrupted the answer.
 *   `'sync'` supersedes it; the name is kept so existing configs keep working.
 *
 * - `'proactive'`: the historical reactive behaviour. A timer diffs the
 *   surface and pushes a `<event>SURFACE_UPDATED</event>` text turn (the full
 *   tree) as soon as a change settles, so the agent can react to UI changes
 *   unprompted. Kept as an opt-in for hosts who prefer a chattier agent.
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
	 * idle). Default 500 in `'sync'` mode, 3000 in `'proactive'` mode.
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

export interface VoiceAgentOptions {
	/** Provider-specific voice transport. */
	transport: VoiceTransport;
	/** Live source of currently-active surfaces. Called on every interval tick. */
	surfaces: () => VoiceAgentSurface[];
	/** Live source of page-specific context instructions. */
	contextInstructions: () => string;
	/** Base system prompt (the persona + style). */
	systemInstruction: string;
	/** Static / dynamic / both. Default 'static'. */
	mode?: VoiceMode;
	/** Override prompt assembly entirely. */
	buildPrompt?: (inputs: PromptInputs) => string;
	/** Optional voice name passed to the transport. */
	voice?: string;
	/** Auth token mint function — called once per `start()`. */
	mintToken: () => Promise<string>;
	/**
	 * Cadence tuning for the surface-watch polling loop. Whether the loop
	 * runs is decided per-surface via `surface.extensions.surfaceWatch`;
	 * these knobs only control timing.
	 */
	surfaceWatchTuning?: SurfaceWatchTuning;
	/**
	 * Token/byte debug telemetry. The agent always exposes a `debug`
	 * (`VoiceDebugStats`) so a host can render a debug box (see
	 * `<VoiceShell debug>`); this option only tunes it:
	 *  - omit / `true`  → default instance, recording on;
	 *  - a `VoiceDebugStats` → use this instance (e.g. to share/configure
	 *    `charsPerToken`);
	 *  - `false` → recording off (the instance still exists but stays empty),
	 *    for hosts that don't want the (cheap) measurement overhead.
	 */
	debug?: boolean | VoiceDebugStats;
}

/**
 * Provider-agnostic voice agent. Owns the audio recorder + player, prompt
 * assembly (via prompt-builder), tool dispatch, surface-watch interval with
 * agent-modification cooldown, userActionBus subscription, and transcript
 * state. Does NOT own any UI — VoiceShell renders the default UI; consumers
 * can render their own bound to this class's reactive state.
 */
export class VoiceAgent {
	connected = $state(false);
	recording = $state(false);
	status = $state<VoiceStatus>('idle');
	transcript = $state<Array<{ role: 'user' | 'model'; text: string }>>([]);
	hasStarted = $state(false);
	configIssue = $state<string | null>(null);
	/**
	 * Live token/byte telemetry for the session — outbound payload sizes the
	 * agent sends (system prompt, tool results, context syncs, audio) plus the
	 * provider's authoritative usage reports. Reactive; bind a debug box to it
	 * (or pass `debug` to `<VoiceShell>`). See `VoiceDebugStats`.
	 */
	debug: VoiceDebugStats;

	#opts: VoiceAgentOptions;
	#debugEnabled: boolean;
	#mode: VoiceMode;
	#surfaceWatchTuning: Required<SurfaceWatchTuning>;
	#recorder: AudioRecorder | null = null;
	#player: AudioPlayer | null = null;
	#unsubs: Array<() => void> = [];
	#surfaceInterval: ReturnType<typeof setInterval> | null = null;
	#lastAgentMutationAt = 0;
	// True while the model is producing a turn (audio / transcript out), false
	// once it goes idle (turn-complete / interrupted). `'sync'` delivery is
	// gated off while this is true so a `sendContextUpdate` can never
	// barge-in-interrupt an in-progress answer. Skipped deliveries are not
	// lost: the next idle tick (or turn-complete) re-attempts and the
	// diff-vs-last-delivered design coalesces everything that changed.
	#modelTurnActive = false;
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
	#canAppendToUser = false;
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

	constructor(opts: VoiceAgentOptions) {
		this.#opts = opts;
		this.debug = opts.debug instanceof VoiceDebugStats ? opts.debug : new VoiceDebugStats();
		this.#debugEnabled = opts.debug !== false;
		this.#mode = opts.mode ?? 'static';
		// `'piggyback'` is a deprecated alias for `'sync'` — normalise it so the
		// rest of the class only ever sees `'sync'` / `'proactive'`.
		const rawMode = opts.surfaceWatchTuning?.mode ?? 'sync';
		const mode: SurfaceWatchMode = rawMode === 'piggyback' ? 'sync' : rawMode;
		const isSync = mode === 'sync';
		this.#surfaceWatchTuning = {
			mode,
			intervalMs: opts.surfaceWatchTuning?.intervalMs ?? (isSync ? 500 : 3000),
			settleMs: opts.surfaceWatchTuning?.settleMs ?? (isSync ? 400 : 3000),
			cooldownMs: opts.surfaceWatchTuning?.cooldownMs ?? 5000
		};
	}

	async start(): Promise<void> {
		this.#setStatus('idle');
		this.configIssue = null;
		this.#intentionalDisconnect = false;
		// Fresh session ⇒ fresh telemetry.
		if (this.#debugEnabled) this.debug.reset();

		let token: string;
		try {
			token = await this.#opts.mintToken();
		} catch (e) {
			this.configIssue = (e as Error).message ?? 'Failed to mint token';
			this.#setStatus('error');
			return;
		}

		const tools = this.#assembleToolDeclarations();
		const systemInstruction = this.#buildPrompt(tools);

		// Snapshot the connect-time payload sizes. The system prompt embeds the
		// full serialized surface (pretty-printed), so this is usually the
		// single largest item in the session's token budget.
		if (this.#debugEnabled) {
			this.debug.toolCount = tools.length;
			this.#rec('system-prompt', systemInstruction);
			this.#rec('tools', tools);
		}

		try {
			await this.#opts.transport.connect({
				token,
				systemInstruction,
				tools,
				voice: this.#opts.voice
			});
		} catch (e) {
			console.error('[VoiceAgent] Failed to connect transport:', e);
			this.#setStatus('error');
			return;
		}

		this.#unsubs.push(
			this.#opts.transport.on('tool-call', (p) => {
				void this.#handleToolCall(p.calls);
			}),
			this.#opts.transport.on('audio-out', (p) => {
				// Model is producing a turn — gate sync delivery so we never
				// interrupt the answer in flight.
				this.#modelTurnActive = true;
				if (this.#debugEnabled) this.debug.recordInboundAudio(p.base64Pcm24k);
				this.#player?.addToQueue(p.base64Pcm24k);
				this.#onModelActivity();
				this.#canAppendToUser = false;
			}),
			this.#opts.transport.on('transcript-out', (p) => this.#onTranscriptOut(p.text)),
			this.#opts.transport.on('transcript-in', (p) => this.#onTranscriptIn(p.text)),
			this.#opts.transport.on('interrupted', () => {
				// Generation was cut off — the model is idle again.
				this.#modelTurnActive = false;
				this.#player?.stop();
				if (this.status !== 'error') this.#setStatus('thinking');
			}),
			this.#opts.transport.on('turn-complete', () => this.#onTurnComplete()),
			this.#opts.transport.on('error', (p) => {
				console.error('[VoiceAgent] Transport error:', p.message, p.cause);
				if (!this.#intentionalDisconnect) this.#setStatus('error');
				void this.stop();
			}),
			this.#opts.transport.on('close', (p) => {
				console.log('[VoiceAgent] Transport closed:', p.reason);
				if (!this.#intentionalDisconnect) this.#setStatus('error');
				void this.stop();
			}),
			this.#opts.transport.on('usage', (u) => {
				// Authoritative provider token counts — the real number the quota
				// is measured against.
				if (this.#debugEnabled) this.debug.recordUsage(u);
			})
		);

		this.#unsubs.push(userActionBus.subscribe((a) => this.#handleUserAction(a)));

		try {
			this.#recorder = new AudioRecorder();
			this.#player = new AudioPlayer(24000);
			this.#recorder.addEventListener('data', (e) => {
				const detail = (e as CustomEvent<string>).detail;
				if (this.connected) {
					this.#opts.transport.sendAudioChunk(detail);
					this.#rec('audio-out', detail);
				}
			});
			await this.#recorder.start();
		} catch (e) {
			console.error('[VoiceAgent] Failed to start recorder:', e);
			this.configIssue = (e as Error).message ?? 'Microphone unavailable';
			this.#setStatus('error');
			void this.stop();
			return;
		}

		this.connected = true;
		this.hasStarted = true;
		this.recording = true;
		this.#canAppendToUser = false;
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
			this.#opts.transport.close();
		} catch {
			// best-effort
		}

		this.#recorder?.stop();
		this.#player?.stop();

		if (this.#currentModelText.trim()) {
			this.transcript = [
				...this.transcript,
				{ role: 'model', text: this.#currentModelText.trim() }
			];
			this.#currentModelText = '';
		}

		this.#recorder = null;
		this.#player = null;
		this.recording = false;
		this.connected = false;
		this.#canAppendToUser = false;
		this.#modelTurnActive = false;
	}

	async toggle(): Promise<void> {
		if (this.connected) {
			this.#intentionalDisconnect = true;
			this.#setStatus('idle');
			await this.stop();
		} else {
			await this.start();
		}
	}

	sendTextMessage(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (this.status !== 'error') this.#setStatus('thinking');
		this.transcript = [...this.transcript, { role: 'user', text: trimmed }];
		this.#canAppendToUser = false;
		if (this.connected) {
			// Sync the current data model onto this typed turn (silently, via the
			// context channel) so the model sees the latest UI before it reads the
			// user's message. A typed message is an idle moment, so this flushes
			// immediately. Ordered before the text turn below.
			if (this.#surfaceWatchTuning.mode === 'sync') this.#syncDataModel();
			this.#opts.transport.sendText(trimmed);
			this.#rec('text', trimmed);
		} else {
			console.warn('[VoiceAgent] Cannot send text message: not connected');
		}
	}

	async reset(): Promise<void> {
		if (this.connected) {
			this.#intentionalDisconnect = true;
			await this.stop();
		}
		this.#setStatus('idle');
		this.transcript = [];
		this.#currentModelText = '';
		this.#canAppendToUser = false;
		this.hasStarted = false;
		this.configIssue = null;
		if (this.#debugEnabled) this.debug.reset();
	}

	// ===== Internals =====

	/** Record an outbound payload to `debug` (no-op when debug is disabled). */
	#rec(kind: DebugOutboundKind, payload: unknown, note?: string): void {
		if (this.#debugEnabled) this.debug.recordOutbound(kind, payload, note);
	}

	/**
	 * Single funnel for status writes so the thinking-watchdog timer stays in
	 * lock-step with the badge. `'thinking'` means "a model response is
	 * expected"; arm a watchdog so a response that never arrives can't leave
	 * the badge spinning. Any other status means we're no longer waiting, so
	 * clear it.
	 */
	#setStatus(next: VoiceStatus): void {
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
			this.#modelTurnActive = false;
			if (this.status === 'thinking') this.#setStatus('idle');
		}, this.#thinkingTimeoutMs);
	}

	#clearThinkingWatchdog(): void {
		if (this.#thinkingTimer) {
			clearTimeout(this.#thinkingTimer);
			this.#thinkingTimer = null;
		}
	}

	#onModelActivity(): void {
		if (this.status === 'thinking') this.#setStatus('idle');
	}

	#onTranscriptOut(text: string): void {
		if (!text) return;
		// Model is producing a turn — gate sync delivery (see `#modelTurnActive`).
		this.#modelTurnActive = true;
		this.#onModelActivity();
		this.#canAppendToUser = false;
		this.#currentModelText += text;
		const last = this.transcript.length - 1;
		if (last >= 0 && this.transcript[last].role === 'model') {
			this.transcript[last].text = this.#currentModelText;
		} else {
			this.transcript = [...this.transcript, { role: 'model', text: this.#currentModelText }];
		}
	}

	#onTranscriptIn(text: string): void {
		if (!text) return;
		if (this.status !== 'error') this.#setStatus('thinking');
		const last = this.transcript.length - 1;
		const isContinuation =
			this.#canAppendToUser && last >= 0 && this.transcript[last].role === 'user';
		if (isContinuation) {
			this.transcript[last].text += text;
		} else {
			// First chunk of a new spoken utterance. NOTE: on Gemini Live the
			// whole `inputTranscription` arrives in one burst at turn-close —
			// simultaneously with the model starting to generate — so flushing
			// surface state *here* barge-in-interrupts the answer. We deliberately
			// do NOT sync at speech time; sync happens in idle windows (the settle
			// tick, `turn-complete`, or before a typed message / action) so the
			// model already sees the current data model before it answers.
			this.transcript = [...this.transcript, { role: 'user', text }];
			this.#canAppendToUser = true;
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
		// A turn boundary always ends the current spoken utterance: the next
		// `inputTranscription` chunk is a fresh user turn, not a continuation.
		// Reset unconditionally — a tool-only turn (common in dynamic mode)
		// produces no model text, so gating this on `#currentModelText` left the
		// flag stuck `true` and merged every following utterance into one turn.
		this.#canAppendToUser = false;
		if (this.status === 'thinking') this.#setStatus('idle');
		// The model just went idle: clear the gate and flush any change that was
		// buffered (coalesced) during its turn, without waiting for the next poll.
		this.#modelTurnActive = false;
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
		const surfaces = this.#opts.surfaces();
		const allowStatic = this.#mode === 'static' || this.#mode === 'both';
		const allowDynamic = this.#mode === 'dynamic' || this.#mode === 'both';

		const inputs: PromptInputs = {
			systemInstruction: this.#opts.systemInstruction,
			staticSurfaces: allowStatic
				? surfaces.filter((s) => s && s.type === 'static')
				: [],
			dynamicSurfaces: allowDynamic
				? surfaces.filter((s) => s && s.type === 'dynamic')
				: [],
			toolDeclarations: tools,
			contextInstructions: this.#opts.contextInstructions(),
			transcriptHistory: this.transcript,
			includeDynamicGuide: this.#mode === 'dynamic'
		};

		return (this.#opts.buildPrompt ?? buildSystemPrompt)(inputs);
	}

	async #handleToolCall(
		calls: Array<{ id: string; name: string; args: Record<string, unknown> }>
	): Promise<void> {
		if (this.status !== 'error') this.#setStatus('thinking');
		this.#lastAgentMutationAt = Date.now();

		for (const call of calls) {
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
				this.#rec('tool-result', result, call.name);
				this.#opts.transport.sendToolResult(call.id, call.name, result);
			} catch (e) {
				console.error('[VoiceAgent] Failed to send tool result:', e);
				this.#setStatus('error');
			}
		}
	}

	#handleUserAction(action: UserAction): void {
		if (!this.connected) {
			console.warn('[VoiceAgent] Dropping userAction — no active session:', action);
			return;
		}
		if (this.status !== 'error') this.#setStatus('thinking');

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
			if (typeof this.#opts.transport.sendUserAction === 'function') {
				this.#opts.transport.sendUserAction(canonical);
				this.#rec('user-action', canonical, canonical.name);
				return;
			}
			const payload = { userAction: canonical };
			const message = `<event>USER_ACTION</event>\n<payload>\n${JSON.stringify(payload, null, 2)}\n</payload>`;
			this.#opts.transport.sendText(message);
			this.#rec('user-action', message, canonical.name);
		} catch (e) {
			console.warn('[VoiceAgent] Failed to forward userAction:', e);
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
	#watchedSurfaces(): VoiceAgentSurface[] {
		return this.#opts
			.surfaces()
			.filter((s) => s && s.extensions?.surfaceWatch !== false);
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

		// Both modes run a poll loop. In `'proactive'` mode the tick pushes a
		// turn-triggering full-tree update once a change settles; in `'sync'`
		// mode the tick delivers a silent data-model delta in the idle window
		// (gated on `#modelTurnActive`). Polling never delivers on its own — it
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
		const ctx = this.#opts.contextInstructions();
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
	 * held steady for `settleMs` (so mid-typing values coalesce), and never
	 * while the model is busy. Structural changes (navigation) bypass the
	 * settle window. Polling here is *change-detection only* — it sends nothing
	 * unless there's an undelivered, settled change.
	 *
	 * "Busy" spans the whole turn, not just audio playback: `#modelTurnActive`
	 * covers the model speaking, and `status === 'thinking'` covers the window
	 * between the user finishing and the first audio/tool-call — including a
	 * *tool-only* turn (dynamic-surface renders) that never emits audio. An
	 * autonomous `sendContextUpdate` in either window barges into the forming
	 * response (no transcript, render stalls; or the turn drops and the badge
	 * sticks on `'thinking'`). The change isn't lost — it's re-attempted at
	 * `turn-complete` (and on the next idle tick).
	 */
	#syncTick(): void {
		if (!this.connected || this.#modelTurnActive || this.status === 'thinking') return;
		const watched = this.#watchedSurfaces();
		if (watched.length === 0) return;

		const now = Date.now();
		const structure = this.#getStructuralSnapshot(watched);
		const dataModels = this.#getDataModelSnapshot(watched);
		const ctx = this.#opts.contextInstructions();
		const observed = `${structure} ${this.#serializeDataModels(dataModels)} ${ctx}`;

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
	 * message, or before a button action). Gated on `#modelTurnActive` so it
	 * never interrupts an in-progress answer; if it's gated off the change
	 * stays pending and the next idle tick / turn-complete delivers it.
	 */
	#syncDataModel(): void {
		if (!this.connected || this.#modelTurnActive) return;
		const watched = this.#watchedSurfaces();
		if (watched.length === 0) return;
		this.#deliverSync(
			watched,
			this.#getStructuralSnapshot(watched),
			this.#getDataModelSnapshot(watched),
			this.#opts.contextInstructions()
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
		watched: VoiceAgentSurface[],
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
		watched: VoiceAgentSurface[],
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
			this.#rec('context-update', message, 'full-surface');
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
			this.#rec('context-update', message, 'data-model-delta');
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
			if (typeof this.#opts.transport.sendContextUpdate === 'function') {
				this.#opts.transport.sendContextUpdate(message);
			} else {
				this.#opts.transport.sendText(message);
			}
			return true;
		} catch (e) {
			console.warn('[VoiceAgent] Failed to deliver surface sync:', e);
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
	#getStructuralSnapshot(watched: VoiceAgentSurface[]): string {
		return JSON.stringify(
			watched.map((s) => ({ id: s.id, structure: stripDataModel(s.getJson()) }))
		);
	}

	/** Current `{ fieldId → value }` data model per watched surface. */
	#getDataModelSnapshot(watched: VoiceAgentSurface[]): Map<string, Record<string, unknown>> {
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
		this.#lastSyncObservedSnapshot = `${structure} ${this.#serializeDataModels(dataModels)} ${ctx}`;
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
		const ctx = this.#opts.contextInstructions();
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
			if (silent && typeof this.#opts.transport.sendContextUpdate === 'function') {
				this.#opts.transport.sendContextUpdate(message);
			} else {
				this.#opts.transport.sendText(message);
			}
			this.#rec('context-update', message, 'proactive-surface');
			this.#markDelivered(surfacesJson, context, ids);
		} catch (e) {
			console.warn('[VoiceAgent] Failed to deliver surface update:', e);
		}
	}
}
