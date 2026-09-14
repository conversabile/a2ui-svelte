/**
 * LLM eval scenarios — a real Gemini model drives real mounted surfaces through
 * the real `Agent`, and we assert on the resulting UI state. Each scenario runs
 * once per profile (baseline / optimized / bare — see `PROFILES` in setup.ts)
 * so the report answers the question: do the context optimizations make the
 * agent unstable?
 *
 * The model family is selectable (`A2UI_EVAL_MODEL_FAMILY=text|live`, see
 * setup.ts): the request/response text loop, or the streaming Live API — the
 * family whose per-turn context re-billing the optimizations target.
 *
 * Requires GEMINI_API_KEY (environment or repo-root `.env`) — the run fails
 * without it. `pnpm eval:hermetic` skips this file and runs only the
 * no-network context-cost measurement.
 *
 *   pnpm eval
 *
 * Env knobs: A2UI_EVAL_MODEL_FAMILY (default text),
 *            A2UI_EVAL_MODEL (default per model — see setup.ts),
 *            A2UI_EVAL_PROFILES (comma list, default all).
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { Agent } from '../src/lib/agent/agent.svelte';
import { a2uiState } from '../src/lib/core/state.svelte';
import { configureExtensions } from '../src/lib/core/extensions';
import { surface } from '../src/lib/core/registries/surface-index';
import {
	requireApiKey,
	EVAL_MODEL,
	EVAL_MODEL_FAMILY,
	EVAL_TODO_COUNT,
	EVAL_TURN_GAP_MS,
	type EvalProfile,
	selectedProfiles,
	makeEvalModel
} from './setup';
import { record, printSummary } from './report';
import { todoList } from './fixtures/todo-list-agent';
import { dynamicCanvas } from './fixtures/dynamic-canvas-agent';
import TodoListPage from './fixtures/TodoListPage.svelte';
import DynamicCanvasPage from './fixtures/DynamicCanvasPage.svelte';

// No key, no eval: fail collection with the reason rather than reporting a
// green run that drove no model.
requireApiKey();

/**
 * Per-turn budget. A live turn can run well past `send()`'s 60 s default —
 * the model speaks its whole answer — so the eval carries its own deadline.
 */
const TURN_TIMEOUT_MS = 150_000;

/** Wall-clock of the last completed turn, so pacing spans scenarios too. */
let lastTurnEndedAt = 0;

/**
 * One user turn, paced against the provider's per-minute quota: wait out the
 * remainder of {@link EVAL_TURN_GAP_MS} since the previous turn, then send.
 * `agent.send` resolves at the turn boundary and rejects on model error,
 * close, or timeout — there is nothing to poll.
 */
async function sendPaced(agent: Agent, text: string): Promise<void> {
	const sinceLast = Date.now() - lastTurnEndedAt;
	if (lastTurnEndedAt > 0 && sinceLast < EVAL_TURN_GAP_MS) {
		await new Promise((r) => setTimeout(r, EVAL_TURN_GAP_MS - sinceLast));
	}
	try {
		await agent.send(text, { timeoutMs: TURN_TIMEOUT_MS });
	} finally {
		lastTurnEndedAt = Date.now();
	}
}

/** The app's definition plus this arm's experimental knob and a fresh model. */
async function startAgent(definition: typeof todoList, profile: EvalProfile): Promise<Agent> {
	const agent = new Agent(
		{ ...definition, compactSurfaceJson: profile.compactSurfaceJson },
		makeEvalModel()
	);
	await agent.start();
	if (agent.configIssue) throw new Error(`agent failed to start: ${agent.configIssue}`);
	return agent;
}

/**
 * Run one scenario: send the turns, collect failures from `verify`, record the
 * row for the report, and assert at the end so a behavioural regression is
 * visible as a test failure without aborting the rest of the matrix.
 */
