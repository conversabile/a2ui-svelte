/**
 * Shared plumbing for the eval suite: mounts real surfaces (jsdom), wires the
 * real `Agent` to a real `GeminiTextTransport`, and records everything that
 * crosses the transport boundary (tool calls, tool results, usage reports) so
 * scenarios can assert on outcomes and the report can compare token bills.
 *
 * Everything here is profile-driven: a {@link EvalProfile} bundles the
 * app-wide extension record and the agent-level `compactSurfaceJson` flag,
 * so the same scenario runs unchanged with and without the context
 * optimizations.
 */
import type {
	AgentTransport,
	AgentTransportConnectOptions,
	AgentTransportEventMap,
	AgentUsage,
	TransportCapabilities
} from '../src/lib/agent/transport';
import type { Agent } from '../src/lib/agent/agent.svelte';
import type { Extensions } from '../src/lib/core/extensions';
import { toolRegistry } from '../src/lib/core/registries/tool-registry';
import { actionRegistry } from '../src/lib/core/registries/action-registry';
import { GeminiTextTransport } from '../src/lib/agent/gemini/text-transport';
import { GeminiLiveTransport } from '../src/lib/agent/gemini/live-transport';

/**
 * Which Gemini transport family the scenarios drive (`A2UI_EVAL_TRANSPORT`):
 *
 * - `'text'` (default) — `GeminiTextTransport`, the request/response loop.
 * - `'live'` — `GeminiLiveTransport`, the streaming Live-API socket: the
 *   server runs the tool loop and every turn re-bills the whole session
 *   context, so this is the family the context optimizations exist for.
 *   The session still generates audio (+ output transcription — that is the
 *   realistic production load and its token bill); the harness masks the
 *   audio *capabilities* so the `Agent` never starts mic/speaker I/O, which
 *   jsdom cannot provide. Assertions ride the output transcription.
 */
export const EVAL_TRANSPORT = (process.env.A2UI_EVAL_TRANSPORT ?? 'text') as 'text' | 'live';
if (EVAL_TRANSPORT !== 'text' && EVAL_TRANSPORT !== 'live') {
	throw new Error(`Unknown A2UI_EVAL_TRANSPORT "${EVAL_TRANSPORT}" (use "text" or "live")`);
}
export const EVAL_MODEL =
	process.env.A2UI_EVAL_MODEL ??
	(EVAL_TRANSPORT === 'live' ? 'gemini-3.1-flash-live-preview' : 'gemini-3.5-flash');
export const API_KEY = process.env.GEMINI_API_KEY;

/**
 * Quota survival knobs. A full matrix run sends many conversation turns and
 * exhausts the provider's per-minute quota, after which calls return HTTP 429.
 * We pace the run with a gap *between conversation turns* (`sendAndWait`) and
 * let the transport ride out any 429 that still slips through with a single
 * backoff retry (see `GeminiTextTransport`).
 *
 *   A2UI_EVAL_TURN_GAP_MS   min gap between conversation turns (default 30000)
 *   A2UI_EVAL_MAX_RETRIES   429 retries before giving up (default 1)
 */
export const EVAL_TURN_GAP_MS = Number(process.env.A2UI_EVAL_TURN_GAP_MS ?? 30_000);
export const EVAL_MAX_RETRIES = Number(process.env.A2UI_EVAL_MAX_RETRIES ?? 1);

/**
 * Roster rows on the static fixture (`A2UI_EVAL_STAFF_COUNT`, default 6).
 * Surface density is the variable the context optimizations exist for — raise
 * it to measure how each profile's token bill scales. The first six members
 * are a fixed seed, so scenario assertions hold at any count ≥ 6.
 */
export const EVAL_STAFF_COUNT = Number(process.env.A2UI_EVAL_STAFF_COUNT ?? 6);

/** One experimental arm: how the surface + agent are configured. */
export interface EvalProfile {
	name: string;
	/** App-wide extension record (passed to `configureExtensions` before mount). */
	extensions: Partial<Extensions>;
	/** Agent-level compact-JSON flag (prompt + sync payloads). */
	compactSurfaceJson: boolean;
}

/**
 * The experiment matrix. `baseline` is the library's historical default
 * (pretty JSON + full surface echo on every tool result); `optimized` is the
 * context-economy configuration ('changed' echo + compact JSON); `bare` removes
 * the echo entirely (spec-strict results) — the maximal-removal arm that
 * probes whether the agent destabilises without post-action feedback.
 */
export const PROFILES: Record<string, EvalProfile> = {
	baseline: { name: 'baseline', extensions: {}, compactSurfaceJson: false },
	optimized: {
		name: 'optimized',
		extensions: { toolResultSurfaceEcho: 'changed' },
		compactSurfaceJson: true
	},
	bare: {
		name: 'bare',
		extensions: { toolResultSurfaceEcho: 'none' },
		compactSurfaceJson: true
	}
};

