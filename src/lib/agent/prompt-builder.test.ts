import { describe, it, expect, afterEach } from 'vitest';
import {
	buildSystemPrompt,
	staticSurfacesBlock,
	dynamicSurfacesBlock,
	toolsBlock,
	contextBlock,
	historyBlock,
	type PromptInputs
} from './prompt-builder';
import { STRICT, ALL_EXTRAS, configureExtensions } from '../core/extensions';

const baseInputs: PromptInputs = {
	systemInstruction: 'You are a helpful assistant.',
	staticSurfaces: [],
	dynamicSurfaces: [],
	toolDeclarations: [],
	contextInstructions: '',
	transcriptHistory: [],
	includeDynamicGuide: false
};

describe('prompt-builder', () => {
	it('returns just the system instruction when nothing else is supplied', () => {
		expect(buildSystemPrompt(baseInputs)).toBe('You are a helpful assistant.');
	});

	it('omits empty blocks', () => {
		expect(staticSurfacesBlock([])).toBe('');
		expect(dynamicSurfacesBlock([], false)).toBe('');
		expect(toolsBlock([])).toBe('');
		expect(contextBlock('')).toBe('');
		expect(historyBlock([])).toBe('');
	});

	it('includes the static-surface CRITICAL RULES when surfaces are provided', () => {
		const out = staticSurfacesBlock([
			{ id: 'main', getJson: () => ({ Text: { text: 'hello' } }) }
		]);
		expect(out).toContain('## Static Surfaces');
		expect(out).toContain('CRITICAL RULES FOR STATIC SURFACES');
		expect(out).toContain('"main"');
	});

	it('teaches the agent both SURFACE_UPDATED extension envelope wire formats', () => {
		const out = staticSurfacesBlock([
			{ id: 'main', getJson: () => ({}) }
		]);
		expect(out).toContain("a2ui-svelte");
		// Data-model delta (the common case).
		expect(out).toContain('"clientDataModel"');
		expect(out).toContain('"surfaces"');
		expect(out).toContain('Only CHANGED fields are included');
		// Full re-sync on structural change.
		expect(out).toContain('"surfaceUpdated"');
		expect(out).toContain('"updatedSurfaces"');
		expect(out).toContain('"availableElementIds"');
		expect(out).toContain('kind');
	});

	it('emits the dynamic mini-spec when includeGuide is true even with no surfaces', () => {
		const out = dynamicSurfacesBlock([], true);
		expect(out).toContain('## Dynamic Surfaces');
		expect(out).toContain('How to use A2UI Dynamic Tools');
		// fallback id used when no surface present
		expect(out).toContain('"ai-canvas"');
	});

	it('uses the first dynamic surface id in the dynamic example tool calls', () => {
		const out = dynamicSurfacesBlock(
			[{ id: 'my-canvas', getJson: () => ({}) }],
			true
		);
		expect(out).toContain('"my-canvas"');
	});

	it('lists tools with their descriptions', () => {
		const out = toolsBlock([
			{ name: 'click_button', description: 'Click a button', parameters: {} }
		]);
		expect(out).toContain('## Available Function Tools');
		expect(out).toContain('- **click_button**: Click a button');
	});

	it('truncates history to the last 30 non-empty turns', () => {
		const history = Array.from({ length: 35 }, (_, i) => ({
			role: (i % 2 === 0 ? 'user' : 'model') as 'user' | 'model',
			text: `turn ${i}`
		}));
		const out = historyBlock(history);
		expect(out).toContain('turn 34');
		expect(out).not.toContain('turn 4');
	});

	it('joins blocks with a blank line and skips empty ones', () => {
		const out = buildSystemPrompt({
			...baseInputs,
			contextInstructions: 'Page is the todo page.'
		});
		expect(out).toBe(
			'You are a helpful assistant.\n\n## Page-Specific Expert Knowledge\nPage is the todo page.'
		);
	});

	describe('compactSurfaceJson', () => {
		const bigJson = {
			surfaceId: 'main',
			components: [{ id: 'root', component: { Column: { children: { explicitList: ['a'] } } } }]
		};

		it('pretty-prints surface JSON by default', () => {
			const out = staticSurfacesBlock([{ id: 'main', getJson: () => bigJson }]);
			expect(out).toContain(JSON.stringify(bigJson, null, 2));
		});

		it('serializes surface JSON on a single line when compactSurfaceJson is set', () => {
			const opts = { compactSurfaceJson: true };
			const out = staticSurfacesBlock([{ id: 'main', getJson: () => bigJson }], opts);
			expect(out).toContain(JSON.stringify(bigJson));
			expect(out).not.toContain(JSON.stringify(bigJson, null, 2));

			const dyn = dynamicSurfacesBlock([{ id: 'canvas', getJson: () => bigJson }], false, opts);
			expect(dyn).toContain(JSON.stringify(bigJson));
			expect(dyn).not.toContain(JSON.stringify(bigJson, null, 2));
		});

		it('threads through buildSystemPrompt', () => {
			const out = buildSystemPrompt({
				...baseInputs,
				staticSurfaces: [{ id: 'main', getJson: () => bigJson }],
				compactSurfaceJson: true
			});
			expect(out).toContain(JSON.stringify(bigJson));
		});
	});

	describe('optional history (client-history transports)', () => {
		const withHistory: PromptInputs = {
			...baseInputs,
			transcriptHistory: [{ role: 'user', text: 'hello there' }]
		};

		it('includes the history block by default when transcriptHistory is non-empty', () => {
			const out = buildSystemPrompt(withHistory);
			expect(out).toContain('## Recent Conversation History');
			expect(out).toContain('User: hello there');
		});

		it('omits the history block when includeHistory is false, even with history present', () => {
			const out = buildSystemPrompt({ ...withHistory, includeHistory: false });
			expect(out).not.toContain('## Recent Conversation History');
			expect(out).not.toContain('hello there');
		});

		it('treats an absent transcriptHistory as no history block', () => {
			const { transcriptHistory: _omit, ...noHistory } = baseInputs;
			expect(buildSystemPrompt(noHistory)).toBe('You are a helpful assistant.');
		});
	});

	describe('B3/B4 — extension-aware static-surface block', () => {
		afterEach(() => configureExtensions({}));

		it('default (ALL_EXTRAS): teaches batched + single tools and the envelope', () => {
			const out = staticSurfacesBlock([{ id: 'main', getJson: () => ({}) }]);
			// Batch and single tool names both mentioned.
			expect(out).toContain('click_button({element_id})');
			expect(out).toContain('click_buttons({clicks:');
			expect(out).toContain('update_text_field({element_id, value})');
			expect(out).toContain('update_text_fields({updates:');
			// Result envelope rule present.
			expect(out).toContain('TOOL-RESULT ENVELOPE');
			expect(out).toContain('a2ui-svelte');
			expect(out).toContain('updatedSurface');
			// Batch + surface-watch rules present.
			expect(out).toContain('BATCH OPERATIONS');
			expect(out).toContain('SURFACE UPDATES');
			// On-demand pointer rule present.
			expect(out).toContain('POINTING THINGS OUT');
			expect(out).toContain('point_to_elements');
		});

		it('teaches the two-value status vocabulary whatever the extensions say', () => {
			for (const ext of [{}, STRICT, ALL_EXTRAS, { toolResultSurfaceEcho: 'none' as const }]) {
				configureExtensions(ext);
				const out = staticSurfacesBlock([{ id: 'main', getJson: () => ({}) }]);
				// The envelope rule is an extension; the status contract is not —
				// every tool emits it even under STRICT, so the model is always told.
				expect(out).toContain('TOOL RESULTS');
				expect(out).toContain('"status": "success" | "error"');
				expect(out).toContain('never any other word');
			}
		});

		it('ALL_EXTRAS explicit: identical content to the default', () => {
			configureExtensions(ALL_EXTRAS);
			const out = staticSurfacesBlock([{ id: 'main', getJson: () => ({}) }]);
			expect(out).toContain('click_buttons({clicks:');
			expect(out).toContain('TOOL-RESULT ENVELOPE');
			expect(out).toContain('SURFACE UPDATES');
			expect(out).toContain('BATCH OPERATIONS');
		});

		it('STRICT: drops batch / surface-watch / tool-result-envelope rules', () => {
			configureExtensions(STRICT);
			const out = staticSurfacesBlock([{ id: 'main', getJson: () => ({}) }]);
			// Single-element form is taught.
			expect(out).toContain('click_button({element_id})');
			expect(out).toContain('update_text_field({element_id, value})');
			// Batched tool names are NOT taught.
			expect(out).not.toContain('click_buttons');
			expect(out).not.toContain('update_text_fields');
			expect(out).not.toContain('BATCH OPERATIONS');
			// SURFACE_UPDATED event rule is not advertised.
			expect(out).not.toContain('SURFACE UPDATES');
			expect(out).not.toContain('<event>SURFACE_UPDATED</event>');
			// Tool-result envelope rule is not advertised either.
			expect(out).not.toContain('TOOL-RESULT ENVELOPE');
			// On-demand pointer tool is a non-spec extension — dropped under STRICT.
			expect(out).not.toContain('POINTING THINGS OUT');
			expect(out).not.toContain('point_to_elements');
		});

		it('the record is app-wide: one setting describes every surface in the block', () => {
			configureExtensions({ batchTools: true, toolResultSurfaceEcho: 'none', surfaceWatch: false, pointerTool: false });
			const out = staticSurfacesBlock([
				{ id: 'a', getJson: () => ({}) },
				{ id: 'b', getJson: () => ({}) }
			]);
			expect(out).toContain('Static Surface ("a")');
			expect(out).toContain('Static Surface ("b")');
			expect(out).toContain('click_buttons');
			expect(out).toContain('BATCH OPERATIONS');
			expect(out).not.toContain('TOOL-RESULT ENVELOPE');
			expect(out).not.toContain('SURFACE UPDATES');
		});

		it("toolResultSurfaceEcho 'changed': teaches the changed-only envelope instead of the full echo", () => {
			configureExtensions({ toolResultSurfaceEcho: 'changed' });
			const out = staticSurfacesBlock([{ id: 'main', getJson: () => ({}) }]);
			expect(out).toContain('TOOL-RESULT ENVELOPE (changed-only)');
			expect(out).toContain('updatedDataModel');
			expect(out).toContain('present ONLY when the component STRUCTURE changed');
			// The full-echo guidance must NOT also be present.
			expect(out).not.toContain('The original static-surface JSON shown at session start is stale');
		});

		it('per-extension overrides: only the surface echo stays on', () => {
			configureExtensions({
				surfaceWatch: false,
				batchTools: false,
				toolResultSurfaceEcho: 'full',
				pointerTool: false
			});
			const out = staticSurfacesBlock([{ id: 'main', getJson: () => ({}) }]);
			expect(out).toContain('TOOL-RESULT ENVELOPE');
			expect(out).not.toContain('BATCH OPERATIONS');
			expect(out).not.toContain('SURFACE UPDATES');
			expect(out).not.toContain('POINTING THINGS OUT');
			expect(out).not.toContain('click_buttons');
		});
	});
});
