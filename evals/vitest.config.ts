/// <reference types="vitest/config" />
import { sveltekit } from '@sveltejs/kit/vite';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vite';

/**
 * Eval-suite config — deliberately separate from the unit-test config
 * (`vite.config.ts`, which only picks up `src/**\/*.test.ts`). Evals drive a
 * REAL model (Gemini text, request/response) against real mounted surfaces and
 * assert on tool results, so they are slow, cost quota, and are inherently
 * non-deterministic. Run them explicitly:
 *
 *   GEMINI_API_KEY=… pnpm eval
 *
 * Without the key the LLM scenarios skip; the hermetic context-cost
 * measurement still runs.
 */
// A scenario waits the inter-turn gap (default 30s) before each of its turns;
// size the per-test budget so that pacing never trips the timeout on its own.
const turnGapMs = Number(process.env.A2UI_EVAL_TURN_GAP_MS ?? 30_000);

export default defineConfig({
	plugins: [sveltekit(), svelteTesting()],
	test: {
		environment: 'jsdom',
		include: ['evals/**/*.eval.ts'],
		// One model conversation at a time: keeps token accounting attributable
		// and avoids racing a per-key rate limit.
		fileParallelism: false,
		maxConcurrency: 1,
		testTimeout: Math.max(180_000, turnGapMs * 6 + 120_000),
		hookTimeout: 60_000
	}
});
