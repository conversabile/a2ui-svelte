import type {
	AgentModel,
	AgentModelConnectOptions,
	AgentModelEventMap,
	AgentUsage,
	AgentModelCapabilities
} from '../model';
import { base64ToInt16, int16ToBase64, resamplePcm16 } from '../pcm';

export interface OpenAIRealtimeModelOptions {
	/**
	 * Auth for the Realtime socket: an ephemeral client secret (`ek_…`) or a
	 * raw API key, or a function that produces one — called once per
	 * `connect()`, so a fresh single-use secret is minted for every session.
	 * Mint server-side with `mintOpenAIRealtimeSecret` (exported from
	 * `a2ui-svelte/agent/openai`) and fetch it from the browser; a raw key is
	 * for local development only (it rides the WebSocket subprotocol in clear
	 * view of the client).
	 */
	token: string | (() => string | Promise<string>);
	/** Realtime voice model. Default `'gpt-realtime-2'`. */
	model?: string;
	/** TTS voice. Default `'marin'`. */
	voice?: string;
	/**
	 * Model used to transcribe the user's mic audio (the `text-in` channel).
	 * Default `'gpt-4o-mini-transcribe'`.
	 */
	transcriptionModel?: string;
	/** Override the WebSocket endpoint. Default `'wss://api.openai.com/v1/realtime'`. */
	url?: string;
}

type EventName = keyof AgentModelEventMap;

/** Sample rates fixed by the neutral contract (mic in / speaker out). */
const MIC_RATE = 16000;
const REALTIME_RATE = 24000;

/**
 * OpenAI Realtime implementation of {@link AgentModel} — the streaming
 * speech-to-speech profile. Talks the GA Realtime WebSocket protocol directly
 * (JSON events over a browser `WebSocket`; auth via the
 * `openai-insecure-api-key.<token>` subprotocol, which accepts ephemeral
 * client secrets) and translates it into the normalised event map, so the
 * rest of the library never sees an OpenAI message shape. The server runs the
 * tool loop; this model advertises audio input/output, barge-in, a native
 * silent-context channel (`conversation.item.create` without
 * `response.create`), and server-held history, and the `Agent` adapts to
 * exactly that.
 *
 * The Realtime API speaks 24 kHz PCM on both directions; the contract's mic
 * input is 16 kHz, so input chunks are resampled here. Output is already the
 * contract's 24 kHz.
 */
export class OpenAIRealtimeModel implements AgentModel {
	#token: string | (() => string | Promise<string>);
	#model: string;
	#voice: string;
	#transcriptionModel: string;
	#url: string;
	#ws: WebSocket | null = null;
	#listeners: { [E in EventName]?: Set<(p: AgentModelEventMap[E]) => void> } = {};
	#closed = false;
	// Function calls collected during the current response; surfaced as ONE
	// `tool-call` batch on `response.done` (mirrors Gemini Live's batching, and
	// lets us send a single `response.create` once every result is back).
	#turnCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
	#pendingCount = 0;

	constructor(opts: OpenAIRealtimeModelOptions) {
		this.#token = opts.token;
		this.#model = opts.model ?? 'gpt-realtime-2';
		this.#voice = opts.voice ?? 'marin';
		this.#transcriptionModel = opts.transcriptionModel ?? 'gpt-4o-mini-transcribe';
		this.#url = opts.url ?? 'wss://api.openai.com/v1/realtime';
	}

