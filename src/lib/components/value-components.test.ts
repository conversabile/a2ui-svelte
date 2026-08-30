import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { actionRegistry } from '../core/registries/action-registry';
import { toolRegistry } from '../core/registries/tool-registry';
import ValueComponentsHarness from './__fixtures__/ValueComponentsHarness.svelte';

// jsdom has no `CSS` — the reveal/highlight helpers the update tool runs
// through call `CSS.escape(id)`. Passthrough stub; the generated ids are
// CSS-safe so escaping is a no-op anyway.
beforeAll(() => {
	if (typeof (globalThis as any).CSS === 'undefined') {
		(globalThis as any).CSS = { escape: (s: string) => s };
	}
});

interface HarnessApi {
	ids: Record<string, string | undefined>;
	getDataModel: () => Record<string, unknown>;
	values: () => Record<string, unknown>;
}

async function mountHarness(): Promise<HarnessApi> {
	let api!: HarnessApi;
	render(ValueComponentsHarness, { onReady: (a: HarnessApi) => (api = a) });
	await tick();
	return api;
}

async function update(elementId: string, value: string) {
	const result = await toolRegistry.execute('update_text_field', {
		element_id: elementId,
		value
	});
	return (result.results as Record<string, unknown>[])[0];
}

describe('value-bearing components — the reported data-model key', () => {
	beforeEach(() => {
		for (const t of toolRegistry.getDeclarations()) toolRegistry.unregister(t.name);
		for (const id of actionRegistry.listActions()) actionRegistry.unregister(id);
	});

	// With neither `id` nor `fieldName`, the data-model key is the
	// auto-generated component id — so that is what the tool result must name.
	// Reporting `''` (or a hardcoded label) tells the model it wrote a field
	// that does not exist.
	const cases: { name: string; key: keyof HarnessApi['ids']; value: string }[] = [
		{ name: 'Checkbox', key: 'checkbox', value: 'true' },
		{ name: 'Slider', key: 'slider', value: '7' },
		{ name: 'DateTimeInput', key: 'dateTime', value: '2026-08-30' },
		{ name: 'MultipleChoice', key: 'choice', value: 'large' }
	];

	for (const c of cases) {
		it(`${c.name} reports its component id as the field when no fieldName is given`, async () => {
			const api = await mountHarness();
			const id = api.ids[c.key]!;
			expect(id).toBeTruthy();

			const result = await update(id, c.value);

			expect(result).toMatchObject({ element_id: id, status: 'success', field: id });
			// The key it reports is the key the agent reads back.
			expect(api.getDataModel()).toHaveProperty(id);
		});
	}

	it('Tabs reports its component id, not a hardcoded "tabs"', async () => {
		const api = await mountHarness();
		const id = api.ids.tabs!;
		expect(id).toBeTruthy();

		const result = await update(id, 'Two');

		expect(result).toMatchObject({ element_id: id, status: 'success', field: id });
	});

	it('lands the agent value in the bound state of every component', async () => {
		const api = await mountHarness();

		await update(api.ids.checkbox!, 'true');
		await update(api.ids.slider!, '7');
		await update(api.ids.dateTime!, '2026-08-30');
		await update(api.ids.choice!, 'large');
		await tick();

		expect(api.values()).toEqual({
			checked: true,
			sliderValue: 7,
			when: '2026-08-30',
			selections: ['large']
		});
	});
});
