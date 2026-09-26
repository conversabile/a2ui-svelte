import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { processMessage } from './processor';
import { serializeSurface } from './serializer';
import { a2uiState } from './state.svelte';

const col = (children: string[]) => ({ Column: { children: { explicitList: children } } });
const text = (s: string) => ({ Text: { text: { literalString: s } } });

function push(surfaceId: string, components: Array<{ id: string; component: object }>) {
	return processMessage({ surfaceUpdate: { surfaceId, components } } as never);
}

const ids = (surfaceId: string) =>
	(serializeSurface(surfaceId) as { components: Array<{ id: string }> }).components.map((c) => c.id);

describe('serializeSurface', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		for (const id of Object.keys(a2uiState.surfaces)) a2uiState.deleteSurface(id);
	});

	it('emits the whole buffer before beginRendering names a root', () => {
		push('pending', [
			{ id: 'main-col', component: col(['label']) },
			{ id: 'label', component: text('hello') }
		]);

		expect(ids('pending')).toEqual(['main-col', 'label']);
	});

	it('omits components detached from the root (screen/tree parity)', () => {
		push('detached', [
			{ id: 'main-col', component: col(['old', 'card']) },
			{ id: 'old', component: text('old') },
			{ id: 'card', component: { Card: { child: 'inner' } } },
			{ id: 'inner', component: text('inner') }
		]);
		processMessage({ beginRendering: { surfaceId: 'detached', root: 'main-col' } } as never);
		push('detached', [{ id: 'main-col', component: col(['card']) }]);

		expect(ids('detached')).toEqual(['main-col', 'card', 'inner']);
		expect(a2uiState.getSurface('detached')?.components['old']).toBeTruthy();
	});
});
