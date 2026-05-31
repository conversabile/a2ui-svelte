import { describe, it, expect } from 'vitest';
import {
	buildSystemPrompt,
	staticSurfacesBlock,
	dynamicSurfacesBlock,
	toolsBlock,
	contextBlock,
	historyBlock,
	type PromptInputs
} from './prompt-builder';
import { STRICT, ALL_EXTRAS } from '../core/extensions';

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
			contextInstructions: 'Page is the staff page.'
		});
		expect(out).toBe(
			'You are a helpful assistant.\n\n## Page-Specific Expert Knowledge\nPage is the staff page.'
		);
	});

	describe('B3/B4 — extension-aware static-surface block', () => {
		it('default (no extensions field on surface = ALL_EXTRAS): teaches batched + single tools and the envelope', () => {
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
		});

		it('ALL_EXTRAS explicit: identical content to the default', () => {
			const out = staticSurfacesBlock([
				{ id: 'main', getJson: () => ({}), extensions: ALL_EXTRAS }
			]);
			expect(out).toContain('click_buttons({clicks:');
			expect(out).toContain('TOOL-RESULT ENVELOPE');
			expect(out).toContain('SURFACE UPDATES');
			expect(out).toContain('BATCH OPERATIONS');
		});

		it('STRICT: drops batch / surface-watch / tool-result-envelope rules', () => {
			const out = staticSurfacesBlock([
				{ id: 'main', getJson: () => ({}), extensions: STRICT }
			]);
			// Single-element form is taught.
			expect(out).toContain('click_button({element_id})');
			expect(out).toContain('update_text_field({element_id, value})');
			// Batched tool names are NOT taught.
			expect(out).not.toContain('click_buttons');
			expect(out).not.toContain('update_text_fields');
			expect(out).not.toContain('BATCH OPERATIONS');
			// SURFACE_UPDATED event rule is not advertised (no surface opts in).
			expect(out).not.toContain('SURFACE UPDATES');
			expect(out).not.toContain('<event>SURFACE_UPDATED</event>');
			// Tool-result envelope rule is not advertised either.
			expect(out).not.toContain('TOOL-RESULT ENVELOPE');
		});

		it('mixed surfaces: enables a rule as soon as ONE surface opts in', () => {
			const out = staticSurfacesBlock([
				{ id: 'a', getJson: () => ({}), extensions: STRICT },
				{
					id: 'b',
					getJson: () => ({}),
					extensions: { ...STRICT, batchTools: true, toolResultExtras: false, surfaceWatch: false }
				}
			]);
			expect(out).toContain('click_buttons');
			expect(out).toContain('BATCH OPERATIONS');
			expect(out).not.toContain('TOOL-RESULT ENVELOPE');
			expect(out).not.toContain('SURFACE UPDATES');
		});

		it('per-flag overrides: only toolResultExtras stays on', () => {
			const out = staticSurfacesBlock([
				{
					id: 'main',
					getJson: () => ({}),
					extensions: {
						surfaceWatch: false,
						batchTools: false,
						toolResultExtras: true
					}
				}
			]);
			expect(out).toContain('TOOL-RESULT ENVELOPE');
			expect(out).not.toContain('BATCH OPERATIONS');
			expect(out).not.toContain('SURFACE UPDATES');
			expect(out).not.toContain('click_buttons');
		});
	});
});
