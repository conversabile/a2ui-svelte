import { GoogleGenAI, Modality } from '@google/genai';
import type {
	AgentTransport,
	AgentTransportConnectOptions,
	AgentTransportEventMap,
	TransportCapabilities
} from '../transport';

export interface GeminiLiveTransportOptions {
	/**
	 * Auth for the Live socket: an ephemeral token (or raw API key), or a
	 * function that produces one — called once per `connect()`, so a fresh
	 * single-use token is minted for every session. Mint server-side with
	 * `mintGeminiToken` (exported from `a2ui-svelte/agent/gemini`) and fetch it
	 * from the browser.
	 */
	token: string | (() => string | Promise<string>);
	/** Gemini Live model. Default `'gemini-3.1-flash-live-preview'`. */
	model?: string;
	/** API version. Default 'v1alpha' (required for Gemini Live). */
	apiVersion?: string;
	/** Prebuilt TTS voice name. Default `'Aoede'`. */
	voice?: string;
}

type EventName = keyof AgentTransportEventMap;

/**
 * Gemini Live implementation of {@link AgentTransport} — the streaming
 * audio-to-audio profile. Translates Gemini's message shapes into the
 * normalised event map and back, so the rest of the library never touches
 * `@google/genai` directly. The server runs the tool loop; this transport
 * advertises audio input/output, barge-in, a native silent-context channel,
 * and server-held history, and the `Agent` adapts to exactly that.
 */
export class GeminiLiveTransport implements AgentTransport {
	#token: string | (() => string | Promise<string>);
	#model: string;
	#apiVersion: string;
	#voice: string;
	#session: any = null;
	#listeners: { [E in EventName]?: Set<(p: AgentTransportEventMap[E]) => void> } = {};
	#closed = false;

	constructor(opts: GeminiLiveTransportOptions) {
		this.#token = opts.token;
		this.#model = opts.model ?? 'gemini-3.1-flash-live-preview';
		this.#apiVersion = opts.apiVersion ?? 'v1alpha';
		this.#voice = opts.voice ?? 'Aoede';
	}

	/**
	 * Gemini Live is a persistent bidi audio socket: the server runs the tool
	 * loop, barge-in is real, it has a native silent-context channel, and it
	 * holds session history (so the agent embeds prior turns in the prompt for
	 * reconnect continuity rather than seeding `messages[]`).
	 */
	get capabilities(): TransportCapabilities {
		return {
			streaming: true,
			interruptible: true,
			silentContext: true,
			historyOwnership: 'server',
			canInitiateTurn: true,
			input: ['audio', 'text'],
			output: ['audio', 'text']
		};
	}

	async connect(opts: AgentTransportConnectOptions): Promise<void> {
		this.#closed = false;
		const token = typeof this.#token === 'function' ? await this.#token() : this.#token;
		const ai = new GoogleGenAI({
			apiKey: token,
			httpOptions: { apiVersion: this.#apiVersion }
		});

		const toolsConfig =
			opts.tools.length > 0 ? [{ functionDeclarations: opts.tools }] : undefined;

		const config: Record<string, unknown> = {
			responseModalities: [Modality.AUDIO],
			systemInstruction: opts.systemInstruction,
			inputAudioTranscription: {},
			outputAudioTranscription: {},
			speechConfig: {
				voiceConfig: { prebuiltVoiceConfig: { voiceName: this.#voice } }
			}
		};
		if (toolsConfig) config.tools = toolsConfig;

		await new Promise<void>((resolve, reject) => {
			let opened = false;
			ai.live
				.connect({
					model: this.#model,
					config: config as never,
					callbacks: {
						onopen: () => {
							opened = true;
							resolve();
						},
						onmessage: (message: unknown) => this.#onMessage(message),
						onerror: (e: unknown) => {
							const message =
								(e as { message?: string })?.message ?? 'Gemini transport error';
							if (!opened) reject(new Error(message));
							this.#emit('error', { message, cause: e });
						},
						onclose: (e: unknown) => {
							const reason = (e as { reason?: string })?.reason;
							this.#emit('close', { reason });
						}
					}
				})
				.then((session: unknown) => {
					this.#session = session;
				})
				.catch(reject);
		});
	}

	sendAudioChunk(base64Pcm16k: string): void {
		if (!this.#session || this.#closed) return;
		this.#session.sendRealtimeInput({
			audio: { data: base64Pcm16k, mimeType: 'audio/pcm;rate=16000' }
		});
	}

	sendText(text: string): void {
		if (!this.#session || this.#closed) return;
		this.#session.sendRealtimeInput({ text });
	}

	sendContextUpdate(text: string): void {
		if (!this.#session || this.#closed) return;
		// `turnComplete: false` appends the content to the model's context but
		// tells the server to wait for further input before generating — so the
		// surface state rides along with the user's next turn instead of
		// provoking a standalone response. `sendClientContent` (vs realtime
		// input) also guarantees ordering into the context.
		try {
			this.#session.sendClientContent({
				turns: [{ role: 'user', parts: [{ text }] }],
				turnComplete: false
			});
		} catch (e) {
			this.#emit('error', {
				message: (e as Error).message ?? 'Failed to send context update',
				cause: e
			});
		}
	}

