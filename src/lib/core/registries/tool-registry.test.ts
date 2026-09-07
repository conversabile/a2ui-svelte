import { describe, it, expect, beforeEach } from 'vitest';
import { toolRegistry, type ToolDefinition } from './tool-registry';

function tool(name: string, marker: string): ToolDefinition {
	return {
		name,
		description: marker,
		parameters: { type: 'object', properties: {} },
		execute: async () => ({ marker })
	};
}

describe('ToolRegistry', () => {
	beforeEach(() => {
		for (const d of toolRegistry.getDeclarations()) toolRegistry.unregister(d.name);
	});

	it('holds one definition per name — a re-register replaces it', async () => {
		toolRegistry.register(tool('click_button', 'A'));
		toolRegistry.register(tool('click_button', 'B'));

		expect(toolRegistry.getDeclarations()).toHaveLength(1);
		expect(toolRegistry.getDeclarations()[0].description).toBe('B');
		expect(await toolRegistry.execute('click_button')).toEqual({ marker: 'B' });
	});

	it('unregister removes the name', () => {
		toolRegistry.register(tool('click_button', 'A'));
		toolRegistry.unregister('click_button');
		expect(toolRegistry.hasTools).toBe(false);
	});

	it('unregistering a name that was never registered is a no-op', async () => {
		toolRegistry.register(tool('click_button', 'A'));
		toolRegistry.unregister('never_registered');
		expect(await toolRegistry.execute('click_button')).toEqual({ marker: 'A' });
	});

	it('get() hands back the definition, so callers can read mutatesSurface', () => {
		toolRegistry.register({ ...tool('click_button', 'A'), mutatesSurface: true });
		toolRegistry.register(tool('point_to_elements', 'P'));

		expect(toolRegistry.get('click_button')!.mutatesSurface).toBe(true);
		expect(toolRegistry.get('point_to_elements')!.mutatesSurface).toBeUndefined();
		expect(toolRegistry.get('nope')).toBeUndefined();
	});

	it('reports an unknown tool as an error instead of throwing', async () => {
		expect(await toolRegistry.execute('nope')).toEqual({
			error: 'Tool "nope" is not registered'
		});
	});
});
