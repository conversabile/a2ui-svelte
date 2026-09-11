import { render } from '@testing-library/svelte';
import { describe, it, expect, afterEach } from 'vitest';
import LifecycleSurface from '../renderer/__fixtures__/LifecycleSurface.svelte';
import FieldSurface from '../renderer/__fixtures__/FieldSurface.svelte';
import { toolRegistry } from '../core/registries/tool-registry';
import { configureExtensions } from '../core/extensions';
import { agentCall, agentClick, agentFill } from './agent-actor';

afterEach(() => configureExtensions({}));

describe('agentCall — a swallowed tool failure fails the test', () => {
	it('throws on an unknown tool, naming it', async () => {
		render(LifecycleSurface, { surfaceId: 's', buttonId: 'btn' });

		await expect(agentCall('no_such_tool')).rejects.toThrow(/no_such_tool/);
	});

	it('throws on an unknown element id, carrying the available ids', async () => {
		render(LifecycleSurface, { surfaceId: 's', buttonId: 'save-btn' });

		// The typo is the whole point: bare `execute` resolves and reports
		// nothing at the call site.
		await expect(agentClick('save-btnn')).rejects.toThrow(/Available IDs: .*save-btn/);
	});

	it('throws when the handler behind the button throws', async () => {
		render(LifecycleSurface, {
			surfaceId: 's',
			buttonId: 'boom-btn',
			onclick: () => {
				throw new Error('handler exploded');
			}
		});

		await expect(agentClick('boom-btn')).rejects.toThrow(/handler exploded/);
	});

	it('returns the whole result object on success', async () => {
		render(LifecycleSurface, { surfaceId: 's', buttonId: 'ok-btn' });

		expect(await agentClick('ok-btn')).toEqual({
			results: [{ element_id: 'ok-btn', status: 'success' }]
		});
	});

	it('fills a field and reports the resolved data-model key', async () => {
		render(FieldSurface, { surfaceId: 's', prefix: 'a' });

		expect(await agentFill('a-name', 'Giulia')).toMatchObject({
			results: [{ element_id: 'a-name', status: 'success' }]
		});
	});

	it('throws on an unrecognised status — fail-closed, not fail-open', async () => {
		// A tool whose result shape grew a status the helper has never heard
		// of. A `status === 'error'` check would pass this and lie.
		toolRegistry.register({
			name: 'future_tool',
			description: 'emits a status from the future',
			parameters: { type: 'object', properties: {} },
			execute: async () => ({ results: [{ element_id: 'x', status: 'rejected' }] })
		});

		await expect(agentCall('future_tool')).rejects.toThrow(/rejected/);

		toolRegistry.unregister('future_tool');
	});

	it('accepts point_to_elements on a mounted id', async () => {
		configureExtensions({ pointerTool: true });
		render(LifecycleSurface, { surfaceId: 's', buttonId: 'here-btn' });

		expect(await agentCall('point_to_elements', { element_ids: ['here-btn'] })).toEqual({
			results: [{ element_id: 'here-btn', status: 'success' }]
		});
	});

	it('throws when point_to_elements finds nothing', async () => {
		configureExtensions({ pointerTool: true });
		render(LifecycleSurface, { surfaceId: 's', buttonId: 'here-btn' });

		await expect(agentCall('point_to_elements', { element_ids: ['ghost'] })).rejects.toThrow(
			// The id is inside a JSON-stringified result, so the quotes are escaped.
			/No element \\"ghost\\"/
		);
	});
});