/** Profiles selected for this run (comma-separated env filter, default all). */
export function selectedProfiles(defaults: string[] = Object.keys(PROFILES)): EvalProfile[] {
	const filter = process.env.A2UI_EVAL_PROFILES?.split(',').map((s) => s.trim());
	return (filter ?? defaults).map((n) => {
		const p = PROFILES[n];
		if (!p) throw new Error(`Unknown eval profile "${n}"`);
		return p;
	});
}

/** Both registries are module-global — reset between scenarios. */
export function clearRegistries(): void {
	for (const t of toolRegistry.getDeclarations()) toolRegistry.unregister(t.name);
	for (const id of actionRegistry.listActions()) actionRegistry.unregister(id);
}

type EventName = keyof AgentTransportEventMap;

/**
 * Capability mask for running an audio transport headless (jsdom has no
 * mic/speaker): presents the inner transport with `'audio'` stripped from the
 * input/output modalities and without `sendAudioChunk`, so the `Agent` — which
 * adapts to capabilities, never identity — runs it as a text-in/text-out
 * streaming session. The Live model still *speaks* (audio generation and its
 * token bill are unchanged — exactly the production load); the audio frames
 * are simply dropped and the output transcription carries the model text.
 */
class HeadlessTextMask implements AgentTransport {
	#inner: AgentTransport;

	constructor(inner: AgentTransport) {
		this.#inner = inner;
		if (typeof inner.sendContextUpdate === 'function') {
			this.sendContextUpdate = (text: string) => inner.sendContextUpdate!(text);
		}
		if (typeof inner.sendUserAction === 'function') {
			this.sendUserAction = ((a) => inner.sendUserAction!(a)) as AgentTransport['sendUserAction'];
		}
	}

	get capabilities(): TransportCapabilities {
		const caps = this.#inner.capabilities;
		return {
			...caps,
			input: caps.input.filter((m) => m !== 'audio'),
			output: caps.output.filter((m) => m !== 'audio')
		};
	}
	connect(opts: AgentTransportConnectOptions) {
		return this.#inner.connect(opts);
	}
	sendText(text: string) {
		this.#inner.sendText(text);
	}
	sendToolResult(callId: string, name: string, result: unknown) {
		this.#inner.sendToolResult(callId, name, result);
	}
	sendContextUpdate?: (text: string) => void;
	sendUserAction?: AgentTransport['sendUserAction'];
	on<E extends EventName>(event: E, handler: (p: AgentTransportEventMap[E]) => void) {
		return this.#inner.on(event, handler);
	}
	close() {
		this.#inner.close();
	}
}

/**
 * Build the transport under test (see {@link EVAL_TRANSPORT}). Inter-turn
 * pacing lives in the harness either way; `maxRetries` is the text loop's
 * 429 safety net (the Live socket has no client-side retry — a quota error
 * there fails the scenario, which is itself the signal being measured).
 */
export function makeEvalTransport(): AgentTransport {
	if (EVAL_TRANSPORT === 'live') {
		return new HeadlessTextMask(
			new GeminiLiveTransport({ token: API_KEY!, model: EVAL_MODEL })
		);
	}
	return new GeminiTextTransport({
		apiKey: API_KEY!,
		model: EVAL_MODEL,
		maxRetries: EVAL_MAX_RETRIES
	});
}

/**
 * Transparent recorder around any {@link AgentTransport}. Optional contract
 * members are only exposed when the inner transport implements them, so the
 * `Agent`'s capability/feature detection behaves exactly as it would against
 * the bare transport.
 */
export class RecordingTransport implements AgentTransport {
	readonly inner: AgentTransport;
	toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
	toolResults: Array<{ name: string; result: unknown }> = [];
	usageReports: AgentUsage[] = [];
	errors: string[] = [];
	closes: string[] = [];
	modelText = '';
	turnCompletes = 0;

	constructor(inner: AgentTransport) {
		this.inner = inner;
		inner.on('tool-call', (p) => {
			for (const c of p.calls) this.toolCalls.push({ name: c.name, args: c.args });
		});
		inner.on('usage', (u) => this.usageReports.push(u));
		inner.on('error', (e) => this.errors.push(e.message));
		inner.on('close', (e) => this.closes.push(e.reason ?? ''));
		inner.on('text-out', (p) => (this.modelText += p.text));
		inner.on('turn-complete', () => this.turnCompletes++);
		if (typeof inner.sendContextUpdate === 'function') {
			this.sendContextUpdate = (text: string) => inner.sendContextUpdate!(text);
		}
		if (typeof inner.sendUserAction === 'function') {
			this.sendUserAction = ((a) => inner.sendUserAction!(a)) as AgentTransport['sendUserAction'];
		}
		if (typeof inner.sendAudioChunk === 'function') {
			this.sendAudioChunk = (b64: string) => inner.sendAudioChunk!(b64);
		}
	}

