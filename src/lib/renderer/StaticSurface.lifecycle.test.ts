import { render } from '@testing-library/svelte';
import { describe, it, expect, beforeEach } from 'vitest';
import LifecycleSurface from './__fixtures__/LifecycleSurface.svelte';
import { toolRegistry } from '../core/registries/tool-registry';
import { actionRegistry } from '../core/registries/action-registry';
import { A2UI_EXTENSION_NAMESPACE } from '../core/extensions';

/** The `tag` of the surface whose `click_button` handled the call. */
async function whoHandledClick(elementId: string): Promise<string | undefined> {
	const result = await toolRegistry.execute('click_button', { element_id: elementId });
	const extras = (result as any).extensions?.[A2UI_EXTENSION_NAMESPACE];
	return extras?.updatedContext;
}

describe('StaticSurface — tool lifecycle', () => {
	beforeEach(() => {
		for (const d of toolRegistry.getDeclarations()) toolRegistry.unregister(d.name);
		for (const id of actionRegistry.listActions()) actionRegistry.unregister(id);
	});

	it('registers its tools on mount and removes them on unmount', () => {
		const { unmount } = render(LifecycleSurface, {
			surfaceId: 'solo',
			buttonId: 'solo-btn',
			tag: 'solo'
		});
		expect(toolRegistry.getDeclarations().map((d) => d.name)).toContain('click_button');

		unmount();
		expect(toolRegistry.hasTools).toBe(false);
	});

	it('unmounting one of two surfaces leaves the other surface driving the shared tool', async () => {
		const a = render(LifecycleSurface, { surfaceId: 'a', buttonId: 'a-btn', tag: 'A' });
		render(LifecycleSurface, { surfaceId: 'b', buttonId: 'b-btn', tag: 'B' });

		a.unmount();

		// Still declared, and now handled by the surface that is still mounted.
		expect(toolRegistry.getDeclarations().map((d) => d.name)).toContain('click_button');
		expect(await whoHandledClick('b-btn')).toBe('B');
	});

	it('unmounting the surface that shadowed the tool hands it back to the one still mounted', async () => {
		render(LifecycleSurface, { surfaceId: 'a', buttonId: 'a-btn', tag: 'A' });
		const b = render(LifecycleSurface, { surfaceId: 'b', buttonId: 'b-btn', tag: 'B' });

		expect(await whoHandledClick('a-btn')).toBe('B');

		b.unmount();
		expect(await whoHandledClick('a-btn')).toBe('A');
	});

	it('the last surface to unmount empties the registry', () => {
		const a = render(LifecycleSurface, { surfaceId: 'a', buttonId: 'a-btn', tag: 'A' });
		const b = render(LifecycleSurface, { surfaceId: 'b', buttonId: 'b-btn', tag: 'B' });

		a.unmount();
		expect(toolRegistry.hasTools).toBe(true);
		b.unmount();
		expect(toolRegistry.hasTools).toBe(false);
	});
});
