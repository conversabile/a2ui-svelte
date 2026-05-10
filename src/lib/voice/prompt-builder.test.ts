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
});