	get capabilities() {
		return this.inner.capabilities;
	}
	connect(opts: AgentTransportConnectOptions) {
		return this.inner.connect(opts);
	}
	sendText(text: string) {
		this.inner.sendText(text);
	}
	sendToolResult(callId: string, name: string, result: unknown) {
		this.toolResults.push({ name, result });
		this.inner.sendToolResult(callId, name, result);
	}
	sendContextUpdate?: (text: string) => void;
	sendUserAction?: AgentTransport['sendUserAction'];
	sendAudioChunk?: (base64Pcm16k: string) => void;
	on<E extends EventName>(event: E, handler: (p: AgentTransportEventMap[E]) => void) {
		return this.inner.on(event, handler);
	}
	close() {
		this.inner.close();
	}

	/** Tokens the provider billed across the whole scenario (all loop requests). */
	get billedTokens(): { prompt: number; response: number; requests: number } {
		let prompt = 0;
		let response = 0;
		for (const u of this.usageReports) {
			prompt += u.promptTokenCount ?? 0;
			response += u.responseTokenCount ?? 0;
		}
		return { prompt, response, requests: this.usageReports.length };
	}

	/**
	 * High-water `totalTokenCount` across the session. On Gemini Live this is
	 * the cumulative session figure a `RESOURCE_EXHAUSTED` quota error is
	 * measured against — the live-viability number. 0 on transports that don't
	 * report it.
	 */
	get peakTotalTokens(): number {
		let peak = 0;
		for (const u of this.usageReports) peak = Math.max(peak, u.totalTokenCount ?? 0);
		return peak;
	}
}

/**
 * Wall-clock of the last completed turn — anchors the inter-turn gap so the
 * pacing spans scenarios too (the clock is module-global, not per-agent).
 */
let lastTurnEndedAt = 0;

/**
 * How long a streaming (live) turn must stay quiet *after* a `turn-complete`
 * before the harness trusts it. The Live server runs the tool loop itself and
 * can emit a turn boundary between the tool call and the continuation pass —
 * returning on the first `turn-complete` would run the scenario's `verify()`
 * mid-loop. Request/response transports complete the whole loop before their
 * single `turn-complete`, so they skip the quiesce window.
 */
export const EVAL_QUIESCE_MS = Number(process.env.A2UI_EVAL_QUIESCE_MS ?? 4_000);

/**
 * Send one user turn and wait until the transport completes it (the
 * request/response loop may take several tool-call round trips). Returns the
 * turn's wall-clock duration (excludes the pre-turn pacing gap). Rejects on
 * transport error, close, or timeout.
 *
 * Before sending, it waits out the remainder of {@link EVAL_TURN_GAP_MS} since
 * the previous turn finished, capping the request rate to stay under the
 * provider's per-minute quota.
 */
export async function sendAndWait(
	agent: Agent,
	rec: RecordingTransport,
	text: string,
	timeoutMs = 150_000
): Promise<number> {
	// Pace consecutive turns (see EVAL_TURN_GAP_MS). The very first turn of the
	// run doesn't wait (lastTurnEndedAt === 0).
	const sinceLast = Date.now() - lastTurnEndedAt;
	if (lastTurnEndedAt > 0 && sinceLast < EVAL_TURN_GAP_MS) {
		await new Promise((r) => setTimeout(r, EVAL_TURN_GAP_MS - sinceLast));
	}

	const quiesceMs = agent.capabilities.streaming ? EVAL_QUIESCE_MS : 0;
	const before = rec.turnCompletes;
	const errBefore = rec.errors.length;
	const closeBefore = rec.closes.length;
	const start = Date.now();
	// Activity fingerprint for the quiesce window: any new tool call, turn
	// boundary, or transcript text resets the quiet clock.
	const activity = () => `${rec.turnCompletes}:${rec.toolCalls.length}:${rec.modelText.length}`;
	let lastActivity = activity();
	let lastActivityAt = Date.now();
	agent.sendTextMessage(text);
	for (;;) {
		if (rec.errors.length > errBefore) {
			lastTurnEndedAt = Date.now();
			throw new Error(`Transport error during "${text}": ${rec.errors.slice(errBefore).join('; ')}`);
		}
		if (rec.closes.length > closeBefore) {
			lastTurnEndedAt = Date.now();
			throw new Error(
				`Transport closed during "${text}": ${rec.closes.slice(closeBefore).join('; ') || '(no reason)'}`
			);
		}
		const now = Date.now();
		const cur = activity();
		if (cur !== lastActivity) {
			lastActivity = cur;
			lastActivityAt = now;
		}
		if (rec.turnCompletes > before && now - lastActivityAt >= quiesceMs) {
			lastTurnEndedAt = now;
			return now - start;
		}
		if (now - start > timeoutMs) {
			lastTurnEndedAt = now;
			throw new Error(`Timed out (${timeoutMs}ms) waiting for turn-complete after: "${text}"`);
		}
		await new Promise((r) => setTimeout(r, 150));
	}
}

/** Estimated tokens at the library's standard 4-chars/token heuristic. */
export function estTokens(chars: number): number {
	return Math.ceil(chars / 4);
}
