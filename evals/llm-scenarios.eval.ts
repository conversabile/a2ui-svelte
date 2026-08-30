/**
 * LLM eval scenarios — a real Gemini model drives real mounted surfaces
 * through the real `Agent`, and we assert on the resulting UI state / tool
 * results. Each scenario runs once per profile (baseline / optimized / bare —
 * see `PROFILES` in harness.ts) so the report answers the question: do the
 * context optimizations make the agent unstable?
 *
 * The transport family is selectable (`A2UI_EVAL_TRANSPORT=text|live`, see
 * harness.ts): the request/response text loop, or the streaming Live API —
 * the family whose per-turn context re-billing the optimizations target.
 *
 * Requires GEMINI_API_KEY (skips cleanly without it):
 *
 *   GEMINI_API_KEY=… pnpm eval
 *
 * Env knobs: A2UI_EVAL_TRANSPORT (default text),
 *            A2UI_EVAL_MODEL (default per transport — see harness.ts),
 *            A2UI_EVAL_PROFILES (comma list, default all).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { Agent } from '../src/lib/agent/agent.svelte';
import { a2uiState } from '../src/lib/core/state.svelte';
import type { ExtensionOptions } from '../src/lib/core/extensions';
import {
	API_KEY,
	EVAL_MODEL,
	EVAL_TRANSPORT,
	EVAL_STAFF_COUNT,
	type EvalProfile,
	selectedProfiles,
	clearRegistries,
	makeEvalTransport,
	RecordingTransport,
	sendAndWait
} from './harness';
import { record, printSummary } from './report';
import ShiftPlannerPage from './fixtures/ShiftPlannerPage.svelte';
import DynamicCanvasPage from './fixtures/DynamicCanvasPage.svelte';

const describeLive = API_KEY ? describe : describe.skip;
if (!API_KEY) {
	process.stdout.write(
		'[evals] GEMINI_API_KEY not set — skipping LLM scenarios (the hermetic context-cost measurement still ran).\n'
	);
}

interface SurfaceHandle {
	id: string;
	type: 'static' | 'dynamic';
	getJson(): unknown;
	getDataModel?(): Record<string, unknown>;
	extensions?: ExtensionOptions;
}

interface PlannerExports {
	surface(): SurfaceHandle | undefined;
	contextInstructions(): string;
	getStaff(): Array<{ name: string; role: string; shifts: Record<string, string> }>;
}

const STATIC_INSTRUCTIONS =
	'You are the shift-planner assistant for a small restaurant team. ' +
	'You operate the on-screen UI through the available tools. Be concise.';

const DYNAMIC_INSTRUCTIONS =
	'You are a UI-building assistant. Render what the user asks for on the dynamic surface ' +
	'using the A2UI tools. Be concise in your replies.';

async function startSession(opts: {
	profile: EvalProfile;
	surface: SurfaceHandle;
	contextInstructions?: () => string;
	instructions: string;
	mode: 'static' | 'dynamic';
}) {
	const rec = new RecordingTransport(makeEvalTransport());
	const agent = new Agent(
		{
			instructions: opts.instructions,
			surfaces: () => [opts.surface as never],
			contextInstructions: opts.contextInstructions,
			mode: opts.mode,
			compactSurfaceJson: opts.profile.compactSurfaceJson
		},
		rec
	);
	await agent.start();
	if (agent.configIssue) throw new Error(`agent failed to start: ${agent.configIssue}`);
	return { agent, rec };
}

/**
 * Run one scenario: send the turns, collect failures from `verify`, record
 * the row for the report, and assert at the end so a behavioural regression
 * is visible as a test failure without aborting the rest of the matrix.
 */
async function runScenario(opts: {
	scenario: string;
	profile: EvalProfile;
	agent: Agent;
	rec: RecordingTransport;
	turns: string[];
	verify: () => string[];
}): Promise<void> {
	const { scenario, profile, agent, rec, turns, verify } = opts;
	const t0 = Date.now();
	const failures: string[] = [];
	try {
		for (const turn of turns) await sendAndWait(agent, rec, turn);
		failures.push(...verify());
	} catch (e) {
		failures.push((e as Error).message);
	}
	const { prompt, response, requests } = rec.billedTokens;
	// On Gemini Live the high-water session `totalTokenCount` is the number the
	// quota (RESOURCE_EXHAUSTED) is measured against — surface it per row.
	const info = rec.peakTotalTokens > 0 ? [`session total ${rec.peakTotalTokens} tok`] : [];
	record({
		scenario,
		profile: profile.name,
		pass: failures.length === 0,
		notes: [...failures, ...info],
		requests,
		toolCalls: rec.toolCalls.length,
		promptTokens: prompt,
		responseTokens: response,
		ms: Date.now() - t0
	});
	await agent.stop();
	expect(failures, `${scenario} [${profile.name}]`).toEqual([]);
}

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();