	/**
	 * OpenAI Realtime is a persistent bidi audio socket: the server runs the
	 * tool loop, barge-in is real, items can be appended to context without
	 * provoking a response (a true silent-context channel), and the session
	 * holds history server-side.
	 */
	get capabilities(): AgentModelCapabilities {
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

	async connect(opts: AgentModelConnectOptions): Promise<void> {
		this.#closed = false;
		const token = typeof this.#token === 'function' ? await this.#token() : this.#token;
		const url = `${this.#url}?model=${encodeURIComponent(this.#model)}`;

		await new Promise<void>((resolve, reject) => {
			let opened = false;
			let ws: WebSocket;
			try {
				// Browsers can't set an Authorization header on a WebSocket — the
				// token rides the subprotocol list instead (per OpenAI's browser
				// connection docs; works for ephemeral secrets and raw keys alike).
				ws = new WebSocket(url, ['realtime', `openai-insecure-api-key.${token}`]);
			} catch (e) {
				reject(new Error((e as Error).message ?? 'Failed to open Realtime socket'));
				return;
			}
			this.#ws = ws;
			ws.onopen = () => {
				opened = true;
				// Configure the session before anything else: instructions, tools,
				// audio formats (24 kHz PCM both ways), input transcription (the
				// `text-in` channel), and the TTS voice.
				this.#send({
					type: 'session.update',
					session: {
						type: 'realtime',
						instructions: opts.systemInstruction,
						...(opts.tools.length > 0
							? {
									tools: opts.tools.map((t) => ({
										type: 'function',
										name: t.name,
										description: t.description,
										parameters: t.parameters
									}))
								}
							: {}),
						audio: {
							input: {
								format: { type: 'audio/pcm', rate: REALTIME_RATE },
								transcription: { model: this.#transcriptionModel }
							},
							output: {
								format: { type: 'audio/pcm', rate: REALTIME_RATE },
								voice: this.#voice
							}
						}
					}
				});
				resolve();
			};
			ws.onmessage = (event: MessageEvent) => {
				try {
					this.#onMessage(JSON.parse(String(event.data)));
				} catch (e) {
					console.warn('[OpenAIRealtimeModel] unparseable server event:', e);
				}
			};
			ws.onerror = () => {
				if (!opened) reject(new Error('OpenAI Realtime socket error during connect'));
				else this.#emit('error', { message: 'OpenAI Realtime socket error' });
			};
			ws.onclose = (event: CloseEvent) => {
				if (!opened) {
					reject(
						new Error(event.reason || `OpenAI Realtime socket closed (code ${event.code})`)
					);
					return;
				}
				this.#emit('close', { reason: event.reason || undefined });
			};
		});
	}

