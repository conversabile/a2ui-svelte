import type {
	AgentTransport,
	AgentTransportConnectOptions,
	AgentTransportEventMap,
	TransportCapabilities
} from './transport';

/**
 * One programmed model reaction to a single agent turn.
 *
 * The agent sends a turn by calling {@link ScriptedTransport.sendText} — that's
 * the user's typed message, or an XML-tagged `SURFACE_UPDATED` / `USER_ACTION`
 * turn the agent forwards. A reaction with `calls` emits them as one `tool-call`
 * event, then (once every result is back via `sendToolResult`) emits the
 * optional follow-up `text` + `turn-complete`. A reaction with only `text`
 * replies immediately.
 */
export interface ScriptedReaction {
	/**
	 * Gate this reaction on the turn text. A string matches by substring, a
	 * RegExp by `.test()`. Omit to match the next turn unconditionally
	 * (positional scripting). The reaction at the head of the queue is consumed
	 * only when its matcher matches; a turn that doesn't match the head (e.g. a
	 * forwarded surface-sync turn) gets a bare `turn-complete` and leaves the
	 * queue untouched.
	 */
	on?: string | RegExp;
	/** Tool calls to emit, as a single `tool-call` event (parallel calls). */
	calls?: Array<{ name: string; args?: Record<string, unknown> }>;
	/** Model reply text, emitted as `text-out` before `turn-complete`. */
	text?: string;
}

type EventName = keyof AgentTransportEventMap;

/**
 * Deterministic, model-free {@link AgentTransport} for CI. Drives the neutral
 * `Agent` with a queue of programmed reactions instead of a live model — no
 * network, no SDK. It advertises the **request/response text profile** (the same
 * capabilities a real text transport like `GeminiTextTransport` reports), so the
 * agent exercises the non-streaming code paths (no poll loop, no barge-in gate,
 * client-owned history) exactly as it would against a real text model.
 *
 * Tests push reactions (constructor or {@link pushReaction}), drive the agent
 * (`sendTextMessage`, a `userActionBus` emit, …), and assert on the resulting
 * surface state and on what reached the transport (`textsSent`, `toolResults`).
 */
export class ScriptedTransport implements AgentTransport {
	/** The connect options the agent assembled — for test assertions. */
	connectOpts: AgentTransportConnectOptions | null = null;
	/** Every text turn the agent sent (user messages + forwarded event turns). */
	textsSent: string[] = [];
	/** Every tool result the agent replied with. */
	toolResults: Array<{ id: string; name: string; result: unknown }> = [];
	closed = false;

	#reactions: ScriptedReaction[];
	#listeners: { [E in EventName]?: Set<(p: AgentTransportEventMap[E]) => void> } = {};
	#turn = 0;
	// In-flight tool-call bookkeeping: how many results are still outstanding,
	// and the follow-up text to emit once they're all in.
	#pendingCount = 0;
	#pendingFollowupText: string | undefined;

	constructor(reactions: ScriptedReaction[] = []) {
		this.#reactions = [...reactions];
	}

	/** Request/response text profile — identical to a real text transport's. */
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

	/** Queue another reaction (FIFO). Handy for multi-turn scripts. */
	pushReaction(reaction: ScriptedReaction): void {
		this.#reactions.push(reaction);
	}

	async connect(opts: AgentTransportConnectOptions): Promise<void> {
		this.connectOpts = opts;
		this.closed = false;
	}

	sendText(text: string): void {
		if (this.closed) return;
		this.textsSent.push(text);
		this.#turn += 1;

		const head = this.#reactions[0];
		const matches =
			head !== undefined &&
			(head.on === undefined ||
				(typeof head.on === 'string' ? text.includes(head.on) : head.on.test(text)));

		if (!matches) {
			// No scripted reaction for this turn (e.g. a forwarded surface-sync /
			// userAction turn). Close it out so the agent doesn't hang on 'thinking'.
			queueMicrotask(() => {
				if (!this.closed) this.#emit('turn-complete', {} as never);
			});
			return;
		}

		this.#reactions.shift();
		this.#react(head);
	}

	sendToolResult(callId: string, name: string, result: unknown): void {
		this.toolResults.push({ id: callId, name, result });
		if (this.#pendingCount <= 0) return;
		this.#pendingCount -= 1;
		if (this.#pendingCount > 0) return;
		// Every result for this batch is in — emit the follow-up reply.
		const followup = this.#pendingFollowupText;
		this.#pendingFollowupText = undefined;
		queueMicrotask(() => {
			if (this.closed) return;
			if (followup) this.#emit('text-out', { text: followup });
			this.#emit('turn-complete', {} as never);
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
		this.closed = true;
	}

	#react(reaction: ScriptedReaction): void {
		const turn = this.#turn;
		queueMicrotask(() => {
			if (this.closed) return;
			if (reaction.calls && reaction.calls.length > 0) {
				this.#pendingCount = reaction.calls.length;
				this.#pendingFollowupText = reaction.text;
				this.#emit('tool-call', {
					calls: reaction.calls.map((c, i) => ({
						id: `scripted-${turn}-${i}`,
						name: c.name,
						args: c.args ?? {}
					}))
				});
				// turn-complete is deferred to sendToolResult once all results land.
				return;
			}
			if (reaction.text) this.#emit('text-out', { text: reaction.text });
			this.#emit('turn-complete', {} as never);
		});
	}

	#emit<E extends EventName>(event: E, payload: AgentTransportEventMap[E]): void {
		const set = this.#listeners[event] as Set<(p: AgentTransportEventMap[E]) => void> | undefined;
		if (!set) return;
		for (const h of set) {
			try {
				h(payload);
			} catch (e) {
				console.error(`[ScriptedTransport] listener for "${event}" threw:`, e);
			}
		}
	}
}
