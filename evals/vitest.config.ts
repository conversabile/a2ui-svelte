/// <reference types="vitest/config" />
import { createRequire } from 'node:module';
import { sveltekit } from '@sveltejs/kit/vite';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig, loadEnv } from 'vite';

/**
 * Eval-suite config — deliberately separate from the unit-test config
 * (`vite.config.ts`, which only picks up `src/**\/*.test.ts`). Evals drive a
 * REAL model (Gemini text, request/response) against real mounted surfaces and
 * assert on tool results, so they are slow, cost quota, and are inherently
 * non-deterministic. Run them explicitly:
 *
 *   GEMINI_API_KEY=… pnpm eval   # context cost + LLM scenarios; fails without the key
 *   pnpm eval:hermetic           # context cost only — no network, no key
 *
 * `eval:hermetic` gets there by passing vitest a filename filter; `eval` runs
 * every `*.eval.ts` this config includes.
 *
 * Vitest does not surface `.env` files on `process.env` (only `VITE_`-prefixed
 * vars reach `import.meta.env`), and the harness reads `process.env.GEMINI_API_KEY`
 * directly — so load `.env` (empty prefix ⇒ every var, not just `VITE_`) into
 * `process.env` here, without clobbering vars already set on the command line.
 */
const fileEnv = loadEnv(process.env.NODE_ENV ?? 'test', process.cwd(), '');
for (const [key, value] of Object.entries(fileEnv)) {
	if (process.env[key] === undefined) process.env[key] = value;
}

// A scenario waits the inter-turn gap (default 30s) before each of its turns;
// size the per-test budget so that pacing never trips the timeout on its own.
const turnGapMs = Number(process.env.A2UI_EVAL_TURN_GAP_MS ?? 30_000);

/**
 * Absolute path of `ws`'s ESM wrapper (proper named exports, node transport).
 * `ws` is the SDK's dependency, not ours, so under pnpm's strict layout it
 * must be resolved from the SDK's own location; only `ws/package.json` is an
 * exported subpath, so resolve that and take `wrapper.mjs` beside it.
 */
function wsEsmWrapper(): string {
	const here = createRequire(import.meta.url);
	const sdkEntry = here.resolve('@google/genai');
	return createRequire(sdkEntry)
		.resolve('ws/package.json')
		.replace(/package\.json$/, 'wrapper.mjs');
}

export default defineConfig({
	plugins: [sveltekit(), svelteTesting()],
	resolve: {
		alias: [
			// The jsdom environment resolves `browser` export conditions, which
			// hands us @google/genai's web build — its live socket runs on the
			// global WebSocket (undici under Node), and undici's events clash
			// with jsdom's patched Event realm mid-handshake. The evals run in
			// Node, so pin the SDK's node build (ws-backed live socket), and pin
			// `ws` itself to its ESM wrapper — under the browser condition `ws`
			// resolves to a stub with no WebSocket export.
			{ find: /^@google\/genai$/, replacement: '@google/genai/node' },
			{ find: /^ws$/, replacement: wsEsmWrapper() }
		]
	},
	test: {
		environment: 'jsdom',
		server: {
			// The aliases above only apply to modules Vite processes — keep the
			// SDK in the pipeline rather than externalized to Node's resolver.
			deps: { inline: [/@google\/genai/] }
		},
		include: ['evals/**/*.eval.ts'],
		// One model conversation at a time: keeps token accounting attributable
		// and avoids racing a per-key rate limit.
		fileParallelism: false,
		maxConcurrency: 1,
		testTimeout: Math.max(180_000, turnGapMs * 6 + 120_000),
		hookTimeout: 60_000
	}
});
