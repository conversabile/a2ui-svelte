import type {
	AgentTransport,
	AgentTransportConnectOptions,
	AgentTransportEventMap,
	AgentUsage
} from '../agent/transport';

/**
 * Provider-agnostic bidirectional **voice** + tool channel — the neutral
 * {@link AgentTransport} plus the audio surface that only a streaming voice
 * live-API has.
 *
 * Implementations adapt a specific live-API SDK (Gemini Live, OpenAI Realtime,
 * etc.) to the same event shape, so `VoiceAgent` works unchanged across
 * providers.
 *
 * Lifetime: caller calls `connect()` once; transport emits events until
 * `close()` is called or `'close'`/`'error'` fires.
 */
export interface VoiceTransport extends AgentTransport {
	/**
	 * Establish the live session. Resolves once the session is open; rejects
	 * with a normalised Error if it cannot connect. Narrows the base
	 * {@link AgentTransport.connect} to accept the voice-only `voice` option.
	 */
	connect(opts: VoiceTransportConnectOptions): Promise<void>;

	/** Send a 16-bit little-endian PCM @ 16 kHz audio chunk, base64-encoded. */
	sendAudioChunk(base64Pcm16k: string): void;

	/** Subscribe to a transport event. Returns an unsubscribe function. */
	on<E extends keyof VoiceTransportEventMap>(
		event: E,
		handler: (payload: VoiceTransportEventMap[E]) => void
	): () => void;
}

export interface VoiceTransportEventMap extends AgentTransportEventMap {
	/** Agent produced an audio chunk (base64 PCM 16-bit @ 24 kHz). */
	'audio-out': { base64Pcm24k: string };

	/** Model turn was interrupted (user spoke over) — clear any in-flight playback. */
	'interrupted': Record<string, never>;

	/**
	 * @deprecated Use `'text-in'`. Kept as an alias for external listeners that
	 * predate the transport-neutral rename; voice transports dual-emit both.
	 */
	'transcript-in': { text: string };

	/**
	 * @deprecated Use `'text-out'`. Kept as an alias for external listeners that
	 * predate the transport-neutral rename; voice transports dual-emit both.
	 */
	'transcript-out': { text: string };
}

export interface VoiceTransportConnectOptions extends AgentTransportConnectOptions {
	/** Optional voice name / TTS config; ignored by transports that don't support it. */
	voice?: string;
}

/**
 * @deprecated Use {@link AgentUsage}. Kept as an alias for back-compat — the
 * usage shape is identical and now lives in the neutral agent layer.
 */
export type VoiceUsage = AgentUsage;
export type { AgentUsage };
