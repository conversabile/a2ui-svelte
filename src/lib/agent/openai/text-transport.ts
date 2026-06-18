import OpenAI from 'openai';
import type {
	ChatCompletionChunk,
	ChatCompletionFunctionTool,
	ChatCompletionMessageFunctionToolCall,
	ChatCompletionMessageParam
} from 'openai/resources/chat/completions';
import type { CompletionUsage } from 'openai/resources/completions';
import type {
	AgentTransport,
	AgentTransportConnectOptions,
	AgentTransportEventMap,
	AgentUsage,
	TransportCapabilities
} from '../transport';

export interface OpenAITextTransportOptions {
	/**
	 * OpenAI API key, or a function that produces one — resolved once per
	 * `connect()`. Optional when `baseUrl` points at a proxy that injects the
	 * real key server-side (a placeholder is sent instead); required when
	 * calling OpenAI directly (the key is then exposed client-side — prefer the
	 * proxy outside local development).
	 */
	apiKey?: string | (() => string | Promise<string>);
	/**
	 * OpenAI **text** model (Chat Completions, request/response). Default
	 * `'gpt-5.2'`. Distinct from the Realtime voice model (`gpt-realtime-2`)
	 * used by `OpenAIRealtimeTransport` — this transport speaks the
	 * `chat/completions` API, not the bidi Realtime socket.
	 */
	model?: string;
	/**
	 * Override the API endpoint the `openai` client talks to (`baseURL`).
	 * Point it at a **same-origin proxy** so the real key stays server-side:
	 * the browser sends a placeholder key, your proxy injects the real
	 * `Authorization` header and forwards to `https://api.openai.com/v1`.
	 * Omit to call OpenAI directly.
	 */
	baseUrl?: string;
	/**
	 * Retries for transient failures (429 / 5xx). Handled by the `openai` SDK
	 * itself with exponential backoff. Default `2` (the SDK default).
	 */
	maxRetries?: number;
}

type EventName = keyof AgentTransportEventMap;

/** Accumulator for tool-call deltas streamed across chunks (keyed by index). */
interface PendingToolCall {
	id: string;
	name: string;
	arguments: string;
}

/**
 * Request/response **text** transport over an OpenAI model, using the official
 * `openai` SDK (Chat Completions, streaming). It runs the agentic tool-loop
 * **client-side** and emits the neutral {@link AgentTransportEventMap}, so the
 * shared `Agent` orchestrator drives it with the same code path as every other
 * transport — the difference is captured entirely in {@link capabilities}.
 *
 * `streaming:false` here means "no live bidi session", **not** "no token
 * streaming": output text still streams as `text-out` deltas; the session is
 * just request/response (this transport owns `messages[]` and re-sends them
 * each loop iteration).
 */
export class OpenAITextTransport implements AgentTransport {
	#apiKey?: string | (() => string | Promise<string>);
	#model: string;
	#baseUrl?: string;
	#maxRetries?: number;
	#client: OpenAI | null = null;
	#system = '';
	#tools: ChatCompletionFunctionTool[] = [];
	/** Client-owned conversation history, system message excluded (prepended per request). */
	#messages: ChatCompletionMessageParam[] = [];
	#listeners: { [E in EventName]?: Set<(p: AgentTransportEventMap[E]) => void> } = {};
	#closed = false;
	#abort: AbortController | null = null;
	// In-flight tool-call batching: one model turn can request several tool
	// calls → we surface them as one `tool-call` with N calls; the agent replies
	// with N `sendToolResult`s, which we buffer and append as N `tool` role
	// messages before re-calling the model.
	#pendingCount = 0;
	#pendingResults: ChatCompletionMessageParam[] = [];

