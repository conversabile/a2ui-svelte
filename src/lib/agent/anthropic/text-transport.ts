import Anthropic from '@anthropic-ai/sdk';
import type {
	ContentBlock,
	MessageParam,
	Tool,
	ToolUseBlock,
	Usage
} from '@anthropic-ai/sdk/resources/messages';
import type {
	AgentTransport,
	AgentTransportConnectOptions,
	AgentTransportEventMap,
	AgentUsage,
	TransportCapabilities
} from '../transport';

export interface AnthropicTextTransportOptions {
	/**
	 * Anthropic API key, or a function that produces one — resolved once per
	 * `connect()`. Optional when `baseUrl` points at a proxy that injects the
	 * real key server-side (a placeholder is sent instead); required when
	 * calling Anthropic directly. Note: calling Anthropic directly from a
	 * browser exposes the key client-side — the SDK requires the explicit
	 * `dangerouslyAllowBrowser` opt-in (this transport sets it) precisely to
	 * flag that risk; prefer the proxy for anything beyond local development.
	 */
	apiKey?: string | (() => string | Promise<string>);
	/** Claude model (request/response Messages API). Default `'claude-opus-4-8'`. */
	model?: string;
	/**
	 * Override the API endpoint the `@anthropic-ai/sdk` client talks to
	 * (`baseURL`). Point it at a **same-origin proxy** so the real key stays
	 * server-side: the browser sends a placeholder key, your proxy injects the
	 * real `x-api-key` and forwards to `https://api.anthropic.com`. Omit to
	 * call Anthropic directly (`apiKey` is then a real key, exposed client-side).
	 */
	baseUrl?: string;
	/**
	 * `max_tokens` per model turn. Default `16000` — plenty for tool-driving
	 * turns while keeping a sane ceiling (output streams either way).
	 */
	maxTokens?: number;
	/**
	 * Adaptive thinking (`thinking: { type: 'adaptive' }` — the model decides
	 * when and how much to reason). Default `true`; thinking blocks are kept in
	 * the client-owned history so multi-step tool turns stay valid. Set `false`
	 * for models that don't support adaptive thinking (pre-4.6).
	 */
	thinking?: boolean;
	/**
	 * Retries for transient failures (429 / 5xx). Handled by the Anthropic SDK
	 * itself with exponential backoff. Default `2` (the SDK default).
	 */
	maxRetries?: number;
}

type EventName = keyof AgentTransportEventMap;

/**
 * Request/response **text** transport over an Anthropic Claude model, using
 * the official `@anthropic-ai/sdk` (Messages API, streaming). It runs the
 * agentic tool-loop **client-side** and emits the neutral
 * {@link AgentTransportEventMap}, so the shared `Agent` orchestrator drives it
 * with the same code path as every other transport — the difference is
 * captured entirely in {@link capabilities}.
 *
 * `streaming:false` here means "no live bidi session", **not** "no token
 * streaming": output text still streams as `text-out` deltas; the session is
 * just request/response (this transport owns `messages[]` and re-sends them
 * each loop iteration).
 *
 * Assistant turns are appended to history **verbatim** (full content blocks,
 * including thinking blocks and their signatures) — required for tool use
 * with adaptive thinking.
 */
export class AnthropicTextTransport implements AgentTransport {
	#apiKey?: string | (() => string | Promise<string>);
	#model: string;
	#baseUrl?: string;
	#maxTokens: number;
	#thinking: boolean;
	#maxRetries?: number;
	#client: Anthropic | null = null;
	#system = '';
	#tools: Tool[] = [];
	/** Client-owned conversation history (we report `historyOwnership: 'client'`). */
	#messages: MessageParam[] = [];
	#listeners: { [E in EventName]?: Set<(p: AgentTransportEventMap[E]) => void> } = {};
	#closed = false;
	#abort: AbortController | null = null;
	// In-flight tool-call batching: one model turn can carry several tool_use
	// blocks → we surface them as one `tool-call` with N calls; the agent
	// replies with N `sendToolResult`s, which we buffer and send back as a
	// SINGLE `user` message (the tool_result blocks) before re-calling.
	#pendingCount = 0;
	#pendingResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];

