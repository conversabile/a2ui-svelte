import { render } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import DynamicSurface from './DynamicSurface.svelte';
import { extendCatalog, DEFAULT_CATALOG } from '../authoring';
import MyCustomTag from './__fixtures__/MyCustomTag.svelte';
import { a2uiState } from '../core/state.svelte';

describe('DynamicSurface catalog', () => {
	it('renders custom components from an extended catalog', async () => {
		const catalog = extendCatalog(DEFAULT_CATALOG, { MyCustomTag });
		a2uiState.getOrCreateSurface('test');
		a2uiState.updateComponent('test', 'root', {
			type: 'MyCustomTag',
			properties: { label: 'hello' }
		});
		a2uiState.setRoot('test', 'root');

		const { getByText } = render(DynamicSurface, { surfaceId: 'test', catalog });
		expect(getByText('hello')).toBeTruthy();
	});

	it('renders the missing-component warning when the type is not in the catalog', async () => {
		a2uiState.getOrCreateSurface('missing');
		a2uiState.updateComponent('missing', 'root', {
			type: 'NotInCatalog',
			properties: {}
		});
		a2uiState.setRoot('missing', 'root');

		const { container } = render(DynamicSurface, { surfaceId: 'missing' });
		const warn = container.querySelector('.a2ui-missing-component');
		expect(warn).toBeTruthy();
		expect(warn?.textContent).toContain('NotInCatalog');
	});
});
