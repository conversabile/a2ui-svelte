import { render } from '@testing-library/svelte';
import { describe, it, expect, afterEach } from 'vitest';
import StaticSurface from './StaticSurface.svelte';
import { toolRegistry } from '../core/registries/tool-registry';
import { STRICT, ALL_EXTRAS, configureExtensions } from '../core/extensions';
import type { SurfaceFeedback } from './surface-feedback';
import ButtonHarness from './__fixtures__/ButtonHarness.svelte';
import DiffHarness from './__fixtures__/DiffHarness.svelte';

// The extensions are one app-wide record, so every test that changes it
// restores the default — `configureExtensions` is an absolute set, so `{}`
// is the reset.
afterEach(() => configureExtensions({}));

describe('StaticSurface — B3: tool registration shape', () => {

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

	it('also registers batch variants when explicitly configured as ALL_EXTRAS', () => {
		configureExtensions(ALL_EXTRAS);
		render(StaticSurface, {
			surfaceId: 'batch-explicit',
			children: ButtonHarness as never
		});
		const names = toolRegistry.getDeclarations().map((d) => d.name);
		expect(names).toContain('click_buttons');
		expect(names).toContain('update_text_fields');
	});

	it('OMITS batch variants under STRICT', () => {
		configureExtensions(STRICT);
		render(StaticSurface, {
			surfaceId: 'strict-no-batch',
			children: ButtonHarness as never
		});
		const names = toolRegistry.getDeclarations().map((d) => d.name);
		expect(names).toContain('click_button');
		expect(names).toContain('update_text_field');
		expect(names).not.toContain('click_buttons');
		expect(names).not.toContain('update_text_fields');
	});

	it('OMITS batch variants when batchTools is explicitly flipped off', () => {
		configureExtensions({ batchTools: false });
		render(StaticSurface, {
			surfaceId: 'no-batch',
			children: ButtonHarness as never
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

	it('STRICT: returns just { results: [...] } with no echo at all', async () => {
		configureExtensions(STRICT);
		render(StaticSurface, {
			surfaceId: 'extras-strict',
			children: ButtonHarness as never
		});
		const result: any = await toolRegistry.execute('click_button', { element_id: 'save-btn' });
		expect(result).toEqual({
			results: [{ element_id: 'save-btn', status: 'success' }]
		});
		expect(result).not.toHaveProperty('extensions');
	});

	it("honours an isolated toolResultSurfaceEcho='none' even with batchTools on", async () => {
		configureExtensions({ toolResultSurfaceEcho: 'none' });
		render(StaticSurface, {
			surfaceId: 'extras-off',
			children: ButtonHarness as never
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

describe("StaticSurface — 'changed' tool-result mode (changed-only envelope)", () => {
	/**
	 * Mount the DiffHarness with `toolResultSurfaceEcho: 'changed'` and a feedback
	 * provider wired to the surface's own JSON (the lazy holder lets the
	 * closure read the mounted component's exports after render returns).
	 */
	function mountDiffSurface(surfaceId: string) {
		configureExtensions({ toolResultSurfaceEcho: 'changed' });
		const ctx = { value: 'initial context' };
		const holder: { getJson: (() => unknown) | null } = { getJson: null };
		const feedback: SurfaceFeedback = {
			globalSurfaces: () => (holder.getJson ? [holder.getJson()] : []),
			contextInstructions: () => ctx.value
		};
		const { component } = render(StaticSurface, {
			surfaceId,
			children: DiffHarness as never,
			feedback
		});
		holder.getJson = () => (component as { getJson: () => unknown }).getJson();
		return { ctx };
	}

	it('a value-only update returns updatedDataModel, NOT the surface echo', async () => {
		mountDiffSurface('diff-value');
		const result: any = await toolRegistry.execute('update_text_field', {
			element_id: 'name-field',
			value: 'John'
		});
		expect(result.results[0].status).toBe('success');
		const extras = result.extensions?.['a2ui-svelte'];
		expect(extras).toBeDefined();
		expect(extras.updatedDataModel).toEqual({ 'diff-value': { name: 'John' } });
		expect(extras).not.toHaveProperty('updatedSurface');
		expect(extras).not.toHaveProperty('updatedContext');
		expect(extras).not.toHaveProperty('availableElementIds');
	});

	it('a no-op action returns bare { results } with no extensions at all', async () => {
		mountDiffSurface('diff-noop');
		await toolRegistry.execute('update_text_field', {
			element_id: 'name-field',
			value: 'John'
		});
		// Same value again: nothing changed vs the last delivered state.
		const result: any = await toolRegistry.execute('update_text_field', {
			element_id: 'name-field',
			value: 'John'
		});
		expect(result.results[0].status).toBe('success');
		expect(result).not.toHaveProperty('extensions');
	});

	it('a structural change (component added) echoes the full updatedSurface', async () => {
		mountDiffSurface('diff-structure');
		const result: any = await toolRegistry.execute('click_button', { element_id: 'add-row' });
		const extras = result.extensions?.['a2ui-svelte'];
		expect(extras).toBeDefined();
		expect(extras).toHaveProperty('updatedSurface');
		const surfaces = extras.updatedSurface as Array<{ components: Array<{ id: string }> }>;
		expect(surfaces[0].components.map((c) => c.id)).toContain('row-1');
		// The full echo carries the data model inside it — no separate delta.
		expect(extras).not.toHaveProperty('updatedDataModel');
	});

	it("a click's side effect on a field (form reset) surfaces as updatedDataModel", async () => {
		mountDiffSurface('diff-side-effect');
		await toolRegistry.execute('update_text_field', {
			element_id: 'name-field',
			value: 'John'
		});
		const result: any = await toolRegistry.execute('click_button', {
			element_id: 'reset-form'
		});
		const extras = result.extensions?.['a2ui-svelte'];
		expect(extras).toBeDefined();
		expect(extras.updatedDataModel).toEqual({ 'diff-side-effect': { name: '' } });
		expect(extras).not.toHaveProperty('updatedSurface');
	});

	it('reports updatedContext only when the context instructions changed', async () => {
		const { ctx } = mountDiffSurface('diff-context');
		// First call seeds the baseline (pre-action state = what the prompt
		// showed), so a context change made before it counts as already known.
		await toolRegistry.execute('update_text_field', {
			element_id: 'name-field',
			value: 'Jane'
		});
		ctx.value = 'context after action';
		const result: any = await toolRegistry.execute('update_text_field', {
			element_id: 'name-field',
			value: 'Janet'
		});
		const extras = result.extensions?.['a2ui-svelte'];
		expect(extras.updatedContext).toBe('context after action');
		// And once delivered, an unchanged context is not repeated.
		const third: any = await toolRegistry.execute('update_text_field', {
			element_id: 'name-field',
			value: 'Joan'
		});
		expect(third.extensions?.['a2ui-svelte']).not.toHaveProperty('updatedContext');
	});
});

describe('StaticSurface — on-demand pointer tool (point_to_elements)', () => {
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

	it('OMITS point_to_elements under STRICT', () => {
		configureExtensions(STRICT);
		render(StaticSurface, {
			surfaceId: 'ptr-strict',
			children: ButtonHarness as never
		});
		expect(toolRegistry.getDeclarations().map((d) => d.name)).not.toContain('point_to_elements');
	});

	it('OMITS point_to_elements when pointerTool is explicitly flipped off', () => {
		configureExtensions({ pointerTool: false });
		render(StaticSurface, {
			surfaceId: 'ptr-off',
			children: ButtonHarness as never
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
		// toolResultSurfaceEcho defaults to 'full'.
		expect(result).not.toHaveProperty('extensions');
	});
});
