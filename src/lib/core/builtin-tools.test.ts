import { render } from '@testing-library/svelte';
import { describe, it, expect, afterEach } from 'vitest';
import LifecycleSurface from '../renderer/__fixtures__/LifecycleSurface.svelte';
import ButtonHarness from '../renderer/__fixtures__/ButtonHarness.svelte';
import StaticSurface from '../renderer/StaticSurface.svelte';
import { toolRegistry } from './registries/tool-registry';
import { STRICT, ALL_EXTRAS, configureExtensions } from './extensions';

// The extensions are one app-wide record, so every test that changes it
// restores the default — `configureExtensions` is an absolute set, so `{}`
// is the reset.
afterEach(() => configureExtensions({}));

const names = () => toolRegistry.getDeclarations().map((d) => d.name);

describe('built-in tools — lifecycle, driven by the surface index', () => {
	it('installs them when the first static surface mounts and drops them with the last', () => {
		expect(toolRegistry.hasTools).toBe(false);

		const { unmount } = render(LifecycleSurface, {
			surfaceId: 'solo',
			buttonId: 'solo-btn'
		});
		expect(names()).toContain('click_button');

		unmount();
		expect(toolRegistry.hasTools).toBe(false);
	});

	it('two mounted surfaces share ONE click_button that drives either element', async () => {
		const a = render(LifecycleSurface, { surfaceId: 'a', buttonId: 'a-btn' });
		render(LifecycleSurface, { surfaceId: 'b', buttonId: 'b-btn' });

		// One registration, not one per surface.
		expect(names().filter((n) => n === 'click_button')).toHaveLength(1);

		// And the ONE tool reaches elements in both surfaces — element ids
		// resolve through the global action registry, so the owning surface
		// never matters.
		for (const id of ['a-btn', 'b-btn']) {
			const result = await toolRegistry.execute('click_button', { element_id: id });
			expect(result).toEqual({ results: [{ element_id: id, status: 'success' }] });
		}

		// Unmounting one leaves the tool live for the other.
		a.unmount();
		expect(names()).toContain('click_button');
		expect(await toolRegistry.execute('click_button', { element_id: 'b-btn' })).toEqual({
			results: [{ element_id: 'b-btn', status: 'success' }]
		});
	});

	it('the last surface to unmount empties the registry', () => {
		const a = render(LifecycleSurface, { surfaceId: 'a', buttonId: 'a-btn' });
		const b = render(LifecycleSurface, { surfaceId: 'b', buttonId: 'b-btn' });

		a.unmount();
		expect(toolRegistry.hasTools).toBe(true);
		b.unmount();
		expect(toolRegistry.hasTools).toBe(false);
	});
});

