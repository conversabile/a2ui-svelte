import type { VoiceUsage } from './transport';

/**
 * Voice-session debug telemetry.
 *
 * A live voice session can quietly accumulate an enormous token bill: the whole
 * serialized surface is embedded in the system prompt, and (with the
 * `toolResultExtras` extension) **every tool result echoes the full surface
 * again** — both re-billed each turn. On a dense surface (a shift planner with
 * hundreds of inputs) one batch edit can push a single turn past a hundred
 * thousand tokens and trip a provider `RESOURCE_EXHAUSTED` quota error, with no
 * built-in signal as to why.
 *
 * `VoiceDebugStats` makes that visible. It tracks two things:
 *
 *  1. **Exact outbound byte sizes**, per category — the system prompt, tool
 *     declarations, silent context updates, tool results, text turns, and audio.
 *     These are measured locally (no estimation) the moment the agent sends
 *     them, so the bloat is visible *before* the provider ever responds.
 *  2. **Authoritative token usage** reported back by the provider (Gemini Live's
 *     `usageMetadata`), folded in via the transport's `'usage'` event — the real
 *     number the quota is measured against.
 *
 * The class is reactive (`$state`), so a host can bind a debug box straight to
 * an instance — see `<VoiceShell debug>`. Measurement is cheap (string length +
 * a capped event ring), so the agent keeps one always-on and exposes it as
 * `agent.debug`; rendering it is opt-in.
 */

/** A live API category whose outbound payloads we size. */
export type DebugOutboundKind =
	| 'system-prompt'
	| 'tools'
	| 'context-update'
	| 'tool-result'
	| 'text'
	| 'user-action'
	| 'audio-out';

/** A live API category we receive. */
export type DebugInboundKind = 'audio-in' | 'usage';

/** Running totals for one payload category. */
export interface DebugPayloadStat {
	/** How many payloads of this kind have been sent/received. */
	count: number;
	/** Cumulative byte size (UTF-8) across all of them. */
	bytes: number;
	/** Byte size of the most recent one. */
	lastBytes: number;
	/** Cumulative estimated tokens (text categories only; 0 for audio). */
	estTokens: number;
}

/** One entry in the rolling event log a debug box can render as a feed. */
export interface DebugEvent {
	/** `Date.now()` when recorded. */
	t: number;
	dir: 'out' | 'in';
	kind: DebugOutboundKind | DebugInboundKind;
	bytes?: number;
	estTokens?: number;
	/** Short human note (e.g. tool name, or the provider total at this point). */
	note?: string;
}

const TEXT_KINDS = new Set<DebugOutboundKind>([
	'system-prompt',
	'tools',
	'context-update',
	'tool-result',
	'text',
	'user-action'
]);

function utf8Bytes(s: string): number {
	// Cheap, dependency-free UTF-8 byte count (TextEncoder is fine but allocates).
	if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
	return unescape(encodeURIComponent(s)).length;
}

function emptyStat(): DebugPayloadStat {
	return { count: 0, bytes: 0, lastBytes: 0, estTokens: 0 };
}

export interface VoiceDebugStatsOptions {
	/**
	 * Average characters per token used for the rough byte→token estimate.
	 * Default 4 (the common English-prose heuristic). The serialized surface
	 * JSON here is id-heavy (long hyphenated component ids that subword-split
	 * hard), so its real token count tends to run *above* this estimate —
	 * treat the estimate as a floor. Where the provider reports real usage
	 * (`usage`), that supersedes the estimate entirely.
	 */
	charsPerToken?: number;
	/** Max events kept in the rolling log. Default 50. */
	maxEvents?: number;
}

export class VoiceDebugStats {
	/** Outbound payload sizes, keyed by category. Reactive. */
	outbound = $state<Record<DebugOutboundKind, DebugPayloadStat>>({
		'system-prompt': emptyStat(),
		tools: emptyStat(),
		'context-update': emptyStat(),
		'tool-result': emptyStat(),
		text: emptyStat(),
		'user-action': emptyStat(),
		'audio-out': emptyStat()
	});

	/** Inbound payload sizes (audio we receive). Reactive. */
	inbound = $state<Record<DebugInboundKind, DebugPayloadStat>>({
		'audio-in': emptyStat(),
		usage: emptyStat()
	});

	/** Number of registered tool declarations at connect time. */
	toolCount = $state(0);

	/**
	 * Provider-reported usage. `last` is the most recent report; `peakTotal`
	 * tracks the high-water `totalTokenCount` (= the running session total when
	 * the provider reports cumulatively, as Gemini Live does); `reports` counts
	 * how many usage messages arrived; `sumResponseTokens` accumulates the
	 * per-report response counts.
	 */
	usage = $state<{
		last: VoiceUsage | null;
		peakTotal: number;
		reports: number;
		sumResponseTokens: number;
	}>({ last: null, peakTotal: 0, reports: 0, sumResponseTokens: 0 });

