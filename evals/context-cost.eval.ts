/**
 * Hermetic context-cost measurement (no model, no network — always runs).
 *
 * Validates the verbosity hypothesis quantitatively: it mounts the real
 * todo-list fixture, builds the real system prompt, executes a realistic
 * scripted 7-call tool sequence through the real tool registry, and measures
 * what every configuration would feed the model:
 *
 *  - prompt size, pretty vs compact JSON;
 *  - per-call tool-result size with the full surface echo
 *    (`toolResultSurfaceEcho: 'full'`), the per-component delta echo (`'delta'`),
 *    and no echo (`'none'`);
 *  - the cumulative billed input across the agentic loop on a client-history
 *    (request/response) model, where every tool result is re-sent on
 *    every subsequent request;
 *  - the peak session context on a server-history (live/voice) model,
 *    where every tool result permanently grows the billed session context.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { toolRegistry } from '../src/lib/core/registries/tool-registry';
import { Agent } from '../src/lib/agent/agent.svelte';
import { ScriptedModel } from '../src/lib/agent/scripted-model';
import { buildSystemPrompt } from '../src/lib/agent/prompt-builder';
import { configureExtensions, type Extensions } from '../src/lib/core/extensions';
import {
	surface as mountedSurface,
	type AgentSurface
} from '../src/lib/core/registries/surface-index';
import { estTokens } from './report';
import { todoList } from './fixtures/todo-list-agent';
import TodoListPage from './fixtures/TodoListPage.svelte';

function mountList(extensions: Partial<Extensions>, todoCount = 6): AgentSurface {
	configureExtensions(extensions);
	render(TodoListPage, { todoCount });
	const surface = mountedSurface('todo-list');
	if (!surface) throw new Error('fixture surface did not mount');
	return surface;
}

function buildPrompt(surface: AgentSurface, compact: boolean): string {
	return buildSystemPrompt({
		systemInstruction: todoList.instructions,
		staticSurfaces: [surface],
		dynamicSurfaces: [],
		toolDeclarations: toolRegistry.getDeclarations(),
		contextInstructions: todoList.contextInstructions!(),
		includeDynamicGuide: false,
		compactSurfaceJson: compact
	});
}

/** The 7-call task, one tool call per model turn. */
const SCRIPTED_CALLS: Array<{ name: string; args: Record<string, unknown> }> = [
	{ name: 'update_text_field', args: { element_id: 'todo-invoices-due', value: '2026-04-15' } },
	{
		name: 'update_text_fields',
		args: {
			updates: [
				{ element_id: 'todo-laundry-priority', value: 'High' },
				{ element_id: 'todo-dentist-priority', value: 'High' },
				{ element_id: 'todo-gym-priority', value: 'High' }
			]
		}
	},
	{ name: 'update_text_field', args: { element_id: 'add-todo-title', value: 'Groceries' } },
	{ name: 'update_text_field', args: { element_id: 'add-todo-tag', value: 'Home' } },
	{ name: 'click_button', args: { element_id: 'add-todo-btn' } },
	{ name: 'update_text_field', args: { element_id: 'todo-groceries-due', value: '2026-04-20' } },
	{ name: 'click_button', args: { element_id: 'save-list-btn' } }
];

/**
 * A realistic multi-step task, executed through the real `Agent` (four detail
 * edits, a structural change adding a task, an edit on the new row, and a save
 * that mutates the page context). The agent is what builds the
 * tool-result echo, so the sizes measured here are exactly what a model would
 * be billed for.
 */
async function runScriptedTask(compact: boolean): Promise<number[]> {
	const model = new ScriptedModel(
		SCRIPTED_CALLS.map((c) => ({ calls: [c], text: 'done' }))
	);
	const agent = new Agent({ ...todoList, compactSurfaceJson: compact }, model);
	await agent.start();
	for (let i = 0; i < SCRIPTED_CALLS.length; i++) await agent.send(`step ${i + 1}`);
	agent.stop();
	return model.toolResults.map((r) => JSON.stringify(r.result).length);
}

/**
 * Cumulative input a client-history model bills for the loop: request k
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
let scaledPromptChars: Array<{ todos: number; chars: number }> = [];

describe('context-cost measurement (hermetic)', () => {
	afterEach(() => cleanup());

	it('measures prompt size, pretty vs compact', () => {
		const surface = mountList({});
		prettyPromptChars = buildPrompt(surface, false).length;
		compactPromptChars = buildPrompt(surface, true).length;
		// Compaction must save at least 30% — it historically saves ~half of the
		// surface block, which dominates the prompt. The rules text does not
		// compact, so this doubles as a guard on the prompt staying lean.
		expect(compactPromptChars).toBeLessThan(prettyPromptChars * 0.7);
	});

	it('measures how prompt size scales with surface density', () => {
		for (const todos of [3, 6, 12]) {
			cleanup();
			const surface = mountList({}, todos);
			scaledPromptChars.push({ todos, chars: buildPrompt(surface, false).length });
		}
		// Density scaling is roughly linear in task rows.
		expect(scaledPromptChars[2].chars).toBeGreaterThan(scaledPromptChars[0].chars * 2);
	});

	for (const [mode, extensions] of [
		// Spelled out: `'delta'` is the shipped default, so `{}` would measure
		// the diff arm twice.
		["full-echo ('full')", { toolResultSurfaceEcho: 'full' as const }],
		["delta ('delta')", { toolResultSurfaceEcho: 'delta' as const }],
		["no-echo ('none')", { toolResultSurfaceEcho: 'none' as const }]
	] as Array<[string, Partial<Extensions>]>) {
		it(`measures tool-result sizes with ${mode}`, async () => {
			const surface = mountList(extensions);
			const compact = mode !== "full-echo ('full')";
			const promptChars = buildPrompt(surface, compact).length;
			const resultSizes = await runScriptedTask(compact);
			rows.push({
				mode,
				promptChars,
				resultSizes,
				billedChars: clientLoopBilledChars(promptChars, resultSizes),
				peakSessionChars: promptChars + sum(resultSizes)
			});
			// The task itself must succeed identically in every mode.
			expect(surface.getDataModel!()['todo-groceries-due']).toBe('2026-04-20');
		});
	}

	it('sanity: the optimizations actually shrink the bill', () => {
		const byMode = Object.fromEntries(rows.map((r) => [r.mode, r]));
		const full = byMode["full-echo ('full')"];
		const diff = byMode["delta ('delta')"];
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
		lines.push('══ Context-cost measurement — todo list, 6 tasks, 7-call task ══');
		lines.push(`system prompt, pretty JSON : ${fmt(prettyPromptChars)}`);
		lines.push(`system prompt, compact JSON: ${fmt(compactPromptChars)} (${Math.round((1 - compactPromptChars / prettyPromptChars) * 100)}% smaller)`);
		for (const s of scaledPromptChars) {
			lines.push(`  prompt @ ${String(s.todos).padStart(2)} task rows : ${fmt(s.chars)}`);
		}
		lines.push('');
		for (const r of rows) {
			lines.push(`tool results — ${r.mode}`);
			lines.push(`  per call: [${r.resultSizes.map((s) => s.toLocaleString()).join(', ')}]`);
			lines.push(`  total   : ${fmt(sum(r.resultSizes))}`);
			lines.push(`  whole-task billed input, request/response loop (8 requests): ${fmt(r.billedChars)}`);
			lines.push(`  peak session context, live/voice model                     : ${fmt(r.peakSessionChars)}`);
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
