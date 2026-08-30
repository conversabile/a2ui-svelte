import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, it, expect, beforeEach } from 'vitest';
import { actionRegistry } from '../core/registries/action-registry';
import { toolRegistry } from '../core/registries/tool-registry';
import TextFieldWritabilityHarness from './__fixtures__/TextFieldWritabilityHarness.svelte';

interface HarnessApi {
	getDataModel: () => Record<string, unknown>;
	idOnly: () => string;
	withFieldName: () => string;
}

async function mountHarness(): Promise<HarnessApi> {
	let api!: HarnessApi;
	render(TextFieldWritabilityHarness, { onReady: (a: HarnessApi) => (api = a) });
	await tick();
	return api;
}

describe('TextField — agent writability', () => {
	beforeEach(() => {
		for (const t of toolRegistry.getDeclarations()) toolRegistry.unregister(t.name);
		for (const id of actionRegistry.listActions()) actionRegistry.unregister(id);
	});

	it('registers the update action whether or not an explicit fieldName is given', async () => {
		await mountHarness();
		expect(actionRegistry.has('with-field', 'update')).toBe(true);
		expect(actionRegistry.has('only-id', 'update')).toBe(true);
	});

	it('lands an agent fill on an id-only field in the data model and the bound value', async () => {
		const api = await mountHarness();

		const result = await toolRegistry.execute('update_text_field', {
			element_id: 'only-id',
			value: 'Ada'
		});

		expect(result.results).toEqual([
			expect.objectContaining({ element_id: 'only-id', status: 'success', field: 'only-id' })
		]);
		// The value reached the consumer's `$state`...
		expect(api.idOnly()).toBe('Ada');
		// ...and the data model the agent reads back, keyed by the component id.
		expect(api.getDataModel()['only-id']).toBe('Ada');
	});

	it('keys an explicit fieldName by that field, not by the component id', async () => {
		const api = await mountHarness();

		const result = await toolRegistry.execute('update_text_field', {
			element_id: 'with-field',
			value: 'Lovelace'
		});

		expect(result.results).toEqual([
			expect.objectContaining({ element_id: 'with-field', status: 'success', field: 'shared-key' })
		]);
		expect(api.withFieldName()).toBe('Lovelace');
		const dataModel = api.getDataModel();
		expect(dataModel['shared-key']).toBe('Lovelace');
		expect(dataModel).not.toHaveProperty('with-field');
	});

	it('serializes both fields as agent-targetable ids in the surface JSON', async () => {
		await mountHarness();
		// Everything the agent can see it must be able to write: the ids the
		// tool advertises and the ids in the tree are the same set.
		expect(actionRegistry.listActions('textfield-writability').sort()).toEqual([
			'only-id',
			'with-field'
		]);
	});
});