	sendToolResult(callId: string, name: string, result: unknown): void {
		if (!this.#session || this.#closed) return;
		const functionResponses = [{ id: callId, name, response: result as Record<string, unknown> }];
		try {
			if (typeof this.#session.sendToolResponse === 'function') {
				this.#session.sendToolResponse({ functionResponses });
			} else {
				// Older @google/genai versions: fall back to send().
				this.#session.send({ functionResponses });
			}
		} catch (e) {
			this.#emit('error', {
				message: (e as Error).message ?? 'Failed to send tool response',
				cause: e
			});
		}
	}

	on<E extends EventName>(
		event: E,
		handler: (payload: AgentTransportEventMap[E]) => void
	): () => void {
		let set = this.#listeners[event] as Set<(p: AgentTransportEventMap[E]) => void> | undefined;
		if (!set) {
			set = new Set();
			(this.#listeners[event] as unknown) = set;
		}
		set.add(handler);
		return () => set!.delete(handler);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#session) {
			try {
				if (typeof this.#session.close === 'function') this.#session.close();
				if (typeof this.#session.disconnect === 'function') this.#session.disconnect();
			} catch {
				// best-effort
			}
		}
		this.#session = null;
	}

	#emit<E extends EventName>(event: E, payload: AgentTransportEventMap[E]): void {
		const set = this.#listeners[event] as
			| Set<(p: AgentTransportEventMap[E]) => void>
			| undefined;
		if (!set) return;
		for (const h of set) {
			try {
				h(payload);
			} catch (e) {
				console.error(`[GeminiLiveTransport] listener for "${event}" threw:`, e);
			}
		}
	}

	/**
	 * Normalise Gemini Live's `usageMetadata` into an `AgentUsage` and emit it.
	 * Merges the per-modality `promptTokensDetails` / `responseTokensDetails`
	 * into a single modality→tokens breakdown so a debug box can show how much
	 * of the budget is text/JSON versus audio.
	 */
	#emitUsage(meta: any): void {
		const byModality = new Map<string, number>();
		for (const d of [...(meta.promptTokensDetails ?? []), ...(meta.responseTokensDetails ?? [])]) {
			if (!d || typeof d.modality !== 'string') continue;
			byModality.set(d.modality, (byModality.get(d.modality) ?? 0) + (d.tokenCount ?? 0));
		}
		const details = Array.from(byModality, ([modality, tokenCount]) => ({ modality, tokenCount }));
		this.#emit('usage', {
			promptTokenCount: meta.promptTokenCount,
			responseTokenCount: meta.responseTokenCount,
			totalTokenCount: meta.totalTokenCount,
			cachedContentTokenCount: meta.cachedContentTokenCount,
			...(details.length > 0 ? { details } : {})
		});
	}

	#onMessage(message: any): void {
		if (!message) return;

		// Token usage rides along on several message kinds (often the turn's
		// final serverContent). Surface it before any early return so the debug
		// layer sees the authoritative count regardless of which message carries
		// it. Gemini Live's `totalTokenCount` is the cumulative session figure
		// that a `RESOURCE_EXHAUSTED` quota error is measured against.
		if (message.usageMetadata) {
			this.#emitUsage(message.usageMetadata);
		}

		if (message.toolCall) {
			const calls = (message.toolCall.functionCalls ?? []).map(
				(fc: { id: string; name: string; args?: Record<string, unknown> }) => ({
					id: fc.id,
					name: fc.name,
					args: fc.args ?? {}
				})
			);
			this.#emit('tool-call', { calls });
			return;
		}

		if (message.serverContent?.interrupted) {
			this.#emit('interrupted', {} as never);
			return;
		}

		const modelTurn = message.serverContent?.modelTurn;
		if (modelTurn?.parts) {
			for (const part of modelTurn.parts) {
				if (part.inlineData?.data) {
					this.#emit('audio-out', { base64Pcm24k: part.inlineData.data });
				}
			}
		}

		const outputText = message.serverContent?.outputTranscription?.text;
		if (outputText) {
			this.#emit('text-out', { text: outputText });
		}

		const inputText = message.serverContent?.inputTranscription?.text;
		if (inputText) {
			this.#emit('text-in', { text: inputText });
		}

		if (message.serverContent?.turnComplete) {
			this.#emit('turn-complete', {} as never);
		}
	}
}
