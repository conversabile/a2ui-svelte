import type { UserAction } from '../core/registries/event-bus';

/**
 * Static descriptor of what a transport can do. Lets the shared `Agent`
 * orchestrator adapt its behaviour to the channel (streaming voice vs.
 * request/response text) without ever branching on the transport's identity.
 *
 * The keystone of the transport-neutral design: a request/response transport
 * drives the agentic tool-loop *internally* and emits the **same events** a
 * voice transport does, while this descriptor tells the orchestrator which of
 * its voice-shaped gates (barge-in, poll loop, proactive turns, history
 * embedding) actually apply.
 */
export interface TransportCapabilities {
	/** Persistent bidi session (voice) vs request/response (text). */
	streaming: boolean;
	/** Barge-in possible. When false, the surface-sync barge-in gates are bypassed. */
	interruptible: boolean;
	/** Has a real silent-context channel (`sendContextUpdate`). */
	silentContext: boolean;
	/**
	 * `'server'` — the live session holds history (voice); the agent embeds prior
	 *            turns in the system prompt (historyBlock).
	 * `'client'` — the transport owns `messages[]`; the agent omits historyBlock
	 *            and seeds prior turns via connect opts (`history`).
	 */
	historyOwnership: 'server' | 'client';
	/**
	 * Can the transport start a model turn on its own (without a user message)?
	 * Needed by surface-watch `'proactive'` mode. Voice: true. Text: typically
	 * false unless the transport implements an autonomous kick.
	 */
	canInitiateTurn: boolean;
	/** Input modalities the transport accepts. */
	input: Array<'audio' | 'text'>;
	/** Output modalities the transport produces. */
	output: Array<'audio' | 'text'>;
}

/**
 * Provider-agnostic agent transport — the per-model adapter that presents a
 * uniform event stream to the shared `Agent`, regardless of whether the agentic
 * tool-loop runs server-side (a voice live API such as Gemini Live) or
 * client-side (a text request/response API such as Claude).
 *
 * Implementations adapt a specific SDK to the same event shape, so the
 * orchestrator works unchanged across providers and modalities.
 *
 * Lifetime: caller calls `connect()` once; the transport emits events until
 * `close()` is called or `'close'`/`'error'` fires.
 */
export interface AgentTransport {
	/** What this transport can do; read by the `Agent` to gate channel-specific behaviour. */
	readonly capabilities: TransportCapabilities;

	/**
	 * Establish the session. Resolves once it is open; rejects with a normalised
	 * Error if it cannot connect.
	 */
	connect(opts: AgentTransportConnectOptions): Promise<void>;

	/**
	 * Send a user turn. Also used for tagged events (e.g. USER_ACTION and
	 * SURFACE_UPDATED) when `sendUserAction`/`sendContextUpdate` are absent.
	 */
	sendText(text: string): void;

	/**
	 * Append text to the model's conversation context **without triggering a
	 * response**. The text becomes part of the running context and is consumed
	 * by whatever turn the user produces next.
	 *
	 * This is the channel the agent uses to *sync* surface state into context
	 * (A2UI v0.9 data-model sync): when a watched surface changes, the changed
	 * values are pushed here (silently) in an idle window, so by the time the
	 * user asks a question the model already sees the current UI — without the
	 * agent reacting on its own, and without interrupting an answer in flight.
	 *
	 * Optional: transports without a silent context channel omit it (advertise
	 * `capabilities.silentContext: false`); the agent falls back to attaching the
	 * state to the next `sendText` turn — acceptable degradation for those
	 * providers.
	 */
	sendContextUpdate?(text: string): void;

	/** Reply to a tool call. `result` must be JSON-serialisable. */
	sendToolResult(callId: string, name: string, result: unknown): void;

	/**
	 * Forward a spec-canonical `userAction` event to the agent. When omitted,
	 * the `Agent` falls back to wrapping the event in an XML-tagged text turn via
	 * `sendText` — necessary for live APIs that have no native event channel into
	 * the model context (e.g. Gemini Live), and the historical behaviour of this
	 * library.
	 *
	 * Transports that ride a spec-aligned channel (e.g. A2A `DataPart` with
	 * `mimeType: "application/json+a2ui"`) implement this natively so the payload
	 * reaches the agent as a structured `userAction` event rather than as an
	 * opaque text turn.
	 *
	 * The `action` object always conforms to the v0.8 spec:
	 * `{ name, surfaceId, sourceComponentId, timestamp, context }` — including
	 * `context: {}` when the source component declared no `action.context`.
	 */
	sendUserAction?(action: UserAction): void;