	constructor(opts: OpenAITextTransportOptions = {}) {
		this.#apiKey = opts.apiKey;
		this.#model = opts.model ?? 'gpt-5.2';
		this.#baseUrl = opts.baseUrl;
		this.#maxRetries = opts.maxRetries;
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
		this.#system = opts.systemInstruction;
		// Universal {name,description,parameters} → OpenAI function-tool shape.
		this.#tools = opts.tools.map((t) => ({
			type: 'function' as const,
			function: { name: t.name, description: t.description, parameters: t.parameters }
		}));
		// Seed client-owned history from prior turns (the agent passes these only
		// because we advertise `historyOwnership: 'client'`).
		this.#messages = (opts.history ?? []).map((t) => ({
			role: t.role === 'model' ? ('assistant' as const) : ('user' as const),
			content: t.text
		}));
		const apiKey = typeof this.#apiKey === 'function' ? await this.#apiKey() : this.#apiKey;
		if (!apiKey && !this.#baseUrl) {
			throw new Error(
				'OpenAITextTransport needs an apiKey (or a baseUrl proxy that injects one server-side).'
			);
		}
		try {
			this.#client = new OpenAI({
				apiKey: apiKey ?? 'proxied-server-side',
				// This is a browser library; the real protection is the baseUrl proxy
				// (see `OpenAITextTransportOptions.baseUrl`).
				dangerouslyAllowBrowser: true,
				...(this.#baseUrl ? { baseURL: this.#baseUrl } : {}),
				...(this.#maxRetries !== undefined ? { maxRetries: this.#maxRetries } : {})
			});
		} catch (e) {
			throw new Error((e as Error).message ?? 'Failed to construct OpenAI client');
		}
	}

	sendText(text: string): void {
		if (this.#closed) return;
		this.#messages.push({ role: 'user', content: text });
		void this.#runTurn();
	}

	sendToolResult(callId: string, _name: string, result: unknown): void {
		if (this.#closed) return;
		this.#pendingResults.push({
			role: 'tool',
			tool_call_id: callId,
			content: typeof result === 'string' ? result : JSON.stringify(result)
		});
		if (this.#pendingCount <= 0) return;
		this.#pendingCount -= 1;
		if (this.#pendingCount > 0) return;
		// All results for this batch are in: append them (one `tool` message per
		// call id, as the API requires), then re-call the model.
		this.#messages.push(...this.#pendingResults);
		this.#pendingResults = [];
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
		this.#client = null;
	}

	/**
	 * One pass of the agentic loop: stream a model turn, surface its text
	 * deltas, accumulate tool-call argument deltas, and read the usage chunk
	 * (`stream_options.include_usage`). With tool calls we stop here and wait
	 * for the results (`sendToolResult` re-enters this); otherwise the turn is
	 * final. The SDK retries rate limits internally (`maxRetries`).
	 */
	async #runTurn(): Promise<void> {
		if (this.#closed || !this.#client) return;
		this.#abort = new AbortController();

		let modelText = '';
		const toolCalls = new Map<number, PendingToolCall>();
		let usage: CompletionUsage | undefined;
		try {
			const stream = await this.#client.chat.completions.create(
				{
					model: this.#model,
					messages: [{ role: 'system', content: this.#system }, ...this.#messages],
					...(this.#tools.length > 0 ? { tools: this.#tools } : {}),
					stream: true,
					stream_options: { include_usage: true }
				},
				{ signal: this.#abort.signal }
			);
			for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
				if (this.#closed) return;
				if (chunk.usage) usage = chunk.usage;
				const delta = chunk.choices?.[0]?.delta;
				if (!delta) continue;
				if (delta.content) {
					modelText += delta.content;
					this.#emit('text-out', { text: delta.content });
				}
				for (const tc of delta.tool_calls ?? []) {
					const entry = toolCalls.get(tc.index) ?? { id: '', name: '', arguments: '' };
					if (tc.id) entry.id = tc.id;
					if (tc.function?.name) entry.name += tc.function.name;
					if (tc.function?.arguments) entry.arguments += tc.function.arguments;
					toolCalls.set(tc.index, entry);
				}
			}
		} catch (e) {
			// An intentional close()/abort isn't an error — swallow it.
			if (this.#closed) return;
			this.#emit('error', {
				message: (e as Error).message ?? 'OpenAI text transport error',
				cause: e
			});
			return;
		}
		if (this.#closed) return;

		if (usage) this.#emitUsage(usage);

		if (toolCalls.size > 0) {
			// Record the model turn (text + tool_calls) so the upcoming `tool`
			// result messages are coherent in the client-owned history.
			const ordered = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
			const assistantCalls: ChatCompletionMessageFunctionToolCall[] = ordered.map((c) => ({
				id: c.id,
				type: 'function' as const,
				function: { name: c.name, arguments: c.arguments }
			}));
			this.#messages.push({
				role: 'assistant',
				content: modelText || null,
				tool_calls: assistantCalls
			});

			this.#pendingCount = ordered.length;
			this.#pendingResults = [];
			this.#emit('tool-call', {
				calls: ordered.map((c) => ({
					id: c.id,
					name: c.name,
					args: this.#parseArgs(c.arguments)
				}))
			});
			// No turn-complete yet — the loop resumes once results are back.
			return;
		}

		// Final text turn.
		if (modelText) this.#messages.push({ role: 'assistant', content: modelText });
		this.#emit('turn-complete', {} as never);
	}

	/** Tool-call arguments arrive as a JSON string — parse defensively. */
	#parseArgs(raw: string): Record<string, unknown> {
		if (!raw) return {};
		try {
			const parsed = JSON.parse(raw);
			return typeof parsed === 'object' && parsed !== null
				? (parsed as Record<string, unknown>)
				: {};
		} catch {
			return {};
		}
	}

	/** Normalise OpenAI's `usage` into the neutral {@link AgentUsage} (per-turn counts). */
	#emitUsage(usage: CompletionUsage): void {
		const payload: AgentUsage = {
			promptTokenCount: usage.prompt_tokens,
			responseTokenCount: usage.completion_tokens,
			totalTokenCount: usage.total_tokens,
			cachedContentTokenCount: usage.prompt_tokens_details?.cached_tokens
		};
		this.#emit('usage', payload);
	}

	#emit<E extends EventName>(event: E, payload: AgentTransportEventMap[E]): void {
		const set = this.#listeners[event] as Set<(p: AgentTransportEventMap[E]) => void> | undefined;
		if (!set) return;
		for (const h of set) {
			try {
				h(payload);
			} catch (e) {
				console.error(`[OpenAITextTransport] listener for "${event}" threw:`, e);
			}
		}
	}
}
