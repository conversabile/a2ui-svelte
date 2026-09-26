import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { processMessage } from './processor';
import { a2uiState } from './state.svelte';

const col = (children: string[]) => ({ Column: { children: { explicitList: children } } });
const text = (s: string) => ({ Text: { text: { literalString: s } } });

function push(surfaceId: string, components: Array<{ id: string; component: object }>) {
	return processMessage({ surfaceUpdate: { surfaceId, components } } as never);
}

function render(surfaceId: string, root: string) {
	return processMessage({ beginRendering: { surfaceId, root } } as never);
}

describe('processMessage — dynamic surface validation', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		for (const id of Object.keys(a2uiState.surfaces)) a2uiState.deleteSurface(id);
	});

	it('accepts a half-sent tree: no root yet, children still missing', () => {
		// The components arrive with `surfaceUpdate`, the root only with
		// `beginRendering` — so wiring can't be judged yet.
		expect(push('build', [{ id: 'main-col', component: col(['label']) }])).toEqual({
			status: 'success'
		});
		expect(a2uiState.getSurface('build')?.components['main-col']).toBeTruthy();
	});

	it('rejects a malformed component and leaves the previous tree standing', () => {
		push('bad-shape', [
			{ id: 'main-col', component: col(['label']) },
			{ id: 'label', component: text('before') }
		]);
		render('bad-shape', 'main-col');

		const result = push('bad-shape', [
			{ id: 'label', component: { Text: {}, Button: {} } as object }
		]);

		expect(result.status).toBe('error');
		expect(result.error).toContain('the surface is unchanged');
		expect(result.issues).toContainEqual(
			expect.objectContaining({
				componentId: 'label',
				message: 'component envelope must have exactly one type key, got [Text, Button]'
			})
		);
		// The tree the user is looking at is untouched.
		expect(a2uiState.getSurface('bad-shape')?.components['label']).toEqual({
			type: 'Text',
			properties: { text: { literalString: 'before' } }
		});
	});

	it('rejects beginRendering when the tree does not hang together, and does not render', () => {
		push('bad-wiring', [{ id: 'main-col', component: col(['never-sent']) }]);

		const result = render('bad-wiring', 'main-col');

		expect(result.status).toBe('error');
		expect(result.issues?.map((i) => i.message)).toContain(
			'references missing component "never-sent"'
		);
		expect(a2uiState.getSurface('bad-wiring')?.isRendering).toBe(false);
		expect(a2uiState.getSurface('bad-wiring')?.rootId).toBe(null);
	});

	it('renders a tree that hangs together', () => {
		push('good', [
			{ id: 'main-col', component: col(['label']) },
			{ id: 'label', component: text('hello') }
		]);

		expect(render('good', 'main-col')).toEqual({ status: 'success' });
		expect(a2uiState.getSurface('good')?.isRendering).toBe(true);
		expect(a2uiState.getSurface('good')?.rootId).toBe('main-col');
	});

	it('checks wiring on every update once the surface is on screen', () => {
		push('live', [
			{ id: 'main-col', component: col(['label']) },
			{ id: 'label', component: text('hello') }
		]);
		render('live', 'main-col');

		const result = push('live', [{ id: 'main-col', component: col(['label', 'ghost']) }]);

		expect(result.status).toBe('error');
		expect(result.issues?.map((i) => i.message)).toContain('references missing component "ghost"');
		expect(a2uiState.getSurface('live')?.components['main-col']).toEqual({
			type: 'Column',
			properties: { children: { explicitList: ['label'] } }
		});
	});

	it('accepts an update that detaches components, and keeps them buffered', () => {
		// v0.8 removes a component by dropping it from its parent's children;
		// there is no per-component delete, so an orphan is not an error.
		push('detach', [
			{ id: 'main-col', component: col(['old-a', 'old-b']) },
			{ id: 'old-a', component: text('a') },
			{ id: 'old-b', component: col(['never-sent']) }
		]);
		expect(render('detach', 'main-col').status).toBe('error'); // old-b is on screen
		push('detach', [{ id: 'old-b', component: text('b') }]);
		render('detach', 'main-col');

		const result = push('detach', [
			{ id: 'main-col', component: col(['title']) },
			{ id: 'title', component: text('new') },
			// Off screen, so its dangling reference is not wiring the user sees.
			{ id: 'parked', component: col(['never-sent']) }
		]);

		expect(result).toEqual({ status: 'success' });
		expect(Object.keys(a2uiState.getSurface('detach')!.components).sort()).toEqual([
			'main-col',
			'old-a',
			'old-b',
			'parked',
			'title'
		]);
	});

	it('lets a later update reattach a buffered component without resending it', () => {
		push('reattach', [
			{ id: 'main-col', component: col(['label']) },
			{ id: 'label', component: text('hello') }
		]);
		render('reattach', 'main-col');
		push('reattach', [{ id: 'main-col', component: col([]) }]);

		expect(push('reattach', [{ id: 'main-col', component: col(['label']) }])).toEqual({
			status: 'success'
		});
	});

	it('still checks the shape of components that are off screen', () => {
		push('parked-shape', [{ id: 'main-col', component: col([]) }]);
		render('parked-shape', 'main-col');

		const result = push('parked-shape', [
			{ id: 'parked', component: { Text: {}, Button: {} } as object }
		]);

		expect(result.status).toBe('error');
		expect(result.issues?.map((i) => i.componentId)).toEqual(['parked']);
	});

	it('judges the agent tree against the page catalog when one is published', () => {
		a2uiState.setCatalogTypes('custom', new Set(['Column', 'FancyGrid']));
		push('custom', [
			{ id: 'main-col', component: col(['grid']) },
			{ id: 'grid', component: { FancyGrid: {} } }
		]);

		expect(render('custom', 'main-col')).toEqual({ status: 'success' });
		expect(console.warn).not.toHaveBeenCalled();
	});

	it('warns without rejecting when the tree is legal but off-convention', () => {
		push('warny', [
			{ id: 'main_col', component: col(['label']) },
			{ id: 'label', component: text('hello') }
		]);

		expect(render('warny', 'main_col')).toEqual({ status: 'success' });
		expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('id is not kebab-case'));
	});

	it('reports an unrecognized message instead of silently doing nothing', () => {
		expect(processMessage({ somethingElse: {} } as never)).toEqual({
			status: 'error',
			error: 'unrecognized A2UI message'
		});
	});

	it('passes a dataModelUpdate through', () => {
		expect(
			processMessage({
				dataModelUpdate: { surfaceId: 'data', contents: [{ key: 'name', valueString: 'Anna' }] }
			} as never)
		).toEqual({ status: 'success' });
		expect(a2uiState.getSurface('data')?.data).toEqual({ name: 'Anna' });
	});
});
