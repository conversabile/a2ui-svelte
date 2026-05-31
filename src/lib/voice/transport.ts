import type { UserAction } from '../core/registries/event-bus';

/**
 * Provider-agnostic bidirectional voice + tool channel.
 *
 * Implementations adapt a specific live-API SDK (Gemini Live, OpenAI Realtime, etc.)
 * to the same event shape, so VoiceAgent works unchanged across providers.
 *
 * Lifetime: caller calls connect() once; transport emits events until close()
 * is called or 'close'/'error' fires.
 */
export interface VoiceTransport {
	/**
	 * Establish the live session. Resolves once the session is open;
	 * rejects with a normalised Error if it cannot connect.
	 */
	connect(opts: VoiceTransportConnectOptions): Promise<void>;

	/** Send a 16-bit little-endian PCM @ 16 kHz audio chunk, base64-encoded. */
	sendAudioChunk(base64Pcm16k: string): void;

	/** Send a text turn (used for tagged events like USER_ACTION and SURFACE_UPDATED). */
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
	 * Gemini Live implements this via `sendClientContent({ turnComplete: false })`,
	 * which the SDK documents as "the server will await additional messages
	 * before starting generation". Unlike `sendText` (a `sendRealtimeInput`
	 * text turn that the API treats as user input and may answer), this is
	 * guaranteed not to start generation and is ordered into the context.
	 *
	 * Optional: transports without a silent context channel omit it; the agent
	 * falls back to `sendText` (which may trigger a turn — acceptable
	 * degradation for those providers).
	 */
	sendContextUpdate?(text: string): void;

	/** Reply to a tool call. Result must be JSON-serialisable. */
	sendToolResult(callId: string, name: string, result: unknown): void;

	/**
	 * Forward a spec-canonical `userAction` event to the agent. When omitted,
	 * `VoiceAgent` falls back to wrapping the event in an XML-tagged text turn
	 * via `sendText` — necessary for voice live-APIs that have no native event
	 * channel into the model context (e.g. Gemini Live), and the historical
	 * behaviour of this library.
	 *
	 * Transports that ride a spec-aligned channel (e.g. A2A `DataPart` with
	 * `mimeType: "application/json+a2ui"`) implement this natively so the
	 * payload reaches the agent as a structured `userAction` event rather than
	 * as an opaque text turn.
	 *
	 * The `action` object always conforms to the v0.8 spec:
	 * `{ name, surfaceId, sourceComponentId, timestamp, context }` — including
	 * `context: {}` when the source component declared no `action.context`.
	 */
	sendUserAction?(action: UserAction): void;

	/** Subscribe to a transport event. Returns an unsubscribe function. */
	on<E extends keyof VoiceTransportEventMap>(
		event: E,
		handler: (payload: VoiceTransportEventMap[E]) => void
	): () => void;

	/** Close the session. Idempotent. */
	close(): void;
}

export interface VoiceTransportConnectOptions {
	/** Auth token / API key supplied by the host. */
	token: string;

	/** Full system prompt (assembled by VoiceAgent + prompt-builder). */
	systemInstruction: string;

	/** Function declarations (Gemini-style — VoiceAgent assembles these from toolRegistry). */
	tools: Array<{
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	}>;

	/** Optional voice name / TTS config; ignored by transports that don't support it. */
	voice?: string;

	/** Provider-specific extra options. Discouraged outside the adapter. */
	providerOptions?: Record<string, unknown>;
}

export interface VoiceTransportEventMap {
	/** Agent invoked one or more tools. VoiceAgent dispatches them and replies via sendToolResult. */
	'tool-call': {
		calls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
	};

	/** Agent produced an audio chunk (base64 PCM 16-bit @ 24 kHz). */
	'audio-out': { base64Pcm24k: string };

	/** ASR partial / final on the user's mic input. */
	'transcript-in': { text: string };

	/** ASR partial / final on the model's audio output. */
	'transcript-out': { text: string };

	/** Model turn was interrupted (user spoke over) — clear any in-flight playback. */
	'interrupted': Record<string, never>;

	/** Model finished its turn — used to flush the transcript buffer and clear "thinking" status. */
	'turn-complete': Record<string, never>;

	/** Recoverable error from the transport. */
	'error': { message: string; cause?: unknown };

	/** Session ended (either by client or server). */
	'close': { reason?: string };
}
