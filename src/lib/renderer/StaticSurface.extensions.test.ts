import { render } from '@testing-library/svelte';
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import StaticSurface from './StaticSurface.svelte';
import { toolRegistry } from '../core/registries/tool-registry';
import { actionRegistry } from '../core/registries/action-registry';
import { STRICT, ALL_EXTRAS } from '../core/extensions';
import ButtonHarness from './__fixtures__/ButtonHarness.svelte';

// jsdom doesn't provide `CSS` — the reveal / highlight helpers in core
// use `CSS.escape(id)` to safely interpolate component IDs into a CSS
// selector. Stub it with a passthrough for the test environment; the
// fixture IDs are CSS-safe so escaping is a no-op anyway.
beforeAll(() => {
	if (typeof (globalThis as any).CSS === 'undefined') {
		(globalThis as any).CSS = { escape: (s: string) => s };
	}
});

function clearRegistries() {
	for (const t of toolRegistry.getDeclarations()) toolRegistry.unregister(t.name);
	for (const id of actionRegistry.listActions()) actionRegistry.unregister(id);
}

describe('StaticSurface — B3: tool registration shape', () => {
	beforeEach(clearRegistries);

	it('always registers spec-canonical single-element click_button / update_text_field', () => {
		render(StaticSurface, {
			surfaceId: 'spec-default',
			children: ButtonHarness as never
		});
		const names = toolRegistry.getDeclarations().map((d) => d.name);
		expect(names).toContain('click_button');
		expect(names).toContain('update_text_field');

		const click = toolRegistry.getDeclarations().find((d) => d.name === 'click_button')!;
		expect((click.parameters as any).properties).toHaveProperty('element_id');
		expect((click.parameters as any).required).toEqual(['element_id']);

		const update = toolRegistry.getDeclarations().find((d) => d.name === 'update_text_field')!;
		expect((update.parameters as any).properties).toHaveProperty('element_id');
		expect((update.parameters as any).properties).toHaveProperty('value');
		expect((update.parameters as any).required).toEqual(['element_id', 'value']);
	});

	it('registers batch variants click_buttons / update_text_fields by default (ALL_EXTRAS)', () => {
		render(StaticSurface, {
			surfaceId: 'batch-default',
			children: ButtonHarness as never
		});
		const names = toolRegistry.getDeclarations().map((d) => d.name);
		expect(names).toContain('click_buttons');
		expect(names).toContain('update_text_fields');

		const click = toolRegistry.getDeclarations().find((d) => d.name === 'click_buttons')!;
		expect((click.parameters as any).properties).toHaveProperty('clicks');
		expect((click.parameters as any).required).toEqual(['clicks']);

		const update = toolRegistry.getDeclarations().find((d) => d.name === 'update_text_fields')!;
		expect((update.parameters as any).properties).toHaveProperty('updates');
		expect((update.parameters as any).required).toEqual(['updates']);
	});

	it('also registers batch variants when explicitly opted into via ALL_EXTRAS prop', () => {
		render(StaticSurface, {
			surfaceId: 'batch-explicit',
			children: ButtonHarness as never,
			options: ALL_EXTRAS
		});
		const names = toolRegistry.getDeclarations().map((d) => d.name);
		expect(names).toContain('click_buttons');
		expect(names).toContain('update_text_fields');
	});

	it('OMITS batch variants when the surface is STRICT', () => {
		render(StaticSurface, {
			surfaceId: 'strict-no-batch',
			children: ButtonHarness as never,
			options: STRICT
		});
		const names = toolRegistry.getDeclarations().map((d) => d.name);
		expect(names).toContain('click_button');
		expect(names).toContain('update_text_field');
		expect(names).not.toContain('click_buttons');
		expect(names).not.toContain('update_text_fields');
	});

	it('OMITS batch variants when batchTools is explicitly flipped off', () => {
		render(StaticSurface, {
			surfaceId: 'no-batch',
			children: ButtonHarness as never,
			options: { batchTools: false }
		});
		const names = toolRegistry.getDeclarations().map((d) => d.name);
		expect(names).toContain('click_button');
		expect(names).not.toContain('click_buttons');
	});

	it('single click_button executes the same handler as the batch variant', async () => {
		render(StaticSurface, {
			surfaceId: 'click-exec',
			children: ButtonHarness as never
		});
		const result: any = await toolRegistry.execute('click_button', { element_id: 'save-btn' });
		expect(result.results).toEqual([
			{ element_id: 'save-btn', status: 'success' }
		]);
	});
});

