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

describe('ToolRegistry — provider stacks', () => {
	beforeEach(() => {
		for (const d of toolRegistry.getDeclarations()) toolRegistry.unregister(d.name);
	});

	it('declares and executes the most recently registered provider of a name', async () => {
		toolRegistry.register(tool('click_button', 'A'));
		toolRegistry.register(tool('click_button', 'B'));

		expect(toolRegistry.getDeclarations()).toHaveLength(1);
		expect(toolRegistry.getDeclarations()[0].description).toBe('B');
		expect(await toolRegistry.execute('click_button')).toEqual({ marker: 'B' });
	});

	it('unregistering one provider leaves the other declared, whichever order', async () => {
		const a = tool('click_button', 'A');
		const b = tool('click_button', 'B');
		toolRegistry.register(a);
		toolRegistry.register(b);

		// Remove the shadowed one: the live provider is untouched.
		toolRegistry.unregister('click_button', a);
		expect(toolRegistry.size).toBe(1);
		expect(await toolRegistry.execute('click_button')).toEqual({ marker: 'B' });

		// Re-register A behind B, then remove the live one: A becomes live again.
		toolRegistry.register(a);
		toolRegistry.unregister('click_button', b);
		expect(toolRegistry.size).toBe(1);
		expect(await toolRegistry.execute('click_button')).toEqual({ marker: 'A' });

		toolRegistry.unregister('click_button', a);
		expect(toolRegistry.hasTools).toBe(false);
	});

	it('unregister without a provider removes the name entirely', () => {
		toolRegistry.register(tool('click_button', 'A'));
		toolRegistry.register(tool('click_button', 'B'));

		toolRegistry.unregister('click_button');
		expect(toolRegistry.hasTools).toBe(false);
	});

	it('re-registering the same definition does not stack it twice', () => {
		const a = tool('click_button', 'A');
		toolRegistry.register(a);
		toolRegistry.register(a);

		toolRegistry.unregister('click_button', a);
		expect(toolRegistry.hasTools).toBe(false);
	});

	it('unregistering a provider that was never registered is a no-op', async () => {
		const a = tool('click_button', 'A');
		toolRegistry.register(a);

		toolRegistry.unregister('click_button', tool('click_button', 'ghost'));
		expect(await toolRegistry.execute('click_button')).toEqual({ marker: 'A' });
	});
});
