import { GoogleGenAI } from '@google/genai';
import type {
	Content,
	FunctionCall,
	FunctionDeclaration,
	GenerateContentConfig,
	GenerateContentResponse,
	GenerateContentResponseUsageMetadata,
	Part
} from '@google/genai';
import type {
	AgentTransport,
	AgentTransportConnectOptions,
	AgentTransportEventMap,
	AgentUsage,
	TransportCapabilities
} from '../transport';

export interface GeminiTextTransportOptions {
	/**
	 * Gemini API key, or a function that produces one — resolved once per
	 * `connect()`. Optional when `baseUrl` points at a proxy that injects the
	 * real key server-side (a placeholder is sent instead); required when
	 * calling Google directly.
	 */
	apiKey?: string | (() => string | Promise<string>);
	/**
	 * Gemini **text** model (request/response). Default `'gemini-3.5-flash'`.
	 * Distinct from the Live voice model (`gemini-3.1-flash-live-preview`) used
	 * by `GeminiLiveTransport` — this transport speaks the `generateContent`
	 * API, not the bidi Live socket.
	 */
	model?: string;
	/**
	 * Override the API endpoint the `@google/genai` client talks to
	 * (`httpOptions.baseUrl`). Point it at a **same-origin proxy** so the real key
	 * stays server-side: the browser sends a placeholder key, your proxy injects
	 * the real `x-goog-api-key` and forwards to
	 * `https://generativelanguage.googleapis.com`. Omit to call Google directly
	 * (`apiKey` is then a real key, exposed client-side).
	 */
	baseUrl?: string;
	/**
	 * How many times to retry a request that fails with a rate-limit error
	 * (HTTP 429 / `RESOURCE_EXHAUSTED`) before surfacing it as an `error` event,
	 * using exponential backoff (and honouring the server's `retryDelay` hint
	 * when present). Each retry is announced as a `'notice'` event (the agent's
	 * debug box renders it). Default `1`. Set `0` to disable retries.
	 */
	maxRetries?: number;
	/**
	 * Base delay, in ms, for the exponential backoff between rate-limit retries
	 * (attempt _n_ waits `retryBaseMs · 2ⁿ`, capped at 60s and never shorter than
	 * the server's `retryDelay` hint). Default `1000`.
	 */
	retryBaseMs?: number;
}

/** Hard ceiling on any single backoff wait, so a pathological server hint can't hang the loop. */
const RETRY_MAX_MS = 60_000;

/** A 429 / quota-exhaustion error the request can be retried after. */
function isRateLimited(e: unknown): boolean {
	const err = e as { status?: number; code?: number; message?: string } | null;
	if (err?.status === 429 || err?.code === 429) return true;
	return /\b429\b|RESOURCE_EXHAUSTED|rate.?limit|too many requests|quota/i.test(
		String(err?.message ?? e ?? '')
	);
}

