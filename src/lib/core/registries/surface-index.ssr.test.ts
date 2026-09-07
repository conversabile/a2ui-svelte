import { render } from 'svelte/server';
import { describe, it, expect } from 'vitest';
import LifecycleSurface from '../../renderer/__fixtures__/LifecycleSurface.svelte';
import { mountedSurfaces } from './surface-index';

describe('surface index — SSR', () => {
	it('registers nothing during a server render', () => {
		const { body } = render(LifecycleSurface, {
			props: { surfaceId: 'planner', buttonId: 'save-btn', tag: 'A' }
		});

		expect(body).toContain('data-surface-id="planner"');
		expect(mountedSurfaces()).toEqual([]);
	});
});
