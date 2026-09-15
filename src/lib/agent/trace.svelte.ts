/**
 * Per-turn latency trace for an agent session.
 *
 * `AgentDebugStats` answers "what did this turn cost in tokens"; this answers
 * "where did the time go". The agent opens one {@link TraceTurn} per model
 * turn and fills it with ordered spans:
 *
 *  - `thinking`   — a response is expected and nothing has come back yet
 *                   (the wait before the first token, and the wait after each
 *                   tool result while the model decides what to do next);
 *  - `generating` — text/audio is arriving;
 *  - `tool`       — one tool invocation, with its arguments, its result, how
 *                   long it ran, and the byte size of the payload sent back.
 *
 * `<AgentShell debug>` renders one timeline per turn, inline between the user
 * message and the agent's answer.
 *
 * This is a development aid. Tool arguments, results and echoes are stored as
 * JSON **strings**, never as references, so the trace can never keep a live
 * surface tree alive; the turn ring (`maxTurns`, default 20) is what bounds
 * the total. The strings are kept whole so the panel can hand a developer the
 * exact payload — a 32 KB echo costs 32 KB of string per call, and
 * `maxDetailChars` caps that for anyone who would rather not pay it.
 * Recording is off when the agent's `debug` option is `false`; the instance
 * still exists and stays empty.
 */

/** What a span measures. */
export type TraceSpanKind = 'thinking' | 'generating' | 'tool';

/** The detail a `'tool'` span carries, all of it renderable as-is. */
export interface TraceToolDetail {
	/** Arguments the model passed, pretty JSON. */
	args: string;
	/** What the tool returned, pretty JSON. `null` while running. */
	output: string | null;
	/** `'error'` when the tool threw or any per-element result failed. */
	status: 'success' | 'error' | null;
	/**
	 * Byte size of the result payload actually sent to the model — the tool's
	 * own result plus the surface echo, which is usually the bulk of it.
	 */
	sentBytes: number | null;
	/**
	 * The surface echo the agent attached to the result, pretty JSON.
	 * `null` when the extension is off or nothing changed.
	 * Without this a developer sees a 300-byte result labelled 32 KB and has
	 * no way to find out what the other 31.7 KB were.
	 */
	echo: string | null;
	/**
	 * Per-key byte sizes of that echo (`surfaceDelta`, `updatedSurface`,
	 * `updatedContext`, `availableElementIds`), largest first — so the key
	 * responsible for the size is named even when `echo` is truncated.
	 */
	echoParts: Array<{ key: string; bytes: number }>;
}

/** One measured segment of a turn. */
export interface TraceSpan {
	kind: TraceSpanKind;
	/** Tool name on a `'tool'` span; otherwise the kind. */
	name: string;
	startedAt: number;
	/** `null` while the span is still running. */
	endedAt: number | null;
	/** Present only on `'tool'` spans. */
	tool: TraceToolDetail | null;
}

/** One model turn: everything between the user's input and `turn-complete`. */
export interface TraceTurn {
	/** Monotonic per-session id. */
	id: number;
	/**
	 * Position in `agent.transcript` the timeline belongs at — the transcript
	 * length when the turn opened, so it renders after the user message that
	 * started it and before the agent's reply.
	 */
	index: number;
	startedAt: number;
	/** `null` while the turn is still running. */
	endedAt: number | null;
	spans: TraceSpan[];
}

export interface AgentTraceOptions {
	/** Record anything at all. Default `true`. */
	enabled?: boolean;
	/** Turns kept before the oldest is dropped. Default 20. */
	maxTurns?: number;
	/**
	 * Optional cap on a stored args/output/echo JSON string. Unset (the
	 * default) stores them whole, so the panel's copy button yields the exact
	 * payload — a truncated echo is not something a developer can paste into
	 * an issue or diff. Set a number to trade that for a smaller footprint;
	 * `maxTurns` is what bounds the trace either way.
	 */
	maxDetailChars?: number;
}

export class AgentTrace {
	/** Completed and in-flight turns, oldest first. Reactive. */
	turns = $state<TraceTurn[]>([]);