	/** Subscribe to a transport event. Returns an unsubscribe function. */
	on<E extends keyof AgentTransportEventMap>(
		event: E,
		handler: (payload: AgentTransportEventMap[E]) => void
	): () => void;

	/** Close the session. Idempotent. */
	close(): void;
}

export interface AgentTransportConnectOptions {
	/** Auth token / API key supplied by the host. */
	token: string;

	/** Full system prompt (assembled by the `Agent` + prompt-builder). */
	systemInstruction: string;

	/** Function declarations — the universal tool shape (the `Agent` assembles these from `toolRegistry`). */
	tools: Array<{
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	}>;

	/**
	 * Prior conversation turns to seed history. The agent supplies this ONLY when
	 * `capabilities.historyOwnership === 'client'` (text); voice ignores it and
	 * the agent embeds history in the prompt instead (see `historyBlock`).
	 */
	history?: Array<{ role: 'user' | 'model'; text: string }>;

	/** Provider-specific extra options. Discouraged outside the adapter. */
	providerOptions?: Record<string, unknown>;
}

export interface AgentTransportEventMap {
	/** Agent invoked one or more tools. The `Agent` dispatches them and replies via `sendToolResult`. */
	'tool-call': {
		calls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
	};

	/**
	 * Model-produced text — a streaming delta or a whole turn. For a voice
	 * transport this is the TTS transcript of the model's audio output.
	 */
	'text-out': { text: string };

	/**
	 * User-produced text — a streaming delta or a whole turn. For a voice
	 * transport this is the ASR transcript of the user's mic input.
	 */
	'text-in': { text: string };

	/** Model finished its turn — flush the transcript buffer and clear "thinking" status. */
	'turn-complete': Record<string, never>;

	/** Recoverable error from the transport. */
	'error': { message: string; cause?: unknown };

	/** Session ended (either by client or server). */
	'close': { reason?: string };

	/**
	 * Provider-reported token usage. Optional — only transports whose API returns
	 * usage metadata (e.g. Gemini Live's `usageMetadata`, Anthropic's `usage`)
	 * emit this. It is the **authoritative** token count (no estimation), so the
	 * debug tooling prefers it over byte-based estimates when present. See
	 * `AgentUsage`.
	 */
	'usage': AgentUsage;
}

/**
 * Normalised, provider-agnostic token-usage report. Maps each API's usage shape
 * onto a common one so debug tooling and hosts read the same fields regardless
 * of transport.
 *
 * Whether the counts are **cumulative for the session** or **per-turn** depends
 * on the provider (Gemini Live reports cumulative session totals). Treat
 * `totalTokenCount` as "the number the provider is billing this session
 * against" — for Gemini Live it is exactly the figure that trips a
 * `RESOURCE_EXHAUSTED` quota error. The debug layer additionally tracks the
 * peak and the number of reports, so a host can show the trend either way.
 */
export interface AgentUsage {
	/** Tokens attributed to the input context (system prompt + history + tool I/O + input audio). */
	promptTokenCount?: number;
	/** Tokens attributed to the model's generated output (text + audio). */
	responseTokenCount?: number;
	/** Total tokens — the figure quota is measured against. */
	totalTokenCount?: number;
	/**
	 * Of `promptTokenCount`, how many were served from context cache (a provider
	 * discount on a repeated prefix). On a voice turn the giant system prompt is
	 * re-ingested every generation pass; a non-zero value here means the provider
	 * is caching that prefix rather than re-billing it in full. `0` / absent ⇒
	 * the whole prompt is fresh each pass.
	 */
	cachedContentTokenCount?: number;
	/**
	 * Optional per-modality breakdown (e.g. `[{ modality: 'TEXT', tokenCount: 61432 },
	 * { modality: 'AUDIO', tokenCount: 1200 }]`). Lets a debug box show how much
	 * of the budget is text/JSON vs. audio.
	 */
	details?: Array<{ modality: string; tokenCount: number }>;
}
