import { render } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import LifecycleSurface from '../renderer/__fixtures__/LifecycleSurface.svelte';
import '../core/dev-global';

describe('window.__a2ui', () => {
	it('is installed under DEV', () => {
		expect(import.meta.env.DEV).toBe(true);
		expect(typeof window.__a2ui?.execute).toBe('function');
	});

	it('reads the registries through', async () => {
		const { unmount } = render(LifecycleSurface, {
			surfaceId: 'dev-global-surface',
			buttonId: 'dev-global-btn'
		});
		const api = window.__a2ui!;

		expect(api.tools()).toContain('click_button');
		expect(api.surfaces()).toEqual(['dev-global-surface']);

		// The sole mounted surface, so no id is needed.
		const json = api.json() as { components: Array<{ id: string }> };
		expect(json.components.map((c) => c.id)).toContain('dev-global-btn');
		expect(api.json('dev-global-surface')).toEqual(json);

		// `execute` reaches the tool registry and really clicks.
		const result = (await api.execute('click_button', {
			element_id: 'dev-global-btn'
		})) as { results: Array<{ element_id: string; status: string }> };
		expect(result.results).toEqual([{ element_id: 'dev-global-btn', status: 'success' }]);

		unmount();
	});

	it('throws with the mounted ids when the surface cannot be picked', () => {
		expect(() => window.__a2ui!.json()).toThrow(/mounted: \(none\)/);
		expect(() => window.__a2ui!.json('nope')).toThrow(/No surface "nope" is mounted/);
	});
});
