/**
 * Hermetic context-cost measurement (no model, no network — always runs).
 *
 * Validates the verbosity hypothesis quantitatively: it mounts the real
 * shift-planner fixture, builds the real system prompt, executes a realistic
 * scripted 7-call tool sequence through the real tool registry, and measures
 * what every configuration would feed the model:
 *
 *  - prompt size, pretty vs compact JSON;
 *  - per-call tool-result size with the full surface echo
 *    (`toolResultSurfaceEcho: 'full'`), the changed-only echo (`'changed'`),
 *    and no echo (`'none'`);
 *  - the cumulative billed input across the agentic loop on a client-history
 *    (request/response) transport, where every tool result is re-sent on
 *    every subsequent request;
 *  - the peak session context on a server-history (live/voice) transport,
 *    where every tool result permanently grows the billed session context.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { toolRegistry } from '../src/lib/core/registries/tool-registry';
import { buildSystemPrompt } from '../src/lib/agent/prompt-builder';
import { configureExtensions, type Extensions } from '../src/lib/core/extensions';
import {
	surface as mountedSurface,
	type AgentSurface
} from '../src/lib/core/registries/surface-index';
import { clearRegistries, estTokens } from './harness';
import ShiftPlannerPage from './fixtures/ShiftPlannerPage.svelte';

interface PlannerExports {
	contextInstructions(): string;
	getStaff(): Array<{ name: string; role: string; shifts: Record<string, string> }>;
}

const INSTRUCTIONS =
	'You are the shift-planner assistant for a small restaurant team. ' +
	'You operate the on-screen UI through the available tools. Be concise.';

function mountPlanner(extensions: Partial<Extensions>, staffCount = 6) {
	configureExtensions(extensions);
	const { component } = render(ShiftPlannerPage, { staffCount });
	const page = component as unknown as PlannerExports;
	const surface = mountedSurface('shift-planner');
	if (!surface) throw new Error('fixture surface did not mount');
	return { page, surface };
}

function buildPrompt(page: PlannerExports, surface: AgentSurface, compact: boolean): string {
	return buildSystemPrompt({
		systemInstruction: INSTRUCTIONS,
		staticSurfaces: [surface],
		dynamicSurfaces: [],
		toolDeclarations: toolRegistry.getDeclarations(),
		contextInstructions: page.contextInstructions(),
		includeDynamicGuide: false,
		compactSurfaceJson: compact
	});
}

/**
 * A realistic multi-step task, executed exactly as the `Agent` would
 * (sequential `toolRegistry.execute` calls): three shift edits, a structural
 * change (adding a staff member), an edit on the new row, and a save that
 * mutates the page context.
 */
async function runScriptedTask(): Promise<number[]> {
	const sizes: number[] = [];
	const call = async (name: string, args: Record<string, unknown>) => {
		const result = await toolRegistry.execute(name, args);
		sizes.push(JSON.stringify(result).length);
	};
	await call('update_text_field', { element_id: 'shift-anna-wed', value: '10:00-18:00' });
	await call('update_text_fields', {
		updates: [
			{ element_id: 'shift-carla-thu', value: 'Morning' },
			{ element_id: 'shift-lucia-thu', value: 'Morning' },
			{ element_id: 'shift-marco-thu', value: 'Morning' }
		]
	});
	await call('update_text_field', { element_id: 'add-staff-name', value: 'Bruno' });
	await call('update_text_field', { element_id: 'add-staff-role', value: 'Waiter' });
	await call('click_button', { element_id: 'add-staff-btn' });
	await call('update_text_field', { element_id: 'shift-bruno-fri', value: 'Evening' });
	await call('click_button', { element_id: 'save-week-btn' });
	return sizes;
}

/**
 * Cumulative input a client-history transport bills for the loop: request k
 * re-sends the system prompt, the user turn, and every prior tool result.
 * (Function-call echoes and model text are small; ignored — this is a floor.)
 */
