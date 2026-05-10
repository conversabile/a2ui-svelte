import { GoogleGenAI, Modality } from '@google/genai';
import type {
	VoiceTransport,
	VoiceTransportConnectOptions,
	VoiceTransportEventMap
} from '../transport';

export interface GeminiTransportOptions {
	/** Gemini Live model. Default matches the previous Souschef monolith. */
	model?: string;
	/** API version. Default 'v1alpha' (required for Gemini Live). */
	apiVersion?: string;
}

type EventName = keyof VoiceTransportEventMap;

/**
 * Gemini Live implementation of VoiceTransport. Translates Gemini's message
 * shapes into the normalised VoiceTransportEventMap and back, so the rest
 * of the library never touches `@google/genai` directly.
 */
export class GeminiTransport implements VoiceTransport {
	#model: string;
	#apiVersion: string;
	#session: any = null;
	#listeners: { [E in EventName]?: Set<(p: VoiceTransportEventMap[E]) => void> } = {};
	#closed = false;

	constructor(opts: GeminiTransportOptions = {}) {
		this.#model = opts.model ?? 'gemini-3.1-flash-live-preview';
		this.#apiVersion = opts.apiVersion ?? 'v1alpha';
	}

	async connect(opts: VoiceTransportConnectOptions): Promise<void> {
		this.#closed = false;
		const ai = new GoogleGenAI({
			apiKey: opts.token,
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
				voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice ?? 'Aoede' } }
			},
			...(opts.providerOptions ?? {})
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
		handler: (payload: VoiceTransportEventMap[E]) => void
	): () => void {
		let set = this.#listeners[event] as Set<(p: VoiceTransportEventMap[E]) => void> | undefined;
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

	#emit<E extends EventName>(event: E, payload: VoiceTransportEventMap[E]): void {
		const set = this.#listeners[event] as
			| Set<(p: VoiceTransportEventMap[E]) => void>
			| undefined;
		if (!set) return;
		for (const h of set) {
			try {
				h(payload);
			} catch (e) {
				console.error(`[GeminiTransport] listener for "${event}" threw:`, e);
			}
		}
	}

	#onMessage(message: any): void {
		if (!message) return;

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
		if (outputText) this.#emit('transcript-out', { text: outputText });

		const inputText = message.serverContent?.inputTranscription?.text;
		if (inputText) this.#emit('transcript-in', { text: inputText });

		if (message.serverContent?.turnComplete) {
			this.#emit('turn-complete', {} as never);
		}
	}
}