/** Best-effort parse of a server-provided retry delay (e.g. Gemini's `"retryDelay": "57s"`), in ms. */
function retryHintMs(e: unknown): number | undefined {
	const m = String((e as { message?: string } | null)?.message ?? '').match(
		/ret(?:ry)?[-_ ]?(?:delay|after)["':= ]+(\d+(?:\.\d+)?)\s*s/i
	);
	return m ? Math.ceil(parseFloat(m[1]) * 1000) : undefined;
}

type EventName = keyof AgentTransportEventMap;

/**
 * Request/response **text** transport over a Google Gemini model, using the
 * `@google/genai` SDK already in the tree (the same package
 * `GeminiLiveTransport` uses for the Live socket — here we drive `ai.models.
 * generateContentStream` instead of `ai.live`). It runs the agentic tool-loop
 * **client-side** and emits the neutral {@link AgentTransportEventMap}, so the
 * shared `Agent` orchestrator drives it with the same code path as Gemini Live —
 * the difference is captured entirely in {@link capabilities}.
 *
 * `streaming:false` here means "no live bidi session", **not** "no token
 * streaming": output text still streams as `text-out` deltas; the session is
 * just request/response (the agent owns history and re-sends `contents[]` each
 * loop iteration).
 */
export class GeminiTextTransport implements AgentTransport {
	#apiKey?: string | (() => string | Promise<string>);
	#model: string;
	#baseUrl?: string;
	#maxRetries: number;
	#retryBaseMs: number;
	#ai: GoogleGenAI | null = null;
	#systemInstruction = '';
	#toolDeclarations: AgentTransportConnectOptions['tools'] = [];
	/** Client-owned conversation history (we report `historyOwnership: 'client'`). */
	#contents: Content[] = [];
	#listeners: { [E in EventName]?: Set<(p: AgentTransportEventMap[E]) => void> } = {};
	#closed = false;
	#abort: AbortController | null = null;
	#turn = 0;
	// In-flight tool-call batching. Gemini can emit several functionCall parts in
	// one turn → we surface them as one `tool-call` with N calls; the agent replies
	// with N `sendToolResult`s, which we buffer and then send back as a SINGLE
	// `user` content (the functionResponses) before re-calling the model.
	#pending = new Map<string, { name: string; geminiId?: string }>();
	#pendingResponses: Part[] = [];
	#pendingCount = 0;

	constructor(opts: GeminiTextTransportOptions = {}) {
		this.#apiKey = opts.apiKey;
		this.#model = opts.model ?? 'gemini-3.5-flash';
		this.#baseUrl = opts.baseUrl;
		this.#maxRetries = Math.max(0, opts.maxRetries ?? 1);
		this.#retryBaseMs = Math.max(0, opts.retryBaseMs ?? 1000);
	}

	/**
	 * Request/response text profile: no live session, no barge-in, no silent
	 * context channel, client-owned history, can't self-initiate a turn.
	 */
	get capabilities(): TransportCapabilities {
		return {
			streaming: false,
			interruptible: false,
			silentContext: false,
			historyOwnership: 'client',
			canInitiateTurn: false,
			input: ['text'],
			output: ['text']
		};
	}

	async connect(opts: AgentTransportConnectOptions): Promise<void> {
		this.#closed = false;
		this.#systemInstruction = opts.systemInstruction;
		this.#toolDeclarations = opts.tools;
		// Seed client-owned history from prior turns (the agent passes these only
		// because we advertise `historyOwnership: 'client'`).
		this.#contents = (opts.history ?? []).map((t) => ({
			role: t.role,
			parts: [{ text: t.text }]
		}));
		// Auth is this transport's own concern. Behind a proxy the key is
		// injected server-side, so a placeholder satisfies the SDK; calling
		// Google directly requires a real key.
		const apiKey = typeof this.#apiKey === 'function' ? await this.#apiKey() : this.#apiKey;
		if (!apiKey && !this.#baseUrl) {
			throw new Error(
				'GeminiTextTransport needs an apiKey (or a baseUrl proxy that injects one server-side).'
			);
		}
		try {
			// `httpOptions.baseUrl` lets a host route requests through a same-origin
			// proxy that injects the real key — see `GeminiTextTransportOptions.baseUrl`.
			this.#ai = new GoogleGenAI({
				apiKey: apiKey ?? 'proxied-server-side',
				...(this.#baseUrl ? { httpOptions: { baseUrl: this.#baseUrl } } : {})
			});
		} catch (e) {
			throw new Error((e as Error).message ?? 'Failed to construct GoogleGenAI client');
		}
	}

	sendText(text: string): void {
		if (this.#closed) return;
		this.#contents.push({ role: 'user', parts: [{ text }] });
		void this.#runTurn();
	}

	sendToolResult(callId: string, name: string, result: unknown): void {
		if (this.#closed) return;
		const entry = this.#pending.get(callId);
		this.#pending.delete(callId);
		const functionResponse: Record<string, unknown> = {
			name: entry?.name ?? name,
			response: this.#wrapResult(result)
		};
		// Echo Gemini's own call id when it gave us one (Live always does; the
		// request/response API often doesn't — then we match by name).
		if (entry?.geminiId) functionResponse.id = entry.geminiId;
		this.#pendingResponses.push({ functionResponse } as Part);

		if (this.#pendingCount <= 0) return;
		this.#pendingCount -= 1;
		if (this.#pendingCount > 0) return;
		// All results for this batch are in: append them as ONE user content, then
		// re-call the model to continue the loop.
		this.#contents.push({ role: 'user', parts: this.#pendingResponses });
		this.#pendingResponses = [];
		void this.#runTurn();
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
			this.#abort?.abort();
		} catch {
			// best-effort
		}
		this.#abort = null;
		this.#ai = null;
	}

	/**
	 * One pass of the agentic loop: stream a model turn, surface its text deltas
	 * and (if any) its tool calls. With tool calls we stop here and wait for the
	 * results (`sendToolResult` re-enters this); otherwise the turn is final.
	 */
	async #runTurn(): Promise<void> {
		if (this.#closed || !this.#ai) return;
		this.#turn += 1;
		const turn = this.#turn;
		this.#abort = new AbortController();

		const config: GenerateContentConfig = {
			systemInstruction: this.#systemInstruction,
			abortSignal: this.#abort.signal
		};
		if (this.#toolDeclarations.length > 0) {
			config.tools = [
				{ functionDeclarations: this.#toolDeclarations as unknown as FunctionDeclaration[] }
			];
		}

		let modelText = '';
		// Raw functionCall PARTS, not bare FunctionCalls: the part-level
		// `thoughtSignature` (which Gemini 3 / thinking models require echoed back
		// in history, or the next request 400s) lives on the part, and the
		// `chunk.functionCalls` convenience accessor drops it.
		const functionCallParts: Part[] = [];
		let usage: GenerateContentResponseUsageMetadata | undefined;
		// Obtaining the stream is where a 429 surfaces (before any chunk arrives),
		// so the throttle + rate-limit retry wraps that step; draining it below is a
		// separate try/catch because partial output can't be cleanly retried.
		let stream: AsyncGenerator<GenerateContentResponse>;
		try {
			stream = await this.#requestStream({
				model: this.#model,
				contents: this.#contents,
				config
			});
		} catch (e) {
			if (this.#closed) return;
			this.#emit('error', {
				message: (e as Error).message ?? 'Gemini text transport error',
				cause: e
			});
			return;
		}
		try {
			for await (const chunk of stream) {
				if (this.#closed) return;
				const text = chunk.text;
				if (text) {
					modelText += text;
					this.#emit('text-out', { text });
				}
				// Prefer the raw candidate parts so each functionCall keeps its
				// `thoughtSignature`; fall back to the bare-call accessor only when the
				// chunk has no candidate parts (text-part chunks already handled above).
				const rawParts = chunk.candidates?.[0]?.content?.parts;
				if (rawParts) {
					for (const p of rawParts) if (p.functionCall) functionCallParts.push(p);
				} else if (chunk.functionCalls) {
					for (const fc of chunk.functionCalls) functionCallParts.push({ functionCall: fc });
				}
				if (chunk.usageMetadata) usage = chunk.usageMetadata;
			}
		} catch (e) {
			// An intentional close()/abort isn't an error — swallow it.
			if (this.#closed) return;
			this.#emit('error', {
				message: (e as Error).message ?? 'Gemini text transport error',
				cause: e
			});
			return;
		}
		if (this.#closed) return;

		if (usage) this.#emitUsage(usage);

		if (functionCallParts.length > 0) {
			// Record the model turn (text + functionCall parts) so the upcoming
			// functionResponse user-turn is coherent in the client-owned history. We
			// push the raw parts verbatim so each one keeps its `thoughtSignature`.
			const parts: Part[] = [];
			if (modelText) parts.push({ text: modelText });
			parts.push(...functionCallParts);
			this.#contents.push({ role: 'model', parts });

			const calls = functionCallParts.map(({ functionCall: fc = {} as FunctionCall }, i) => {
				// The request/response API may not populate fc.id — synthesise a
				// per-turn id and map it back so sendToolResult can find the call.
				const id = fc.id ?? `${fc.name ?? 'fn'}-${turn}-${i}`;
				this.#pending.set(id, { name: fc.name ?? '', geminiId: fc.id });
				return { id, name: fc.name ?? '', args: (fc.args ?? {}) as Record<string, unknown> };
			});
			this.#pendingCount = calls.length;
			this.#pendingResponses = [];
			this.#emit('tool-call', { calls });
			// No turn-complete yet — the loop resumes once results are back.
			return;
		}

		// Final text turn.
		if (modelText) this.#contents.push({ role: 'model', parts: [{ text: modelText }] });
		this.#emit('turn-complete', {} as never);
	}

	/**
	 * Issue one `generateContentStream` request, retrying transient rate-limit
	 * (429) failures with exponential backoff (honouring the server's
	 * `retryDelay` hint, capped at {@link RETRY_MAX_MS}). Each retry is announced
	 * as a `'notice'` event so the agent's debug box surfaces it. Non-rate-limit
	 * errors, a closed transport, and exhausted retries all propagate.
	 */
	async #requestStream(params: {
		model: string;
		contents: Content[];
		config: GenerateContentConfig;
	}): Promise<AsyncGenerator<GenerateContentResponse>> {
		for (let attempt = 0; ; attempt++) {
			try {
				return (await this.#ai!.models.generateContentStream(
					params
				)) as AsyncGenerator<GenerateContentResponse>;
			} catch (e) {
				if (this.#closed || attempt >= this.#maxRetries || !isRateLimited(e)) throw e;
				const backoff = Math.min(
					Math.max(this.#retryBaseMs * 2 ** attempt, retryHintMs(e) ?? 0),
					RETRY_MAX_MS
				);
				this.#emit('notice', {
					message: `rate-limited (429) — retry ${attempt + 1}/${this.#maxRetries} in ${Math.round(backoff / 1000)}s`
				});
				await this.#delay(backoff);
				if (this.#closed) throw e;
			}
		}
	}

	/** Sleep `ms`, resolving early if the in-flight turn is aborted (e.g. `close()`). */
	#delay(ms: number): Promise<void> {
		return new Promise<void>((resolve) => {
			if (ms <= 0 || this.#closed) return resolve();
			const signal = this.#abort?.signal;
			const onAbort = () => {
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				signal?.removeEventListener('abort', onAbort);
				resolve();
			}, ms);
			signal?.addEventListener('abort', onAbort, { once: true });
		});
	}

	/**
	 * Normalise Gemini's `usageMetadata` into the neutral {@link AgentUsage}.
	 * `candidatesTokenCount` is the generated-output count → `responseTokenCount`.
	 */
	#emitUsage(meta: GenerateContentResponseUsageMetadata): void {
		const details: Array<{ modality: string; tokenCount: number }> = [];
		for (const d of [...(meta.promptTokensDetails ?? []), ...(meta.candidatesTokensDetails ?? [])]) {
			if (d && d.modality != null) {
				details.push({ modality: String(d.modality), tokenCount: d.tokenCount ?? 0 });
			}
		}
		const usage: AgentUsage = {
			promptTokenCount: meta.promptTokenCount,
			responseTokenCount: meta.candidatesTokenCount,
			totalTokenCount: meta.totalTokenCount,
			cachedContentTokenCount: meta.cachedContentTokenCount,
			...(details.length > 0 ? { details } : {})
		};
		this.#emit('usage', usage);
	}

	/** A Gemini functionResponse `response` must be a JSON object — wrap scalars. */
	#wrapResult(result: unknown): Record<string, unknown> {
		return typeof result === 'object' && result !== null
			? (result as Record<string, unknown>)
			: { output: result };
	}

	#emit<E extends EventName>(event: E, payload: AgentTransportEventMap[E]): void {
		const set = this.#listeners[event] as Set<(p: AgentTransportEventMap[E]) => void> | undefined;
		if (!set) return;
		for (const h of set) {
			try {
				h(payload);
			} catch (e) {
				console.error(`[GeminiTextTransport] listener for "${event}" threw:`, e);
			}
		}
	}
}
