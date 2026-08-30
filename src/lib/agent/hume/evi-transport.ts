import type {
	AgentTransport,
	AgentTransportConnectOptions,
	AgentTransportEventMap,
	TransportCapabilities
} from '../transport';
import { base64ToBytes, downmixToMono, int16ToBase64, resamplePcm16, wavToPcm16 } from '../pcm';

export interface HumeEviTransportOptions {
	/**
	 * OAuth access token for the EVI socket (recommended for browsers — mint
	 * server-side with `fetchHumeAccessToken`, exported from
	 * `a2ui-svelte/agent/hume`), or a function that produces one — called once
	 * per `connect()`. Exactly one of `accessToken` / `apiKey` is required.
	 */
	accessToken?: string | (() => string | Promise<string>);
	/**
	 * Raw Hume API key — local development only; it rides the connection URL
	 * in clear view of the client. Prefer `accessToken`.
	 */
	apiKey?: string | (() => string | Promise<string>);
	/**
	 * Optional EVI config id created on the Hume platform. Not required — the
	 * system prompt, tools and audio format are all pushed over the socket via
	 * `session_settings` — but lets hosts pin platform-side settings (EVI
	 * version, language model…) when they want them.
	 */
	configId?: string;
	/** Voice id (a Hume Voice Library or custom voice). Omit for the config/default voice. */
	voiceId?: string;
	/** Override the WebSocket endpoint. Default `'wss://api.hume.ai/v0/evi/chat'`. */
	url?: string;
}

type EventName = keyof AgentTransportEventMap;

/** Sample rates fixed by the neutral contract (mic in / speaker out). */
const MIC_RATE = 16000;
const PLAYER_RATE = 24000;

/**
 * Hume EVI (Empathic Voice Interface) implementation of {@link AgentTransport}
 * — a streaming, natively speech-to-speech profile (like Gemini Live and
 * OpenAI Realtime, unlike a pipeline). Hume's free plan includes monthly
 * credits, which makes it an easy zero-cost way to try a voice transport.
 *
 * The whole agent rides the socket: one `session_settings` message carries the
 * system prompt, the tool declarations (`parameters` stringified, as EVI
 * expects), and the mic audio format — so the transport-neutral
 * `AgentDefinition` stays the single source of truth and no platform-side
 * config is required (`configId` remains available for hosts that want one).
 *
 * Audio: mic input is declared as linear16 @ 16 kHz and passes through
 * unchanged; EVI's output arrives as base64 **WAV** (typically 48 kHz), which
 * is unpacked, downmixed and resampled here to the contract's raw 24 kHz PCM.
 */
export class HumeEviTransport implements AgentTransport {
	#accessToken?: string | (() => string | Promise<string>);
	#apiKey?: string | (() => string | Promise<string>);
	#configId?: string;
	#voiceId?: string;
	#url: string;
	#ws: WebSocket | null = null;
	#listeners: { [E in EventName]?: Set<(p: AgentTransportEventMap[E]) => void> } = {};
	#closed = false;

	constructor(opts: HumeEviTransportOptions) {
		this.#accessToken = opts.accessToken;
		this.#apiKey = opts.apiKey;
		this.#configId = opts.configId;
		this.#voiceId = opts.voiceId;
		this.#url = opts.url ?? 'wss://api.hume.ai/v0/evi/chat';
	}

