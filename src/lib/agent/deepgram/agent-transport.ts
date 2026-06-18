import type {
	AgentTransport,
	AgentTransportConnectOptions,
	AgentTransportEventMap,
	TransportCapabilities
} from '../transport';
import { base64ToBytes, bytesToBase64 } from '../pcm';

export interface DeepgramVoiceAgentTransportOptions {
	/**
	 * Auth for the Agent socket: a short-lived grant JWT (recommended for
	 * browsers — mint server-side with `mintDeepgramToken`, exported from
	 * `a2ui-svelte/agent/deepgram`) or a raw Deepgram API key (local
	 * development only), or a function that produces one — called once per
	 * `connect()`. Browsers can't set an Authorization header on a WebSocket,
	 * so the credential rides the `Sec-WebSocket-Protocol` header
	 * (`['bearer', jwt]` / `['token', key]`); the scheme is auto-detected from
	 * the token shape, or forced via `authScheme`.
	 */
	token: string | (() => string | Promise<string>);
	/** Force the subprotocol auth scheme instead of auto-detecting JWT vs API key. */
	authScheme?: 'bearer' | 'token';
	/** Speech-to-text model (`agent.listen`). Default `'nova-3'`. */
	listenModel?: string;
	/**
	 * LLM behind the agent (`agent.think.provider`). Deepgram hosts the default
	 * managed models, so no extra API key is needed. Default
	 * `{ type: 'open_ai', model: 'gpt-4o-mini' }`.
	 */
	thinkProvider?: { type: string; model: string; [key: string]: unknown };
	/** TTS voice (`agent.speak`). Default `'aura-2-thalia-en'`. */
	speakModel?: string;
	/** Agent language. Default `'en'`. */
	language?: string;
	/** Spoken greeting when the session opens. */
	greeting?: string;
	/** Override the WebSocket endpoint. Default `'wss://agent.deepgram.com/v1/agent/converse'`. */
	url?: string;
}

type EventName = keyof AgentTransportEventMap;

/**
 * Deepgram Voice Agent implementation of {@link AgentTransport} — a streaming
 * voice profile built as a managed STT→LLM→TTS pipeline rather than a native
 * speech-to-speech model. The whole agent is configured **over the socket**
 * (one `Settings` message carries the system prompt, the function
 * declarations, and the audio formats), which is exactly the shape the
 * transport-neutral `Agent` needs: the definition stays client-side and no
 * dashboard-side agent object exists.
 *
 * Functions declared without an `endpoint` are client-side: Deepgram emits
 * `FunctionCallRequest` and waits for our `FunctionCallResponse`, mapping 1:1
 * onto the neutral `tool-call`/`sendToolResult` pair. Audio needs no
 * resampling — input is declared as linear16 @ 16 kHz (the contract's mic
 * rate) and output as linear16 @ 24 kHz with no container (the contract's
 * speaker rate), so chunks pass straight through.
 *
 * Free tier note: Deepgram's pay-as-you-go signup includes one-off free
 * credits, which makes this the cheapest way to try a voice transport.
 */
export class DeepgramVoiceAgentTransport implements AgentTransport {
	#token: string | (() => string | Promise<string>);
	#authScheme?: 'bearer' | 'token';
	#listenModel: string;
	#thinkProvider: { type: string; model: string; [key: string]: unknown };
	#speakModel: string;
	#language: string;
	#greeting?: string;
	#url: string;
	#ws: WebSocket | null = null;
	#listeners: { [E in EventName]?: Set<(p: AgentTransportEventMap[E]) => void> } = {};
	#closed = false;

	constructor(opts: DeepgramVoiceAgentTransportOptions) {
		this.#token = opts.token;
		this.#authScheme = opts.authScheme;
		this.#listenModel = opts.listenModel ?? 'nova-3';
		this.#thinkProvider = opts.thinkProvider ?? { type: 'open_ai', model: 'gpt-4o-mini' };
		this.#speakModel = opts.speakModel ?? 'aura-2-thalia-en';
		this.#language = opts.language ?? 'en';
		this.#greeting = opts.greeting;
		this.#url = opts.url ?? 'wss://agent.deepgram.com/v1/agent/converse';
	}

	/**
	 * Streaming voice profile: persistent socket, real barge-in
	 * (`UserStartedSpeaking`), server-held history. No silent-context channel —
	 * Deepgram's only text inject (`InjectUserMessage`) provokes a response, so
	 * surface syncs ride `sendText` (acceptable degradation, see
	 * `AgentTransport.sendContextUpdate`).
	 */
	get capabilities(): TransportCapabilities {
		return {
			streaming: true,
			interruptible: true,
			silentContext: false,
			historyOwnership: 'server',
			canInitiateTurn: true,
			input: ['audio', 'text'],
			output: ['audio', 'text']
		};
	}

