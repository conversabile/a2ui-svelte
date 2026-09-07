import { render } from '@testing-library/svelte';
import { describe, it, expect, vi, afterEach } from 'vitest';
import LifecycleSurface from '../../renderer/__fixtures__/LifecycleSurface.svelte';
import DynamicSurface from '../../renderer/DynamicSurface.svelte';
import { mountedSurfaces, surface, mountedStaticSurfaceCount } from './surface-index';

/** Component ids of a static surface's serialized tree — enough to tell two apart. */
function elementIds(json: unknown): string[] {
	return ((json as any).components ?? []).map((c: any) => c.id);
}

describe('surface index', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('lists every mounted surface, and resolves one by id', () => {
		render(LifecycleSurface, { surfaceId: 'planner', buttonId: 'save-btn' });
		render(DynamicSurface, { surfaceId: 'canvas' });

		expect(mountedSurfaces().map((s) => s.id)).toEqual(['planner', 'canvas']);
		expect(surface('planner')?.type).toBe('static');
		expect(surface('canvas')?.type).toBe('dynamic');
		expect(surface('nope')).toBeUndefined();
		// Only the static surface counts — the built-in tools have nothing to
		// drive on a canvas the agent renders itself.
		expect(mountedStaticSurfaceCount()).toBe(1);
	});

	it('the registered handle reads the live surface', () => {
		render(LifecycleSurface, { surfaceId: 'planner', buttonId: 'save-btn' });

		expect(elementIds(surface('planner')!.getJson())).toContain('save-btn');
		expect(surface('planner')!.getDataModel?.()).toEqual({});
	});

	it('drops a surface when it unmounts', () => {
		const a = render(LifecycleSurface, { surfaceId: 'a', buttonId: 'a-btn' });
		render(LifecycleSurface, { surfaceId: 'b', buttonId: 'b-btn' });

		a.unmount();

		expect(mountedSurfaces().map((s) => s.id)).toEqual(['b']);
		expect(surface('a')).toBeUndefined();
		expect(mountedStaticSurfaceCount()).toBe(1);
	});

	it('warns on a duplicate id, and the last mounted wins', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		render(LifecycleSurface, { surfaceId: 'dup', buttonId: 'first-btn' });
		render(LifecycleSurface, { surfaceId: 'dup', buttonId: 'second-btn' });

		expect(warn).toHaveBeenCalledWith(expect.stringContaining('"dup"'));
		expect(mountedSurfaces()).toHaveLength(1);
		expect(elementIds(surface('dup')!.getJson())).toContain('second-btn');
	});

	it('a duplicate unmounting does not evict the surface that replaced it', () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const first = render(LifecycleSurface, { surfaceId: 'dup', buttonId: 'first-btn' });
		render(LifecycleSurface, { surfaceId: 'dup', buttonId: 'second-btn' });

		first.unmount();

		expect(elementIds(surface('dup')!.getJson())).toContain('second-btn');
	});
});