async function runScenario(opts: {
	scenario: string;
	profile: EvalProfile;
	agent: Agent;
	turns: string[];
	verify: () => string[];
}): Promise<void> {
	const { scenario, profile, agent, turns, verify } = opts;
	const t0 = Date.now();
	const failures: string[] = [];
	try {
		for (const turn of turns) await sendPaced(agent, turn);
		failures.push(...verify());
	} catch (e) {
		failures.push((e as Error).message);
	}
	const { usage } = agent.debug;
	// On Gemini Live the high-water session `totalTokenCount` is the number the
	// quota (RESOURCE_EXHAUSTED) is measured against — surface it per row.
	const info = usage.peakTotal > 0 ? [`session total ${usage.peakTotal} tok`] : [];
	record({
		scenario,
		profile: profile.name,
		pass: failures.length === 0,
		notes: [...failures, ...info],
		requests: usage.reports,
		toolCalls: agent.debug.outbound['tool-result'].count,
		promptTokens: usage.sumPromptTokens,
		responseTokens: usage.sumResponseTokens,
		ms: Date.now() - t0
	});
	await agent.stop();
	expect(failures, `${scenario} [${profile.name}]`).toEqual([]);
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

/** What the model said this session — the same text a user would have read. */
const modelSaid = (agent: Agent) =>
	agent.transcript
		.filter((m) => m.role === 'model')
		.map((m) => m.text)
		.join(' ');

/** The list's data model — every task cell, as the agent sees it. */
const todos = () => surface('todo-list')!.getDataModel!();

/** Rendered text of a component, by the id the agent targets it with. */
const shown = (id: string) =>
	document.querySelector(`[data-a2ui-id="${id}"]`)?.textContent?.trim() ?? '';

describe('LLM evals — static todo list', () => {
	afterEach(() => cleanup());

	for (const profile of selectedProfiles()) {
		describe(`[${profile.name}]`, () => {
			async function start() {
				configureExtensions(profile.extensions);
				render(TodoListPage, { todoCount: EVAL_TODO_COUNT });
				return startAgent(todoList, profile);
			}

			it('single-field-update', async () => {
				const agent = await start();
				await runScenario({
					scenario: 'single-field-update',
					profile,
					agent,
					turns: ['Set the due date of the Invoices task to 2026-04-15.'],
					verify: () => {
						const value = todos()['todo-invoices-due'];
						return value === '2026-04-15' ? [] : [`invoices.due = "${value}"`];
					}
				});
			});

			it('batch-update', async () => {
				const agent = await start();
				await runScenario({
					scenario: 'batch-update',
					profile,
					agent,
					turns: ['Set the priority of every task to High.'],
					verify: () => {
						const model = todos();
						return Object.keys(model)
							.filter((id) => id.endsWith('-priority') && norm(model[id]) !== 'high')
							.map((id) => `${id} = "${model[id]}"`);
					}
				});
			});

			// The stability probe: clicking add-todo-btn changes the surface
			// STRUCTURE (a new task row appears). With the full/diff echo the
			// model is told the new field ids; with `bare` it must guess them.
			it('add-task-then-edit', async () => {
				const agent = await start();
				await runScenario({
					scenario: 'add-task-then-edit',
					profile,
					agent,
					turns: [
						'Add a new task titled Groceries tagged Home, then set the Groceries priority to High.'
					],
					verify: () => {
						if (shown('title-groceries') !== 'Groceries') return ['Groceries was not added'];
						const fails: string[] = [];
						const tag = shown('tag-groceries');
						if (norm(tag) !== 'home') fails.push(`groceries.tag = "${tag}"`);
						const priority = todos()['todo-groceries-priority'];
						if (norm(priority) !== 'high') fails.push(`groceries.priority = "${priority}"`);
						return fails;
					}
				});
			});

			it('read-only-question', async () => {
				const agent = await start();
				const before = JSON.stringify(todos());
				await runScenario({
					scenario: 'read-only-question',
					profile,
					agent,
					turns: ['Which tasks are tagged Health, and who is each one assigned to?'],
					verify: () => {
						const fails: string[] = [];
						const answer = modelSaid(agent);
						const text = answer.toLowerCase();
						// Dentist (Lena) and Gym (Ivan) are the Health tasks in the seed data.
						for (const token of ['dentist', 'gym', 'lena', 'ivan']) {
							if (!text.includes(token))
								fails.push(`answer lacks ${token}: "${answer.slice(0, 200)}"`);
						}
						if (JSON.stringify(todos()) !== before)
							fails.push('a read-only question mutated the surface');
						return fails;
					}
				});
			});
		});
	}
});

describe('LLM evals — dynamic surface', () => {
	afterEach(() => {
		cleanup();
		a2uiState.deleteSurface('ai-canvas');
	});

	// Dynamic tool results are already lean ({status:'success'}); the profiles
	// only differ in prompt formatting here, so run the two main arms.
	for (const profile of selectedProfiles(['baseline', 'optimized'])) {
		it(`build-form-then-update [${profile.name}]`, async () => {
			configureExtensions(profile.extensions);
			render(DynamicCanvasPage, { surfaceId: 'ai-canvas' });
			const agent = await startAgent(dynamicCanvas, profile);
			await runScenario({
				scenario: 'build-form-then-update',
				profile,
				agent,
				turns: [
					"Create a feedback form titled 'Visit feedback' with a short text field for the visitor name, a long text field for comments, and a submit button labelled 'Send'.",
					"Now prefill the visitor name field with 'Mario Rossi'."
				],
				verify: () => {
					const fails: string[] = [];
					const surf = a2uiState.getSurface('ai-canvas');
					if (!surf) return ['surface was never created'];
					if (!surf.isRendering || !surf.rootId) fails.push('beginRendering was not called');
					const comps = JSON.stringify(surf.components);
					if (!comps.includes('"TextField"')) fails.push('no TextField rendered');
					if (!comps.includes('"Button"')) fails.push('no Button rendered');
					if (!comps.includes('Visit feedback')) fails.push('title text missing');
					const everything = comps + JSON.stringify(surf.data);
					if (!everything.includes('Mario Rossi'))
						fails.push('second turn did not set "Mario Rossi"');
					return fails;
				}
			});
		});
	}
});

afterAll(() => {
	// Live results persist under their own tag so the text-loop history stays
	// diffable against text-loop runs only.
	printSummary(
		`LLM eval results — model ${EVAL_MODEL} (${EVAL_MODEL_FAMILY} family)`,
		EVAL_MODEL_FAMILY === 'live' ? 'llm-scenarios-live' : 'llm-scenarios'
	);
});