	/**
	 * Streaming speech-to-speech profile: persistent socket, real barge-in
	 * (`user_interruption`), server-held history. No silent-context channel —
	 * EVI's only text inject (`user_input`) provokes a response, so surface
	 * syncs ride `sendText` (acceptable degradation, see
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
		const accessToken =
			typeof this.#accessToken === 'function' ? await this.#accessToken() : this.#accessToken;
		const apiKey = typeof this.#apiKey === 'function' ? await this.#apiKey() : this.#apiKey;
		if (!accessToken && !apiKey) {
			throw new Error('HumeEviTransport needs an accessToken (or an apiKey for development).');
		}
		// Browsers can't set auth headers on a WebSocket — EVI takes the
		// credential as a query parameter instead.
		const params = new URLSearchParams();
		if (accessToken) params.set('access_token', accessToken);
		else params.set('api_key', apiKey!);
		if (this.#configId) params.set('config_id', this.#configId);

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			let ws: WebSocket;
			try {
				ws = new WebSocket(`${this.#url}?${params.toString()}`);
			} catch (e) {
				reject(new Error((e as Error).message ?? 'Failed to open EVI socket'));
				return;
			}
			this.#ws = ws;
			ws.onopen = () => {
				// Push the whole agent definition over the socket: prompt, tools
				// (EVI wants `parameters` as a stringified JSON schema), and the
				// mic audio format the recorder produces.
				this.#send({
					type: 'session_settings',
					system_prompt: opts.systemInstruction,
					audio: { encoding: 'linear16', sample_rate: MIC_RATE, channels: 1 },
					...(opts.tools.length > 0
						? {
								tools: opts.tools.map((t) => ({
									type: 'function',
									name: t.name,
									description: t.description,
									parameters: JSON.stringify(t.parameters)
								}))
							}
						: {}),
					...(this.#voiceId ? { voice_id: this.#voiceId } : {})
				});
			};
			ws.onmessage = (event: MessageEvent) => {
				let message: Record<string, unknown>;
				try {
					message = JSON.parse(String(event.data));
				} catch (e) {
					console.warn('[HumeEviTransport] unparseable server message:', e);
					return;
				}
				// chat_metadata is EVI's session-open ack — settle connect() on it.
				if (!settled && message.type === 'chat_metadata') {
					settled = true;
					resolve();
					return;
				}
				if (!settled && message.type === 'error') {
					settled = true;
					reject(new Error(String(message.message ?? 'EVI rejected the connection')));
					return;
				}
				this.#onMessage(message);
			};
			ws.onerror = () => {
				if (!settled) {
					settled = true;
					reject(new Error('EVI socket error during connect'));
				} else {
					this.#emit('error', { message: 'EVI socket error' });
				}
			};
			ws.onclose = (event: CloseEvent) => {
				if (!settled) {
					settled = true;
					reject(new Error(event.reason || `EVI socket closed (code ${event.code})`));
					return;
				}
				this.#emit('close', { reason: event.reason || undefined });
			};
		});
	}

	sendAudioChunk(base64Pcm16k: string): void {
		if (!this.#isOpen()) return;
		// session_settings declared linear16 @ 16 kHz — the contract's mic
		// format passes straight through.
		this.#send({ type: 'audio_input', data: base64Pcm16k });
	}

	sendText(text: string): void {
		if (!this.#isOpen()) return;
		this.#send({ type: 'user_input', text });
	}

	sendToolResult(callId: string, name: string, result: unknown): void {
		if (!this.#isOpen()) return;
		this.#send({
			type: 'tool_response',
			tool_call_id: callId,
			tool_name: name,
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
				message: (e as Error).message ?? 'Failed to send EVI message',
				cause: e
			});
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	#onMessage(message: any): void {
		switch (message.type) {
			// Model voice — base64 WAV (typically 48 kHz). Unpack to the
			// contract's raw 24 kHz mono PCM for the agent's speaker player.
			case 'audio_output': {
				if (typeof message.data !== 'string' || !message.data) return;
				try {
					const wav = wavToPcm16(base64ToBytes(message.data));
					const mono = downmixToMono(wav.samples, wav.channels);
					const pcm24k = resamplePcm16(mono, wav.sampleRate, PLAYER_RATE);
					this.#emit('audio-out', { base64Pcm24k: int16ToBase64(pcm24k) });
				} catch (e) {
					this.#emit('notice', {
						message: `EVI audio chunk dropped: ${(e as Error).message ?? 'decode failed'}`
					});
				}
				return;
			}

			// Finalised transcripts, both directions. Whole utterances, not
			// token deltas — a trailing space keeps consecutive chunks readable
			// when the Agent concatenates them into one turn. Interim (still
			// provisional) transcripts are skipped.
			case 'user_message': {
				if (message.interim === true) return;
				const text = message.message?.content;
				if (typeof text === 'string' && text) this.#emit('text-in', { text: `${text} ` });
				return;
			}
			case 'assistant_message': {
				const text = message.message?.content;
				if (typeof text === 'string' && text) this.#emit('text-out', { text: `${text} ` });
				return;
			}

			// The user spoke over the model — barge-in.
			case 'user_interruption':
				this.#emit('interrupted', {} as never);
				return;

			// The model finished its response — the turn is over.
			// Audited against Gemini Live's mid-loop `turnComplete` hazard: EVI
			// closes a tool round-trip with `tool_response` and only emits
			// `assistant_end` once the spoken response is done, so there is no
			// pre-result echo to suppress here.
			case 'assistant_end':
				this.#emit('turn-complete', {} as never);
				return;

			case 'tool_call': {
				// Built-in tools (web search…) are resolved by Hume itself; only
				// `function` tools — the ones we declared — are ours to execute.
				if (message.tool_type === 'builtin') return;
				this.#emit('tool-call', {
					calls: [
						{
							id: String(message.tool_call_id ?? ''),
							name: String(message.name ?? ''),
							args: this.#parseArgs(message.parameters)
						}
					]
				});
				return;
			}

			case 'error':
				this.#emit('error', {
					message: String(message.message ?? 'EVI error'),
					cause: message
				});
				return;
		}
	}

	/** Tool parameters arrive as a JSON string — parse defensively. */
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
				console.error(`[HumeEviTransport] listener for "${event}" threw:`, e);
			}
		}
	}
}