	#enabled: boolean;
	#maxTurns: number;
	#maxDetailChars: number | null;
	#nextId = 1;
	// The live turn/span, held as the *proxied* objects read back out of
	// `turns` — mutating the raw objects we pushed would not notify.
	#turn: TraceTurn | null = null;
	#span: TraceSpan | null = null;

	constructor(opts: AgentTraceOptions = {}) {
		this.#enabled = opts.enabled ?? true;
		this.#maxTurns = opts.maxTurns ?? 20;
		this.#maxDetailChars = opts.maxDetailChars ?? null;
	}

	/** Whether this trace records. */
	get enabled(): boolean {
		return this.#enabled;
	}

	/** The turn currently being recorded, if any. */
	get openTurn(): TraceTurn | null {
		return this.#turn;
	}

	/** Turns whose timeline renders at transcript position `index`. */
	turnsAt(index: number): TraceTurn[] {
		return this.turns.filter((t) => t.index === index);
	}

	/**
	 * Open a turn at transcript position `index` (the transcript length at the
	 * moment the user's input was dispatched or transcribed). Any turn still
	 * open is closed first — a turn that never reported completion should not
	 * swallow the next one.
	 */
	startTurn(index: number): void {
		if (!this.#enabled) return;
		this.endTurn();
		const turn: TraceTurn = {
			id: this.#nextId++,
			index,
			startedAt: Date.now(),
			endedAt: null,
			spans: []
		};
		this.turns.push(turn);
		if (this.turns.length > this.#maxTurns) {
			this.turns.splice(0, this.turns.length - this.#maxTurns);
		}
		this.#turn = this.turns[this.turns.length - 1];
		this.#openSpan('thinking', 'thinking');
	}

	/**
	 * Open a turn at `index` if none is running — model activity on a turn
	 * nobody opened (a proactive push, or audio that beats the transcription).
	 * Never moves a turn that is already running.
	 */
	ensureTurn(index: number): TraceTurn | null {
		if (!this.#enabled) return null;
		if (!this.#turn) this.startTurn(index);
		return this.#turn;
	}

	/**
	 * A user message just landed at transcript position `index - 1`. Opens the
	 * turn, or moves the running one below that message.
	 *
	 * The move matters on a live voice API: the model's audio starts before the
	 * user's speech transcription arrives, so without it the turn's timeline
	 * would render above the message that caused it. Only the *running* turn
	 * moves — a finished timeline stays where it was rendered.
	 */
	noteUserMessage(index: number): void {
		if (!this.#enabled) return;
		if (!this.#turn) this.startTurn(index);
		else if (index > this.#turn.index) this.#turn.index = index;
	}

	/**
	 * The model produced output (a text or audio chunk). Ends the wait and
	 * starts — or continues — the generating span.
	 */
	modelOutput(): void {
		if (!this.#enabled || !this.#turn) return;
		if (this.#span?.kind === 'generating') return;
		this.#openSpan('generating', 'generating');
	}

	/** The model is working again with nothing to show yet (e.g. after a tool). */
	modelThinking(): void {
		if (!this.#enabled || !this.#turn) return;
		if (this.#span?.kind === 'thinking') return;
		this.#openSpan('thinking', 'thinking');
	}

	/**
	 * Start a tool span. Returns the span to hand back to {@link toolEnd} —
	 * `null` when disabled or outside a turn, which `toolEnd` tolerates.
	 */
	toolStart(name: string, args: unknown): TraceSpan | null {
		if (!this.#enabled || !this.#turn) return null;
		this.#openSpan('tool', name);
		const span = this.#span!;
		span.tool = {
			args: this.#json(args),
			output: null,
			status: null,
			sentBytes: null,
			echo: null,
			echoParts: []
		};
		return span;
	}

	/**
	 * Close a tool span. `result` is the tool's own result, before the surface
	 * echo; `echo` is what the agent attached to it. Both are stored as JSON
	 * strings, and `echoParts` names the byte cost per echo key so the size is
	 * attributable at a glance.
	 */
	toolEnd(
		span: TraceSpan | null,
		result: unknown,
		sentBytes: number | null = null,
		echo: Record<string, unknown> | null = null
	): void {
		if (!span || !span.tool) return;
		span.tool.output = this.#json(result);
		span.tool.status = toolResultStatus(result);
		span.tool.sentBytes = sentBytes;
		if (echo && Object.keys(echo).length > 0) {
			span.tool.echo = this.#json(echo);
			span.tool.echoParts = Object.entries(echo)
				.map(([key, value]) => ({ key, bytes: jsonBytes(value) }))
				.sort((a, b) => b.bytes - a.bytes);
		}
		if (span.endedAt == null) span.endedAt = Date.now();
		if (this.#span === span) this.#span = null;
	}

	/** Close the running turn (turn-complete, barge-in, error, stop). */
	endTurn(): void {
		if (!this.#turn) return;
		const now = Date.now();
		if (this.#span && this.#span.endedAt == null) this.#span.endedAt = now;
		// A turn that only ever waited (no output, no tool) leaves a zero-length
		// trailing span behind; drop it so the timeline shows real work only.
		const spans = this.#turn.spans;
		const last = spans[spans.length - 1];
		if (last && last.kind === 'thinking' && last.endedAt === last.startedAt && spans.length > 1) {
			spans.pop();
		}
		this.#turn.endedAt = now;
		this.#turn = null;
		this.#span = null;
	}

	/** Clear everything — call when a session resets. */
	reset(): void {
		this.turns = [];
		this.#turn = null;
		this.#span = null;
		this.#nextId = 1;
	}

	#openSpan(kind: TraceSpanKind, name: string): void {
		const turn = this.#turn!;
		const now = Date.now();
		if (this.#span && this.#span.endedAt == null) this.#span.endedAt = now;
		turn.spans.push({ kind, name, startedAt: now, endedAt: null, tool: null });
		this.#span = turn.spans[turn.spans.length - 1];
	}

	#json(value: unknown): string {
		let text: string;
		try {
			text = JSON.stringify(value, null, 2) ?? String(value);
		} catch {
			text = String(value);
		}
		if (this.#maxDetailChars == null || text.length <= this.#maxDetailChars) return text;
		return `${text.slice(0, this.#maxDetailChars)}\n… truncated (${text.length} chars)`;
	}
}

/**
 * Classify a tool result. Tool results are normalised on `status`: either a
 * top-level `{ status: 'error' }` (the tool threw, or a message was rejected)
 * or a `results` array with one entry per element — one failed element makes
 * the call a failure, because that is what the model has to act on.
 *
 * A bare `{ error }` with no `status` also counts: that is what
 * `toolRegistry.execute` returns today when a registered tool throws.
 */
export function toolResultStatus(result: unknown): 'success' | 'error' {
	if (!result || typeof result !== 'object') return 'success';
	const r = result as Record<string, unknown>;
	if (r.status === 'error') return 'error';
	if (r.status !== 'success' && r.error != null) return 'error';
	if (Array.isArray(r.results)) {
		for (const entry of r.results) {
			if (entry && typeof entry === 'object' && (entry as Record<string, unknown>).status === 'error')
				return 'error';
		}
	}
	return 'success';
}

/** UTF-8 byte size of a value once serialized. */
function jsonBytes(value: unknown): number {
	let text: string;
	try {
		text = JSON.stringify(value) ?? '';
	} catch {
		return 0;
	}
	return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length;
}

/** Elapsed time of a span, using `now` for one still running. */
export function spanDuration(span: TraceSpan, now: number = Date.now()): number {
	return (span.endedAt ?? now) - span.startedAt;
}

/** Elapsed time of a turn, using `now` for one still running. */
export function turnDuration(turn: TraceTurn, now: number = Date.now()): number {
	return (turn.endedAt ?? now) - turn.startedAt;
}

/** Human-friendly duration, e.g. `840 ms` / `2.41 s`. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)} ms`;
	return `${(ms / 1000).toFixed(2)} s`;
}
