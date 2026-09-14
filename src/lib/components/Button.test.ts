import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { describe, it, expect, beforeEach } from 'vitest';
import { actionRegistry } from '../core/registries/action-registry';
import { toolRegistry } from '../core/registries/tool-registry';
import ButtonActionHarness from './__fixtures__/ButtonActionHarness.svelte';
import ButtonChildHarness from './__fixtures__/ButtonChildHarness.svelte';

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

		await userEvent.click(screen.getByRole('button', { name: 'Save' }));

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

describe('Button — child resolution', () => {
	interface ChildHarnessApi {
		getJson: () => { components: Array<{ id: string; component: Record<string, any> }> };
		setLateLabel: (next: string | undefined) => void;
	}

	async function mountChildHarness(): Promise<ChildHarnessApi> {
		let api!: ChildHarnessApi;
		render(ButtonChildHarness, { onReady: (a: ChildHarnessApi) => (api = a) });
		await tick();
		return api;
	}

	function buttonProps(api: ChildHarnessApi, id: string): Record<string, any> {
		const node = api.getJson().components.find((c) => c.id === id);
		return node?.component.Button ?? {};
	}

	it('takes a real `children` component as `child` instead of a synthetic label', async () => {
		const api = await mountChildHarness();

		const json = api.getJson();
		expect(buttonProps(api, 'icon-btn').child).toBe('icon-btn-icon');
		// No synthetic `icon-btn-label` Text node — nothing to be, `label` was never set.
		expect(json.components.some((c) => c.id === 'icon-btn-label')).toBe(false);
		expect(json.components.some((c) => c.id === 'icon-btn-icon' && 'Icon' in c.component)).toBe(
			true
		);
	});

	it('registers the label Text node once `label` arrives after mount, not only at setup', async () => {
		const api = await mountChildHarness();

		// Absent at mount: no `child`, no synthetic Text node yet.
		expect(buttonProps(api, 'late-label-btn').child).toBeUndefined();
		expect(api.getJson().components.some((c) => c.id === 'late-label-btn-label')).toBe(false);

		api.setLateLabel('Confirm');
		await tick();

		const json = api.getJson();
		expect(buttonProps(api, 'late-label-btn').child).toBe('late-label-btn-label');
		const labelNode = json.components.find((c) => c.id === 'late-label-btn-label');
		expect(labelNode?.component.Text.text).toEqual({ literalString: 'Confirm' });
	});

	it('unregisters the synthetic label Text node when `label` is cleared again', async () => {
		const api = await mountChildHarness();
		api.setLateLabel('Confirm');
		await tick();

		api.setLateLabel(undefined);
		await tick();

		expect(buttonProps(api, 'late-label-btn').child).toBeUndefined();
		expect(api.getJson().components.some((c) => c.id === 'late-label-btn-label')).toBe(false);
	});
});