	constructor(opts: AnthropicTextTransportOptions = {}) {
		this.#apiKey = opts.apiKey;
		this.#model = opts.model ?? 'claude-opus-4-8';
		this.#baseUrl = opts.baseUrl;
		this.#maxTokens = opts.maxTokens ?? 16000;
		this.#thinking = opts.thinking ?? true;
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
		// Universal {name,description,parameters} → Anthropic {name,description,input_schema}.
		this.#tools = opts.tools.map((t) => ({
			name: t.name,
			description: t.description,
			input_schema: t.parameters as Tool['input_schema']
		}));
		// Seed client-owned history from prior turns (the agent passes these only
		// because we advertise `historyOwnership: 'client'`).
		this.#messages = (opts.history ?? []).map((t) => ({
			role: t.role === 'model' ? 'assistant' : 'user',
			content: t.text
		}));
		const apiKey = typeof this.#apiKey === 'function' ? await this.#apiKey() : this.#apiKey;
		if (!apiKey && !this.#baseUrl) {
			throw new Error(
				'AnthropicTextTransport needs an apiKey (or a baseUrl proxy that injects one server-side).'
			);
		}
		try {
			this.#client = new Anthropic({
				apiKey: apiKey ?? 'proxied-server-side',
				// This is a browser library; the real protection is the baseUrl proxy
				// (see `AnthropicTextTransportOptions.baseUrl`).
				dangerouslyAllowBrowser: true,
				...(this.#baseUrl ? { baseURL: this.#baseUrl } : {}),
				...(this.#maxRetries !== undefined ? { maxRetries: this.#maxRetries } : {})
			});
		} catch (e) {
			throw new Error((e as Error).message ?? 'Failed to construct Anthropic client');
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
			type: 'tool_result',
			tool_use_id: callId,
			content: typeof result === 'string' ? result : JSON.stringify(result)
		});
		if (this.#pendingCount <= 0) return;
		this.#pendingCount -= 1;
		if (this.#pendingCount > 0) return;
		// All results for this batch are in: append them as ONE user message,
		// then re-call the model to continue the loop.
		this.#messages.push({ role: 'user', content: this.#pendingResults });
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
	 * deltas and (if any) its tool calls. With tool calls we stop here and wait
	 * for the results (`sendToolResult` re-enters this); otherwise the turn is
	 * final. The SDK retries rate limits internally (`maxRetries`).
	 */
	async #runTurn(): Promise<void> {
		if (this.#closed || !this.#client) return;
		this.#abort = new AbortController();

		let content: ContentBlock[];
		let stopReason: string | null;
		let usage: Usage | undefined;
		try {
			const stream = this.#client.messages.stream(
				{
					model: this.#model,
					max_tokens: this.#maxTokens,
					system: this.#system,
					messages: this.#messages,
					...(this.#tools.length > 0 ? { tools: this.#tools } : {}),
					...(this.#thinking ? { thinking: { type: 'adaptive' as const } } : {})
				},
				{ signal: this.#abort.signal }
			);
			stream.on('text', (delta) => {
				if (!this.#closed && delta) this.#emit('text-out', { text: delta });
			});
			const final = await stream.finalMessage();
			content = final.content;
			stopReason = final.stop_reason;
			usage = final.usage;
		} catch (e) {
			// An intentional close()/abort isn't an error — swallow it.
			if (this.#closed) return;
			this.#emit('error', {
				message: (e as Error).message ?? 'Anthropic text transport error',
				cause: e
			});
			return;
		}
		if (this.#closed) return;

		if (usage) this.#emitUsage(usage);

		// Append the assistant turn VERBATIM (text + tool_use + thinking blocks
		// with their signatures) — stripping thinking blocks would invalidate the
		// next request when tools and adaptive thinking are combined.
		this.#messages.push({ role: 'assistant', content });

		const toolUses = content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
		if (toolUses.length > 0) {
			this.#pendingCount = toolUses.length;
			this.#pendingResults = [];
			this.#emit('tool-call', {
				calls: toolUses.map((b) => ({
					id: b.id,
					name: b.name,
					args: (b.input ?? {}) as Record<string, unknown>
				}))
			});
			// No turn-complete yet — the loop resumes once results are back.
			return;
		}

		// `pause_turn` (server-side tool pause): resume by re-sending as-is.
		if (stopReason === 'pause_turn') {
			void this.#runTurn();
			return;
		}

		this.#emit('turn-complete', {} as never);
	}

	/**
	 * Normalise Anthropic's `usage` into the neutral {@link AgentUsage}. The
	 * full prompt cost is `input_tokens` + the cache read/creation counts
	 * (Anthropic reports them disjointly); counts are per-turn, not cumulative.
	 */
	#emitUsage(usage: Usage): void {
		const cacheRead = usage.cache_read_input_tokens ?? 0;
		const cacheCreate = usage.cache_creation_input_tokens ?? 0;
		const prompt = usage.input_tokens + cacheRead + cacheCreate;
		const payload: AgentUsage = {
			promptTokenCount: prompt,
			responseTokenCount: usage.output_tokens,
			totalTokenCount: prompt + usage.output_tokens,
			cachedContentTokenCount: cacheRead
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
				console.error(`[AnthropicTextTransport] listener for "${event}" threw:`, e);
			}
		}
	}
}