	sendAudioChunk(base64Pcm16k: string): void {
		if (!this.#isOpen()) return;
		// Contract mic audio is 16 kHz; the Realtime API expects 24 kHz PCM.
		const upsampled = resamplePcm16(base64ToInt16(base64Pcm16k), MIC_RATE, REALTIME_RATE);
		this.#send({ type: 'input_audio_buffer.append', audio: int16ToBase64(upsampled) });
	}

	sendText(text: string): void {
		if (!this.#isOpen()) return;
		this.#appendUserItem(text);
		this.#send({ type: 'response.create' });
	}

	sendContextUpdate(text: string): void {
		if (!this.#isOpen()) return;
		// An item appended WITHOUT `response.create` becomes part of the
		// conversation context but does not provoke a turn — exactly the silent
		// channel the agent's surface-sync rides on.
		this.#appendUserItem(text);
	}

	sendToolResult(callId: string, _name: string, result: unknown): void {
		if (!this.#isOpen()) return;
		this.#send({
			type: 'conversation.item.create',
			item: {
				type: 'function_call_output',
				call_id: callId,
				output: typeof result === 'string' ? result : JSON.stringify(result)
			}
		});
		if (this.#pendingCount > 0) {
			this.#pendingCount -= 1;
			if (this.#pendingCount > 0) return;
		}
		// All results for the batch are in — let the model continue.
		this.#send({ type: 'response.create' });
	}

	on<E extends EventName>(
		event: E,
		handler: (payload: AgentModelEventMap[E]) => void
	): () => void {
		let set = this.#listeners[event] as Set<(p: AgentModelEventMap[E]) => void> | undefined;
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
		try {
			this.#ws?.close();
		} catch {
			// best-effort
		}
		this.#ws = null;
	}

	#isOpen(): boolean {
		return !this.#closed && this.#ws !== null && this.#ws.readyState === WebSocket.OPEN;
	}

	#send(event: Record<string, unknown>): void {
		try {
			this.#ws?.send(JSON.stringify(event));
		} catch (e) {
			this.#emit('error', {
				message: (e as Error).message ?? 'Failed to send Realtime event',
				cause: e
			});
		}
	}

	#appendUserItem(text: string): void {
		this.#send({
			type: 'conversation.item.create',
			item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
		});
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	#onMessage(message: any): void {
		if (!message?.type) return;
		switch (message.type) {
			// Model audio (base64 PCM @ 24 kHz — already the contract rate).
			// `response.audio.delta` is the pre-GA name, kept for proxies pinned
			// to the beta protocol.
			case 'response.output_audio.delta':
			case 'response.audio.delta':
				if (message.delta) this.#emit('audio-out', { base64Pcm24k: message.delta });
				return;

			// Transcript of the model's audio (or plain text output).
			case 'response.output_audio_transcript.delta':
			case 'response.audio_transcript.delta':
			case 'response.output_text.delta':
			case 'response.text.delta':
				if (message.delta) this.#emit('text-out', { text: message.delta });
				return;

			// Transcript of the user's mic audio. The `.completed` event carries
			// the whole utterance once — deltas are skipped to avoid duplicates.
			case 'conversation.item.input_audio_transcription.completed':
				if (message.transcript) this.#emit('text-in', { text: message.transcript });
				return;

			// The user spoke over the model (server VAD) — barge-in.
			case 'input_audio_buffer.speech_started':
				this.#emit('interrupted', {} as never);
				return;

			// A finished output item; function calls surface here with their
			// complete arguments. Batched until response.done.
			case 'response.output_item.done': {
				const item = message.item;
				if (item?.type === 'function_call') {
					this.#turnCalls.push({
						id: item.call_id,
						name: item.name,
						args: this.#parseArgs(item.arguments)
					});
				}
				return;
			}

			case 'response.done': {
				const usage = message.response?.usage;
				if (usage) this.#emitUsage(usage);
				if (this.#turnCalls.length > 0) {
					const calls = this.#turnCalls;
					this.#turnCalls = [];
					this.#pendingCount = calls.length;
					this.#emit('tool-call', { calls });
					// No turn-complete — the turn continues once results are back.
					return;
				}
				this.#emit('turn-complete', {} as never);
				return;
			}

			case 'error': {
				const err = message.error ?? {};
				this.#emit('error', {
					message: err.message ?? 'OpenAI Realtime error',
					cause: message
				});
				return;
			}
		}
	}

	/** Function-call arguments arrive as a JSON string — parse defensively. */
	#parseArgs(raw: unknown): Record<string, unknown> {
		if (typeof raw !== 'string' || !raw) return {};
		try {
			const parsed = JSON.parse(raw);
			return typeof parsed === 'object' && parsed !== null
				? (parsed as Record<string, unknown>)
				: {};
		} catch {
			return {};
		}
	}

	/**
	 * Normalise the Realtime `response.usage` into an {@link AgentUsage}.
	 * Merges the per-modality input/output detail blocks into a single
	 * modality→tokens breakdown so a debug box can show how much of the budget
	 * is text/JSON versus audio.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	#emitUsage(usage: any): void {
		const inDetails = usage.input_token_details ?? {};
		const outDetails = usage.output_token_details ?? {};
		const text = (inDetails.text_tokens ?? 0) + (outDetails.text_tokens ?? 0);
		const audio = (inDetails.audio_tokens ?? 0) + (outDetails.audio_tokens ?? 0);
		const details: Array<{ modality: string; tokenCount: number }> = [];
		if (text > 0) details.push({ modality: 'TEXT', tokenCount: text });
		if (audio > 0) details.push({ modality: 'AUDIO', tokenCount: audio });
		const payload: AgentUsage = {
			promptTokenCount: usage.input_tokens,
			responseTokenCount: usage.output_tokens,
			totalTokenCount: usage.total_tokens,
			cachedContentTokenCount: inDetails.cached_tokens,
			...(details.length > 0 ? { details } : {})
		};
		this.#emit('usage', payload);
	}

	#emit<E extends EventName>(event: E, payload: AgentModelEventMap[E]): void {
		const set = this.#listeners[event] as Set<(p: AgentModelEventMap[E]) => void> | undefined;
		if (!set) return;
		for (const h of set) {
			try {
				h(payload);
			} catch (e) {
				console.error(`[OpenAIRealtimeModel] listener for "${event}" threw:`, e);
			}
		}
	}
}
