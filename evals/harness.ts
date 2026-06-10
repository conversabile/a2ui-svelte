/**
 * Shared plumbing for the eval suite: mounts real surfaces (jsdom), wires the
 * real `Agent` to a real `GeminiTextTransport`, and records everything that
 * crosses the transport boundary (tool calls, tool results, usage reports) so
 * scenarios can assert on outcomes and the report can compare token bills.
 *
 * Everything here is profile-driven: a {@link EvalProfile} bundles the
 * per-surface extension options and the agent-level `compactSurfaceJson` flag,
 * so the same scenario runs unchanged with and without the context
 * optimizations.
 */
import type {
	AgentTransport,
	AgentTransportConnectOptions,
	AgentTransportEventMap,
	AgentUsage
} from '../src/lib/agent/transport';
import type { Agent } from '../src/lib/agent/agent.svelte';
import type { ExtensionOptions } from '../src/lib/core/extensions';
import { toolRegistry } from '../src/lib/core/registries/tool-registry';
import { actionRegistry } from '../src/lib/core/registries/action-registry';

export const EVAL_MODEL = process.env.A2UI_EVAL_MODEL ?? 'gemini-3.5-flash';
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

/** One experimental arm: how the surface + agent are configured. */
export interface EvalProfile {
	name: string;
	/** Per-surface extension flags (merged over ALL_EXTRAS by the surface). */
	options: Partial<ExtensionOptions>;
	/** Agent-level compact-JSON flag (prompt + sync payloads). */
	compactSurfaceJson: boolean;
}

/**
 * The experiment matrix. `baseline` is the library's historical default
 * (pretty JSON + full surface echo on every tool result); `optimized` is the
 * context-economy configuration ('diff' echo + compact JSON); `bare` removes
 * the echo entirely (spec-strict results) — the maximal-removal arm that
 * probes whether the agent destabilises without post-action feedback.
 */
export const PROFILES: Record<string, EvalProfile> = {
	baseline: { name: 'baseline', options: {}, compactSurfaceJson: false },
	optimized: {
		name: 'optimized',
		options: { toolResultExtras: 'diff' },
		compactSurfaceJson: true
	},
	bare: {
		name: 'bare',
		options: { toolResultExtras: false },
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

/** jsdom lacks `CSS.escape` (used by the highlight/reveal helpers). */
export function stubJsdomGaps(): void {
	const g = globalThis as Record<string, unknown>;
	if (typeof g.CSS === 'undefined') g.CSS = { escape: (s: string) => s };
	if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
		Element.prototype.scrollIntoView = () => {};
	}
}

type EventName = keyof AgentTransportEventMap;

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
	modelText = '';
	turnCompletes = 0;

	constructor(inner: AgentTransport) {
		this.inner = inner;
		inner.on('tool-call', (p) => {
			for (const c of p.calls) this.toolCalls.push({ name: c.name, args: c.args });
		});
		inner.on('usage', (u) => this.usageReports.push(u));
		inner.on('error', (e) => this.errors.push(e.message));
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
}

/**
 * Wall-clock of the last completed turn — anchors the inter-turn gap so the
 * pacing spans scenarios too (the clock is module-global, not per-agent).
 */
let lastTurnEndedAt = 0;

/**
 * Send one user turn and wait until the transport completes it (the
 * request/response loop may take several tool-call round trips). Returns the
 * turn's wall-clock duration (excludes the pre-turn pacing gap). Rejects on
 * transport error or timeout.
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

	const before = rec.turnCompletes;
	const errBefore = rec.errors.length;
	const start = Date.now();
	agent.sendTextMessage(text);
	for (;;) {
		if (rec.errors.length > errBefore) {
			lastTurnEndedAt = Date.now();
			throw new Error(`Transport error during "${text}": ${rec.errors.slice(errBefore).join('; ')}`);
		}
		if (rec.turnCompletes > before) {
			lastTurnEndedAt = Date.now();
			return Date.now() - start;
		}
		if (Date.now() - start > timeoutMs) {
			lastTurnEndedAt = Date.now();
			throw new Error(`Timed out (${timeoutMs}ms) waiting for turn-complete after: "${text}"`);
		}
		await new Promise((r) => setTimeout(r, 150));
	}
}

/** Estimated tokens at the library's standard 4-chars/token heuristic. */
export function estTokens(chars: number): number {
	return Math.ceil(chars / 4);
}