describe('StaticSurface — B4: tool-result envelope shape', () => {
	beforeEach(clearRegistries);

	it('default (ALL_EXTRAS): wraps extras under extensions["a2ui-svelte"], not at the top level', async () => {
		render(StaticSurface, {
			surfaceId: 'extras-default',
			children: ButtonHarness as never
		});
		const result: any = await toolRegistry.execute('click_button', { element_id: 'save-btn' });
		expect(result).toHaveProperty('results');
		expect(result).toHaveProperty('extensions');
		expect(result.extensions).toHaveProperty('a2ui-svelte');
		expect(result.extensions['a2ui-svelte']).toHaveProperty('availableElementIds');
		expect(Array.isArray(result.extensions['a2ui-svelte'].availableElementIds)).toBe(true);
		// Extras MUST NOT leak back to the top level — strict spec consumers
		// should be able to drop `extensions` and still get a clean result.
		expect(result).not.toHaveProperty('availableElementIds');
		expect(result).not.toHaveProperty('updatedSurface');
		expect(result).not.toHaveProperty('updatedContext');
	});

	it('STRICT: returns just { results: [...] } with no extras at all', async () => {
		render(StaticSurface, {
			surfaceId: 'extras-strict',
			children: ButtonHarness as never,
			options: STRICT
		});
		const result: any = await toolRegistry.execute('click_button', { element_id: 'save-btn' });
		expect(result).toEqual({
			results: [{ element_id: 'save-btn', status: 'success' }]
		});
		expect(result).not.toHaveProperty('extensions');
	});

	it('honours an isolated toolResultExtras=false even with batchTools=true', async () => {
		render(StaticSurface, {
			surfaceId: 'extras-off',
			children: ButtonHarness as never,
			options: { toolResultExtras: false }
		});
		// Batch variant still registered (batchTools defaults on)
		const names = toolRegistry.getDeclarations().map((d) => d.name);
		expect(names).toContain('click_buttons');

		// But the result envelope is still bare.
		const result: any = await toolRegistry.execute('click_buttons', {
			clicks: [{ element_id: 'save-btn' }]
		});
		expect(result).toEqual({
			results: [{ element_id: 'save-btn', status: 'success' }]
		});
	});
});

describe('StaticSurface — on-demand pointer tool (point_to_elements)', () => {
	beforeEach(clearRegistries);

	it('registers point_to_elements by default (ALL_EXTRAS)', () => {
		render(StaticSurface, {
			surfaceId: 'ptr-default',
			children: ButtonHarness as never
		});
		const names = toolRegistry.getDeclarations().map((d) => d.name);
		expect(names).toContain('point_to_elements');

		const ptr = toolRegistry.getDeclarations().find((d) => d.name === 'point_to_elements')!;
		expect((ptr.parameters as any).properties).toHaveProperty('element_ids');
		expect((ptr.parameters as any).required).toEqual(['element_ids']);
	});

	it('OMITS point_to_elements when the surface is STRICT', () => {
		render(StaticSurface, {
			surfaceId: 'ptr-strict',
			children: ButtonHarness as never,
			options: STRICT
		});
		expect(toolRegistry.getDeclarations().map((d) => d.name)).not.toContain('point_to_elements');
	});

	it('OMITS point_to_elements when pointerTool is explicitly flipped off', () => {
		render(StaticSurface, {
			surfaceId: 'ptr-off',
			children: ButtonHarness as never,
			options: { pointerTool: false }
		});
		expect(toolRegistry.getDeclarations().map((d) => d.name)).not.toContain('point_to_elements');
	});

	it('reports found vs missing IDs and returns a LEAN result (no surface echo even with extras on)', async () => {
		render(StaticSurface, {
			surfaceId: 'ptr-exec',
			children: ButtonHarness as never
		});
		// ButtonHarness renders <button data-a2ui-id="save-btn">, so the pointer
		// can resolve it in the DOM; the second id has no matching node.
		const result: any = await toolRegistry.execute('point_to_elements', {
			element_ids: ['save-btn', 'does-not-exist']
		});
		expect(result).toEqual({
			results: [
				{ element_id: 'save-btn', status: 'pointed' },
				{ element_id: 'does-not-exist', status: 'not_found' }
			]
		});
		// Purely visual gesture: never echoes the surface back, even though
		// toolResultExtras defaults on.
		expect(result).not.toHaveProperty('extensions');
	});
});