describe('built-in tools — what gets registered', () => {
	it('always registers click_button / update_text_field', () => {
		render(StaticSurface, { surfaceId: 'spec-default', children: ButtonHarness as never });
		expect(names()).toContain('click_button');
		expect(names()).toContain('update_text_field');

		const click = toolRegistry.get('click_button')!;
		expect(click.parameters.properties).toHaveProperty('element_id');
		expect(click.parameters.required).toEqual(['element_id']);
		expect(click.mutatesSurface).toBe(true);

		const update = toolRegistry.get('update_text_field')!;
		expect(update.parameters.properties).toHaveProperty('element_id');
		expect(update.parameters.properties).toHaveProperty('value');
		expect(update.parameters.required).toEqual(['element_id', 'value']);
		expect(update.mutatesSurface).toBe(true);
	});

	it('registers the batch variants by default (ALL_EXTRAS)', () => {
		render(StaticSurface, { surfaceId: 'batch-default', children: ButtonHarness as never });
		expect(names()).toContain('click_buttons');
		expect(names()).toContain('update_text_fields');
		expect(toolRegistry.get('click_buttons')!.parameters.required).toEqual(['clicks']);
		expect(toolRegistry.get('update_text_fields')!.parameters.required).toEqual(['updates']);
	});

	it('also registers them when explicitly configured as ALL_EXTRAS', () => {
		configureExtensions(ALL_EXTRAS);
		render(StaticSurface, { surfaceId: 'batch-explicit', children: ButtonHarness as never });
		expect(names()).toContain('click_buttons');
		expect(names()).toContain('update_text_fields');
	});

	it('OMITS the batch variants under STRICT — but keeps the single-element pair', () => {
		configureExtensions(STRICT);
		render(StaticSurface, { surfaceId: 'strict-no-batch', children: ButtonHarness as never });
		expect(names()).toContain('click_button');
		expect(names()).toContain('update_text_field');
		expect(names()).not.toContain('click_buttons');
		expect(names()).not.toContain('update_text_fields');
	});

	it('OMITS the batch variants when batchTools is explicitly flipped off', () => {
		configureExtensions({ batchTools: false });
		render(StaticSurface, { surfaceId: 'no-batch', children: ButtonHarness as never });
		expect(names()).toContain('click_button');
		expect(names()).not.toContain('click_buttons');
	});

	it('registers point_to_elements by default and omits it under STRICT', () => {
		const first = render(StaticSurface, {
			surfaceId: 'ptr-default',
			children: ButtonHarness as never
		});
		expect(names()).toContain('point_to_elements');
		expect(toolRegistry.get('point_to_elements')!.parameters.required).toEqual(['element_ids']);
		// Purely visual ⇒ never carries the echo.
		expect(toolRegistry.get('point_to_elements')!.mutatesSurface).toBeUndefined();
		first.unmount();

		configureExtensions(STRICT);
		render(StaticSurface, { surfaceId: 'ptr-strict', children: ButtonHarness as never });
		expect(names()).not.toContain('point_to_elements');
	});

	it('OMITS point_to_elements when pointerTool is explicitly flipped off', () => {
		configureExtensions({ pointerTool: false });
		render(StaticSurface, { surfaceId: 'ptr-off', children: ButtonHarness as never });
		expect(names()).not.toContain('point_to_elements');
	});
});

describe('built-in tools — results carry no echo', () => {
	it('click_button returns bare { results }, with no echo of its own', async () => {
		render(StaticSurface, { surfaceId: 'click-exec', children: ButtonHarness as never });
		const result = await toolRegistry.execute('click_button', { element_id: 'save-btn' });
		// The echo is the Agent's job — a tool called directly by an
		// external agent gets the bare result and nothing else.
		expect(result).toEqual({ results: [{ element_id: 'save-btn', status: 'success' }] });
	});

	it('the batch form returns one entry per element', async () => {
		render(StaticSurface, { surfaceId: 'batch-exec', children: ButtonHarness as never });
		const result = await toolRegistry.execute('click_buttons', {
			clicks: [{ element_id: 'save-btn' }, { element_id: 'save-btn' }]
		});
		expect(result).toEqual({
			results: [
				{ element_id: 'save-btn', status: 'success' },
				{ element_id: 'save-btn', status: 'success' }
			]
		});
	});

	it('reports found vs missing IDs for point_to_elements', async () => {
		render(StaticSurface, { surfaceId: 'ptr-exec', children: ButtonHarness as never });
		// ButtonHarness renders <button data-a2ui-id="save-btn">, so the pointer
		// can resolve it in the DOM; the second id has no matching node.
		const result = await toolRegistry.execute('point_to_elements', {
			element_ids: ['save-btn', 'does-not-exist']
		});
		expect(result).toEqual({
			results: [
				{ element_id: 'save-btn', status: 'pointed' },
				{ element_id: 'does-not-exist', status: 'not_found' }
			]
		});
	});

	it('a failing element reports status error, not silent success', async () => {
		render(StaticSurface, { surfaceId: 'click-missing', children: ButtonHarness as never });
		const result = (await toolRegistry.execute('click_button', {
			element_id: 'no-such-button'
		})) as { results: Array<{ status: string }> };
		expect(result.results[0].status).toBe('error');
	});
});