function clientLoopBilledChars(promptChars: number, resultSizes: number[]): number {
	const userTurn = 80;
	let total = 0;
	let context = promptChars + userTurn;
	// One request per tool round, plus the final no-tool request.
	for (const size of resultSizes) {
		total += context;
		context += size;
	}
	total += context;
	return total;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

interface ModeRow {
	mode: string;
	promptChars: number;
	resultSizes: number[];
	billedChars: number;
	peakSessionChars: number;
}

const rows: ModeRow[] = [];
let prettyPromptChars = 0;
let compactPromptChars = 0;
let scaledPromptChars: Array<{ staff: number; chars: number }> = [];

describe('context-cost measurement (hermetic)', () => {
	beforeEach(() => {
		clearRegistries();
	});
	afterEach(() => cleanup());

	it('measures prompt size, pretty vs compact', () => {
		const { page, surface } = mountPlanner({});
		prettyPromptChars = buildPrompt(page, surface, false).length;
		compactPromptChars = buildPrompt(page, surface, true).length;
		// Compaction must save at least 30% — it historically saves ~half of the
		// surface block, which dominates the prompt.
		expect(compactPromptChars).toBeLessThan(prettyPromptChars * 0.7);
	});

	it('measures how prompt size scales with surface density', () => {
		for (const staff of [3, 6, 12]) {
			clearRegistries();
			cleanup();
			const { page, surface } = mountPlanner({}, staff);
			scaledPromptChars.push({ staff, chars: buildPrompt(page, surface, false).length });
		}
		// Density scaling is roughly linear in roster rows.
		expect(scaledPromptChars[2].chars).toBeGreaterThan(scaledPromptChars[0].chars * 2);
	});

	for (const [mode, extensions] of [
		["full-echo ('full')", {}],
		["changed-only ('changed')", { toolResultSurfaceEcho: 'changed' as const }],
		["no-echo ('none')", { toolResultSurfaceEcho: 'none' as const }]
	] as Array<[string, Partial<Extensions>]>) {
		it(`measures tool-result sizes with ${mode}`, async () => {
			const { page, surface } = mountPlanner(extensions);
			const compact = mode !== "full-echo ('full')";
			const promptChars = buildPrompt(page, surface, compact).length;
			const resultSizes = await runScriptedTask();
			rows.push({
				mode,
				promptChars,
				resultSizes,
				billedChars: clientLoopBilledChars(promptChars, resultSizes),
				peakSessionChars: promptChars + sum(resultSizes)
			});
			// The task itself must succeed identically in every mode.
			expect(page.getStaff().find((s) => s.name === 'Bruno')?.shifts.fri).toBe('Evening');
		});
	}

	it('sanity: the optimizations actually shrink the bill', () => {
		const byMode = Object.fromEntries(rows.map((r) => [r.mode, r]));
		const full = byMode["full-echo ('full')"];
		const diff = byMode["changed-only ('changed')"];
		const bare = byMode["no-echo ('none')"];
		expect(full && diff && bare).toBeTruthy();
		// The diff echo only ships the full tree on the structural change (1 of
		// 7 calls) — total result bytes must be far below the full echo's.
		expect(sum(diff.resultSizes)).toBeLessThan(sum(full.resultSizes) * 0.45);
		expect(sum(bare.resultSizes)).toBeLessThan(sum(diff.resultSizes));
		expect(diff.billedChars).toBeLessThan(full.billedChars * 0.6);
	});

	afterAll(() => {
		const fmt = (chars: number) => `${chars.toLocaleString()}ch (~${estTokens(chars).toLocaleString()} tok)`;
		const lines: string[] = [];
		lines.push('');
		lines.push('══ Context-cost measurement — shift planner, 6 staff, 7-call task ══');
		lines.push(`system prompt, pretty JSON : ${fmt(prettyPromptChars)}`);
		lines.push(`system prompt, compact JSON: ${fmt(compactPromptChars)} (${Math.round((1 - compactPromptChars / prettyPromptChars) * 100)}% smaller)`);
		for (const s of scaledPromptChars) {
			lines.push(`  prompt @ ${String(s.staff).padStart(2)} staff rows : ${fmt(s.chars)}`);
		}
		lines.push('');
		for (const r of rows) {
			lines.push(`tool results — ${r.mode}`);
			lines.push(`  per call: [${r.resultSizes.map((s) => s.toLocaleString()).join(', ')}]`);
			lines.push(`  total   : ${fmt(sum(r.resultSizes))}`);
			lines.push(`  whole-task billed input, request/response loop (8 requests): ${fmt(r.billedChars)}`);
			lines.push(`  peak session context, live/voice transport               : ${fmt(r.peakSessionChars)}`);
		}
		lines.push('');
		const text = lines.join('\n');
		// Vitest's default reporter can swallow hook-time console output — write
		// straight to stdout AND persist the artifact next to the LLM results.
		process.stdout.write(text + '\n');
		const dir = path.resolve(__dirname, 'results');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'context-cost-latest.txt'), text);
	});
});
