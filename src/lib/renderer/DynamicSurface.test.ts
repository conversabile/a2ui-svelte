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

	it('renders a Tabs built from JSON, pairing tabItems with their child components', async () => {
		a2uiState.getOrCreateSurface('tabs');
		a2uiState.updateComponent('tabs', 'tabs-root', {
			type: 'Tabs',
			properties: {
				tabItems: [
					{ title: { literalString: 'First' }, child: 'panel-a' },
					{ title: { literalString: 'Second' }, child: 'panel-b' }
				]
			}
		});
		a2uiState.updateComponent('tabs', 'panel-a', {
			type: 'Text',
			properties: { text: { literalString: 'Panel A body' } }
		});
		a2uiState.updateComponent('tabs', 'panel-b', {
			type: 'Text',
			properties: { text: { literalString: 'Panel B body' } }
		});
		a2uiState.setRoot('tabs', 'tabs-root');

		const { getByText } = render(DynamicSurface, { surfaceId: 'tabs' });
		// Tab headers carry the resolved titles…
		expect(getByText('First')).toBeTruthy();
		expect(getByText('Second')).toBeTruthy();
		// …and each panel's child component is rendered via `renderChild`.
		expect(getByText('Panel A body')).toBeTruthy();
		expect(getByText('Panel B body')).toBeTruthy();
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
