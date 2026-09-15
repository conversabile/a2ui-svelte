/**
 * Eval-run configuration: which Gemini model, which model family, and the
 * experiment matrix the scenarios sweep. Nothing else — the `Agent` is the
 * harness, `ScriptedModel` the recorder, `agent.debug` the token meter.
 */
import type { AgentModel } from '../src/lib/agent/model';
import type { Extensions } from '../src/lib/core/extensions';
import { GeminiTextModel } from '../src/lib/agent/gemini/text-model';
import { GeminiLiveModel } from '../src/lib/agent/gemini/live-model';
import { withoutAudio } from '../src/lib/agent/forward-model';

/**
 * Which Gemini model family the scenarios drive (`A2UI_EVAL_MODEL_FAMILY`):
 *
 * - `'text'` (default) — `GeminiTextModel`, the request/response loop.
 * - `'live'` — `GeminiLiveModel`, the streaming Live-API socket: the
 *   server runs the tool loop and every turn re-bills the whole session
 *   context, so this is the family the context optimizations exist for.
 *   The session still generates audio (+ output transcription — that is the
 *   realistic production load and its token bill); `withoutAudio` masks the
 *   audio *capabilities* so the `Agent` never starts mic/speaker I/O, which
 *   jsdom cannot provide. Assertions ride the output transcription.
 */
export const EVAL_MODEL_FAMILY = (process.env.A2UI_EVAL_MODEL_FAMILY ?? 'text') as 'text' | 'live';
if (EVAL_MODEL_FAMILY !== 'text' && EVAL_MODEL_FAMILY !== 'live') {
	throw new Error(`Unknown A2UI_EVAL_MODEL_FAMILY "${EVAL_MODEL_FAMILY}" (use "text" or "live")`);
}
export const EVAL_MODEL =
	process.env.A2UI_EVAL_MODEL ??
	(EVAL_MODEL_FAMILY === 'live' ? 'gemini-3.1-flash-live-preview' : 'gemini-3.5-flash');
const API_KEY = process.env.GEMINI_API_KEY;

/**
 * The key, or a thrown error. `pnpm eval` drives a real model and has no
 * meaning without a key, so it fails loudly instead of skipping — the
 * hermetic measurement is its own command (`pnpm eval:hermetic`).
 */
export function requireApiKey(): string {
	if (!API_KEY) {
		throw new Error(
			'GEMINI_API_KEY is not set. `pnpm eval` drives a real Gemini model.\n' +
				'Set it in the environment or in a repo-root `.env`, or run ' +
				'`pnpm eval:hermetic` for the no-network context-cost measurement.'
		);
	}
	return API_KEY;
}

/**
 * Quota survival knobs. A full matrix run sends many conversation turns and
 * exhausts the provider's per-minute quota, after which calls return HTTP 429.
 * The scenarios pace themselves with a gap *between conversation turns*, and
 * the text model absorbs any 429 that still slips through with a single
 * backoff retry.
 *
 *   A2UI_EVAL_TURN_GAP_MS   min gap between conversation turns (default 30000)
 *   A2UI_EVAL_MAX_RETRIES   429 retries before giving up (default 1)
 */
export const EVAL_TURN_GAP_MS = Number(process.env.A2UI_EVAL_TURN_GAP_MS ?? 30_000);
export const EVAL_MAX_RETRIES = Number(process.env.A2UI_EVAL_MAX_RETRIES ?? 1);

/**
 * Task rows on the static fixture (`A2UI_EVAL_TODO_COUNT`, default 6).
 * Surface density is the variable the context optimizations exist for — raise
 * it to measure how each profile's token bill scales. The first six tasks are
 * a fixed seed, so scenario assertions hold at any count ≥ 6.
 */
export const EVAL_TODO_COUNT = Number(process.env.A2UI_EVAL_TODO_COUNT ?? 6);

/** One experimental arm: how the surface + agent are configured. */
export interface EvalProfile {
	name: string;
	/** App-wide extension record (passed to `configureExtensions` before mount). */
	extensions: Partial<Extensions>;
	/** Agent-level compact-JSON flag (prompt + sync payloads). */
	compactSurfaceJson: boolean;
}

/**
 * The experiment matrix. `baseline` is the library's historical configuration
 * (pretty JSON + full surface echo on every tool result) — spelled out
 * explicitly, NOT as `{}`, because `'delta'` is now the shipped default and
 * an empty record would silently turn the control arm into the treatment arm;
 * `optimized` is the low-token configuration ('delta' echo + compact JSON); `bare` removes the echo entirely (spec-strict results) — the
 * maximal-removal arm that probes whether the agent destabilises without
 * post-action feedback.
 */
export const PROFILES: Record<string, EvalProfile> = {
	baseline: {
		name: 'baseline',
		extensions: { toolResultSurfaceEcho: 'full' },
		compactSurfaceJson: false
	},
	optimized: {
		name: 'optimized',
		extensions: { toolResultSurfaceEcho: 'delta' },
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

/**
 * Build the model under test (see {@link EVAL_MODEL_FAMILY}). Inter-turn
 * pacing lives in the scenario file either way; `maxRetries` is the text loop's
 * 429 safety net (the Live socket has no client-side retry — a quota error
 * there fails the scenario, which is itself the signal being measured).
 */
export function makeEvalModel(): AgentModel {
	if (EVAL_MODEL_FAMILY === 'live') {
		return withoutAudio(new GeminiLiveModel({ token: requireApiKey(), model: EVAL_MODEL }));
	}
	return new GeminiTextModel({
		apiKey: requireApiKey(),
		model: EVAL_MODEL,
		maxRetries: EVAL_MAX_RETRIES
	});
}