	async connect(opts: AgentTransportConnectOptions): Promise<void> {
		this.#closed = false;
		const token = typeof this.#token === 'function' ? await this.#token() : this.#token;
		// Grant JWTs ride `bearer`, raw API keys ride `token`. A JWT is three
		// dot-separated base64 segments — detect that unless explicitly forced.
		const scheme = this.#authScheme ?? (token.split('.').length === 3 ? 'bearer' : 'token');

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			let ws: WebSocket;
			try {
				ws = new WebSocket(this.#url, [scheme, token]);
			} catch (e) {
				reject(new Error((e as Error).message ?? 'Failed to open Deepgram Agent socket'));
				return;
			}
			this.#ws = ws;
			ws.binaryType = 'arraybuffer';
			ws.onopen = () => {
				// One Settings message carries the whole agent definition: audio
				// formats, STT/LLM/TTS providers, the system prompt, and the
				// function declarations (no `endpoint` ⇒ executed client-side).
				this.#send({
					type: 'Settings',
					audio: {
						input: { encoding: 'linear16', sample_rate: 16000 },
						output: { encoding: 'linear16', sample_rate: 24000, container: 'none' }
					},
					agent: {
						language: this.#language,
						listen: { provider: { type: 'deepgram', model: this.#listenModel } },
						think: {
							provider: this.#thinkProvider,
							prompt: opts.systemInstruction,
							...(opts.tools.length > 0
								? {
										functions: opts.tools.map((t) => ({
											name: t.name,
											description: t.description,
											parameters: t.parameters
										}))
									}
								: {})
						},
						speak: { provider: { type: 'deepgram', model: this.#speakModel } },
						...(this.#greeting ? { greeting: this.#greeting } : {})
					}
				});
			};
			ws.onmessage = (event: MessageEvent) => {
				// Binary frames are the agent's voice (linear16 @ 24 kHz, raw).
				if (event.data instanceof ArrayBuffer) {
					this.#emit('audio-out', { base64Pcm24k: bytesToBase64(new Uint8Array(event.data)) });
					return;
				}
				let message: Record<string, unknown>;
				try {
					message = JSON.parse(String(event.data));
				} catch (e) {
					console.warn('[DeepgramVoiceAgentTransport] unparseable server message:', e);
					return;
				}
				// Settle connect() on SettingsApplied — config accepted, session live.
				if (!settled && message.type === 'SettingsApplied') {
					settled = true;
					resolve();
					return;
				}
				if (!settled && message.type === 'Error') {
					settled = true;
					reject(new Error(String(message.description ?? 'Deepgram rejected the settings')));
					return;
				}
				this.#onMessage(message);
			};
			ws.onerror = () => {
				if (!settled) {
					settled = true;
					reject(new Error('Deepgram Agent socket error during connect'));
				} else {
					this.#emit('error', { message: 'Deepgram Agent socket error' });
				}
			};
			ws.onclose = (event: CloseEvent) => {
				if (!settled) {
					settled = true;
					reject(
						new Error(event.reason || `Deepgram Agent socket closed (code ${event.code})`)
					);
					return;
				}
				this.#emit('close', { reason: event.reason || undefined });
			};
		});
	}

	sendAudioChunk(base64Pcm16k: string): void {
		if (!this.#isOpen()) return;
		// Mic audio goes down as raw binary frames; the contract's 16 kHz
		// linear16 is exactly what the Settings message declared.
		const bytes = base64ToBytes(base64Pcm16k);
		try {
			this.#ws!.send(bytes.buffer as ArrayBuffer);
		} catch (e) {
			this.#emit('error', {
				message: (e as Error).message ?? 'Failed to send audio chunk',
				cause: e
			});
		}
	}

	sendText(text: string): void {
		if (!this.#isOpen()) return;
		this.#send({ type: 'InjectUserMessage', content: text });
	}

	sendToolResult(callId: string, name: string, result: unknown): void {
		if (!this.#isOpen()) return;
		this.#send({
			type: 'FunctionCallResponse',
			id: callId,
			name,
			content: typeof result === 'string' ? result : JSON.stringify(result)
		});
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

	#send(message: Record<string, unknown>): void {
		try {
			this.#ws?.send(JSON.stringify(message));
		} catch (e) {
			this.#emit('error', {
				message: (e as Error).message ?? 'Failed to send Deepgram message',
				cause: e
			});
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	#onMessage(message: any): void {
		switch (message.type) {
			// Finalised utterances, both directions. These are whole sentences,
			// not token deltas — a trailing space keeps consecutive chunks
			// readable when the Agent concatenates them into one turn.
			case 'ConversationText': {
				const text = typeof message.content === 'string' ? message.content : '';
				if (!text) return;
				if (message.role === 'user') this.#emit('text-in', { text: `${text} ` });
				else this.#emit('text-out', { text: `${text} ` });
				return;
			}

			// The user spoke over the agent — barge-in.
			case 'UserStartedSpeaking':
				this.#emit('interrupted', {} as never);
				return;

			// The server finished sending the response audio — the turn is over.
			case 'AgentAudioDone':
				this.#emit('turn-complete', {} as never);
				return;

			case 'FunctionCallRequest': {
				// Only client-side functions are ours to execute; server-side ones
				// (declared with an endpoint) are resolved by Deepgram itself.
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const functions: any[] = Array.isArray(message.functions) ? message.functions : [];
				const calls = functions
					.filter((f) => f.client_side !== false)
					.map((f) => ({
						id: String(f.id ?? f.name),
						name: String(f.name ?? ''),
						args: this.#parseArgs(f.arguments)
					}));
				if (calls.length > 0) this.#emit('tool-call', { calls });
				return;
			}

			case 'Warning':
				this.#emit('notice', { message: String(message.description ?? 'Deepgram warning') });
				return;

			case 'Error':
				this.#emit('error', {
					message: String(message.description ?? 'Deepgram Agent error'),
					cause: message
				});
				return;
		}
	}

	/** Function-call arguments arrive as a JSON string — parse defensively. */
	#parseArgs(raw: unknown): Record<string, unknown> {
		if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
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

	#emit<E extends EventName>(event: E, payload: AgentTransportEventMap[E]): void {
		const set = this.#listeners[event] as Set<(p: AgentTransportEventMap[E]) => void> | undefined;
		if (!set) return;
		for (const h of set) {
			try {
				h(payload);
			} catch (e) {
				console.error(`[DeepgramVoiceAgentTransport] listener for "${event}" threw:`, e);
			}
		}
	}
}