	/** Rolling event log, newest last. Reactive. */
	events = $state<DebugEvent[]>([]);

	/**
	 * Sum of every outbound text/JSON payload's estimated tokens — what *we*
	 * pushed into the model's context (system prompt + tool results + context
	 * syncs + text). The single most telling number for this class of bug.
	 */
	estOutboundTokens = $derived(
		(Object.keys(this.outbound) as DebugOutboundKind[]).reduce(
			(sum, k) => sum + this.outbound[k].estTokens,
			0
		)
	);

	/** Total bytes ever sent (all categories, incl. audio). */
	totalOutboundBytes = $derived(
		(Object.keys(this.outbound) as DebugOutboundKind[]).reduce(
			(sum, k) => sum + this.outbound[k].bytes,
			0
		)
	);

	#charsPerToken: number;
	#maxEvents: number;

	constructor(opts: VoiceDebugStatsOptions = {}) {
		this.#charsPerToken = opts.charsPerToken ?? 4;
		this.#maxEvents = opts.maxEvents ?? 50;
	}

	/** Rough byte→token estimate. See `charsPerToken`. */
	estimateTokens(input: string | number): number {
		const len = typeof input === 'number' ? input : input.length;
		return Math.ceil(len / this.#charsPerToken);
	}

	/**
	 * Record an outbound payload. `payload` may be a pre-serialized string or
	 * any JSON-serialisable value (tool results are objects). Audio chunks pass
	 * their base64 string; only their byte size is tracked (no token estimate).
	 */
	recordOutbound(kind: DebugOutboundKind, payload: unknown, note?: string): void {
		const text =
			typeof payload === 'string' ? payload : safeStringify(payload);
		const bytes = kind === 'audio-out' ? base64Bytes(text) : utf8Bytes(text);
		const estTokens = TEXT_KINDS.has(kind) ? this.estimateTokens(text.length) : 0;
		const stat = this.outbound[kind];
		stat.count += 1;
		stat.bytes += bytes;
		stat.lastBytes = bytes;
		stat.estTokens += estTokens;
		// Audio is high-volume; keep its running total but don't flood the log.
		if (kind !== 'audio-out') {
			this.#push({ t: Date.now(), dir: 'out', kind, bytes, estTokens, note });
		}
	}

	/** Record an inbound audio chunk (byte size only). */
	recordInboundAudio(base64: string): void {
		const bytes = base64Bytes(base64);
		const stat = this.inbound['audio-in'];
		stat.count += 1;
		stat.bytes += bytes;
		stat.lastBytes = bytes;
		// Audio-in is high-volume; don't flood the event log with every chunk.
	}

	/** Fold in an authoritative provider usage report. */
	recordUsage(u: VoiceUsage): void {
		this.usage.last = u;
		this.usage.reports += 1;
		this.usage.sumResponseTokens += u.responseTokenCount ?? 0;
		if ((u.totalTokenCount ?? 0) > this.usage.peakTotal) {
			this.usage.peakTotal = u.totalTokenCount ?? 0;
		}
		const stat = this.inbound.usage;
		stat.count += 1;
		this.#push({
			t: Date.now(),
			dir: 'in',
			kind: 'usage',
			note: `total ${u.totalTokenCount ?? '?'} (prompt ${u.promptTokenCount ?? '?'} / resp ${u.responseTokenCount ?? '?'})`
		});
	}

	/** Clear everything — call when a session resets. */
	reset(): void {
		for (const k of Object.keys(this.outbound) as DebugOutboundKind[]) {
			this.outbound[k] = emptyStat();
		}
		for (const k of Object.keys(this.inbound) as DebugInboundKind[]) {
			this.inbound[k] = emptyStat();
		}
		this.toolCount = 0;
		this.usage = { last: null, peakTotal: 0, reports: 0, sumResponseTokens: 0 };
		this.events = [];
	}

	#push(e: DebugEvent): void {
		const next = [...this.events, e];
		if (next.length > this.#maxEvents) next.splice(0, next.length - this.#maxEvents);
		this.events = next;
	}
}

function safeStringify(v: unknown): string {
	try {
		return JSON.stringify(v) ?? String(v);
	} catch {
		return String(v);
	}
}

/** Decoded byte size of a base64 string (without allocating the buffer). */
function base64Bytes(b64: string): number {
	const len = b64.length;
	if (len === 0) return 0;
	let padding = 0;
	if (b64.charCodeAt(len - 1) === 61 /* '=' */) padding++;
	if (b64.charCodeAt(len - 2) === 61) padding++;
	return Math.floor((len * 3) / 4) - padding;
}

/** Human-friendly byte size, e.g. `206.1 KB`. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Human-friendly token count, e.g. `52.8k`. */
export function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	return `${(tokens / 1000).toFixed(1)}k`;
}