describeLive('LLM evals — static shift planner', () => {
	beforeEach(() => {
		clearRegistries();
	});
	afterEach(() => cleanup());

	for (const profile of selectedProfiles()) {
		describe(`[${profile.name}]`, () => {
			async function start() {
				const { component } = render(ShiftPlannerPage, {
					staffCount: EVAL_STAFF_COUNT,
					options: profile.options
				});
				const page = component as unknown as PlannerExports;
				const surface = page.surface()!;
				const session = await startSession({
					profile,
					surface,
					contextInstructions: () => page.contextInstructions(),
					instructions: STATIC_INSTRUCTIONS,
					mode: 'static'
				});
				return { page, ...session };
			}

			it('single-field-update', async () => {
				const { page, agent, rec } = await start();
				await runScenario({
					scenario: 'single-field-update',
					profile,
					agent,
					rec,
					turns: ["Set Anna's shift on Wednesday to 10:00-18:00."],
					verify: () => {
						const anna = page.getStaff().find((s) => s.name === 'Anna');
						return anna?.shifts.wed === '10:00-18:00'
							? []
							: [`anna.wed = "${anna?.shifts.wed}"`];
					}
				});
			});

			it('batch-update', async () => {
				const { page, agent, rec } = await start();
				await runScenario({
					scenario: 'batch-update',
					profile,
					agent,
					rec,
					turns: ['Give every staff member the Morning shift on Thursday.'],
					verify: () => {
						const missing = page
							.getStaff()
							.filter((s) => norm(s.shifts.thu) !== 'morning')
							.map((s) => `${s.name}.thu = "${s.shifts.thu}"`);
						return missing;
					}
				});
			});

			// The stability probe: clicking add-staff-btn changes the surface
			// STRUCTURE (a new roster row appears). With the full/diff echo the
			// model is told the new field ids; with `bare` it must guess them.
			it('add-staff-then-edit', async () => {
				const { page, agent, rec } = await start();
				await runScenario({
					scenario: 'add-staff-then-edit',
					profile,
					agent,
					rec,
					turns: [
						'Add a new staff member named Bruno with role Waiter, then give Bruno the Evening shift on Friday.'
					],
					verify: () => {
						const bruno = page.getStaff().find((s) => s.name === 'Bruno');
						if (!bruno) return ['Bruno was not added'];
						const fails: string[] = [];
						if (norm(bruno.role) !== 'waiter') fails.push(`bruno.role = "${bruno.role}"`);
						if (norm(bruno.shifts.fri) !== 'evening')
							fails.push(`bruno.fri = "${bruno.shifts.fri}"`);
						return fails;
					}
				});
			});

			it('read-only-question', async () => {
				const { page, agent, rec } = await start();
				const before = JSON.stringify(page.getStaff());
				await runScenario({
					scenario: 'read-only-question',
					profile,
					agent,
					rec,
					turns: ['Which days is Sara working this week, and what hours?'],
					verify: () => {
						const fails: string[] = [];
						const text = rec.modelText.toLowerCase();
						// Sara works mon/tue/wed 08:00-16:00 in the seed data.
						if (!text.includes('08:00') || !text.includes('16:00'))
							fails.push(`answer lacks the hours: "${rec.modelText.slice(0, 200)}"`);
						for (const day of ['monday', 'tuesday', 'wednesday']) {
							if (!text.includes(day)) fails.push(`answer lacks ${day}`);
						}
						if (JSON.stringify(page.getStaff()) !== before)
							fails.push('a read-only question mutated the surface');
						return fails;
					}
				});
			});
		});
	}
});

describeLive('LLM evals — dynamic surface', () => {
	beforeEach(() => {
		clearRegistries();
		a2uiState.deleteSurface('ai-canvas');
	});
	afterEach(() => cleanup());

	// Dynamic tool results are already lean ({status:'success'}); the profiles
	// only differ in prompt formatting here, so run the two main arms.
	for (const profile of selectedProfiles(['baseline', 'optimized'])) {
		it(`build-form-then-update [${profile.name}]`, async () => {
			const { component } = render(DynamicCanvasPage, { surfaceId: 'ai-canvas' });
			const surface = (component as unknown as { surface(): SurfaceHandle | undefined }).surface()!;
			const { agent, rec } = await startSession({
				profile,
				surface,
				instructions: DYNAMIC_INSTRUCTIONS,
				mode: 'dynamic'
			});
			await runScenario({
				scenario: 'build-form-then-update',
				profile,
				agent,
				rec,
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
		`LLM eval results — model ${EVAL_MODEL} (${EVAL_TRANSPORT} transport)`,
		EVAL_TRANSPORT === 'live' ? 'llm-scenarios-live' : 'llm-scenarios'
	);
});
