import { render, screen, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { actionRegistry } from '../core/registries/action-registry';
import { toolRegistry } from '../core/registries/tool-registry';
import ButtonActionHarness from './__fixtures__/ButtonActionHarness.svelte';

// jsdom has no `CSS` — the reveal/highlight helpers the click tool runs
// through call `CSS.escape(id)`. Passthrough stub; the fixture ids are
// CSS-safe so escaping is a no-op anyway.
beforeAll(() => {
	if (typeof (globalThis as any).CSS === 'undefined') {
		(globalThis as any).CSS = { escape: (s: string) => s };
	}
});

interface HarnessApi {
	getJson: () => { components: Array<{ id: string; component: Record<string, any> }> };
	clicks: () => Record<string, number>;
}

async function mountHarness(): Promise<HarnessApi> {
	let api!: HarnessApi;
	render(ButtonActionHarness, { onReady: (a: HarnessApi) => (api = a) });
	await tick();
	return api;
}

function buttonProps(api: HarnessApi, id: string): Record<string, any> {
	const node = api.getJson().components.find((c) => c.id === id);
	return node?.component.Button ?? {};
}

describe('Button — actions without an action prop', () => {
	beforeEach(() => {
		for (const t of toolRegistry.getDeclarations()) toolRegistry.unregister(t.name);
		for (const id of actionRegistry.listActions()) actionRegistry.unregister(id);
	});

	it('runs onclick on a human click with no action prop declared', async () => {
		const api = await mountHarness();

		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect(api.clicks()['plain-btn']).toBe(1);
	});

	it('registers the click action for every Button, handler or not', async () => {
		await mountHarness();

		expect(actionRegistry.has('plain-btn', 'click')).toBe(true);
		// On screen ⇒ in the tree ⇒ agent-targetable, even with nothing behind it.
		expect(actionRegistry.has('inert-btn', 'click')).toBe(true);
	});

	it('lands an agent click on the same handler the human hits', async () => {
		const api = await mountHarness();

		const result: any = await toolRegistry.execute('click_button', { element_id: 'plain-btn' });

		expect(result.results).toEqual([
			expect.objectContaining({ element_id: 'plain-btn', status: 'success' })
		]);
		expect(api.clicks()['plain-btn']).toBe(1);
	});

	it('serializes action.name equal to the component id by construction', async () => {
		const api = await mountHarness();

		expect(buttonProps(api, 'plain-btn').action).toEqual({ name: 'plain-btn' });
		expect(buttonProps(api, 'inert-btn').action).toEqual({ name: 'inert-btn' });
	});
});
