import { render } from '@testing-library/svelte';
import { describe, it, expect, beforeEach } from 'vitest';
import StaticSurface from '../renderer/StaticSurface.svelte';
import { actionRegistry } from '../core/registries/action-registry';
import TextFieldHarness from './__fixtures__/TextFieldHarness.svelte';
import HiddenTextFieldHarness from './__fixtures__/HiddenTextFieldHarness.svelte';
import SaveTextFieldHarness from './__fixtures__/SaveTextFieldHarness.svelte';

describe('defineA2uiComponent contract', () => {
	beforeEach(() => {
		// Each test mounts a fresh surface with a unique id; clean the registry
		// for any leftover entries from prior tests to keep listActions() stable.
		for (const id of actionRegistry.listActions()) {
			actionRegistry.unregister(id);
		}
	});

	it('exposes data-a2ui-id on the rendered DOM root', () => {
		const { container } = render(StaticSurface, {
			surfaceId: 'test-attr',
			children: TextFieldHarness as never
		});
		const el = container.querySelector('[data-a2ui-id="username"]');
		expect(el).toBeTruthy();
	});

	it('registers the action callback so fire() dispatches into actionRegistry', async () => {
		render(StaticSurface, {
			surfaceId: 'test-fire',
			children: TextFieldHarness as never
		});
		expect(actionRegistry.has('username', 'update')).toBe(true);
		const result = await actionRegistry.execute('username', 'update', 'alice');
		expect(result).toMatchObject({ field: 'username' });
	});
});

describe('A2UIRepresentation', () => {
	beforeEach(() => {
		for (const id of actionRegistry.listActions()) {
			actionRegistry.unregister(id);
		}
	});

	it('hides built-in markup but still registers components', () => {
		const { container } = render(StaticSurface, {
			surfaceId: 'test-hidden',
			children: HiddenTextFieldHarness as never
		});
		// The hidden TextField should not produce its own input element.
		const hiddenInputs = container.querySelectorAll('.text-field-container');
		expect(hiddenInputs.length).toBe(0);
		// But the action is still registered.
		expect(actionRegistry.has('hidden-field', 'update')).toBe(true);
	});

	it('lets a composite invoke fire() through bind:this', async () => {
		const { getByText } = render(StaticSurface, {
			surfaceId: 'test-composite',
			children: SaveTextFieldHarness as never
		});
		// The composite renders bespoke buttons that proxy to the registered action.
		const result = await actionRegistry.execute('save-action', 'click');
		expect(result).toBeUndefined(); // click handler returns the onclick result
		expect(getByText('Save')).toBeTruthy();
	});
});
