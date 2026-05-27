import { render } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import DynamicSurface from './DynamicSurface.svelte';
import { extendCatalog, DEFAULT_CATALOG } from '../authoring';
import MyCustomTag from './__fixtures__/MyCustomTag.svelte';
import MyOtherTag from './__fixtures__/MyOtherTag.svelte';
import { a2uiState } from '../core/state.svelte';
import { STANDARD_CATALOG_ID } from '../core/catalog-selection';

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

	it('B6: defaults to the catalog registered under STANDARD_CATALOG_ID when the agent omits catalogId', async () => {
		const standard = extendCatalog(DEFAULT_CATALOG, { MyCustomTag });
		a2uiState.getOrCreateSurface('uri-default');
		a2uiState.updateComponent('uri-default', 'root', {
			type: 'MyCustomTag',
			properties: { label: 'via-uri' }
		});
		a2uiState.setRoot('uri-default', 'root');

		const { getByText } = render(DynamicSurface, {
			surfaceId: 'uri-default',
			catalogs: { [STANDARD_CATALOG_ID]: standard }
		});
		expect(getByText('via-uri')).toBeTruthy();
	});

	it('B6: routes to a non-standard catalog when surface.catalogId matches a registered URI', async () => {
		const standard = extendCatalog(DEFAULT_CATALOG, { MyCustomTag });
		const custom = extendCatalog(DEFAULT_CATALOG, { MyCustomTag: MyOtherTag });
		const customUri = 'https://souschef.example/a2ui/v0_8/catalog';
		a2uiState.getOrCreateSurface('uri-custom');
		a2uiState.setCatalogId('uri-custom', customUri);
		a2uiState.updateComponent('uri-custom', 'root', {
			type: 'MyCustomTag',
			properties: { label: 'pick-me' }
		});
		a2uiState.setRoot('uri-custom', 'root');

		const { getByText } = render(DynamicSurface, {
			surfaceId: 'uri-custom',
			catalogs: { [STANDARD_CATALOG_ID]: standard, [customUri]: custom }
		});
		expect(getByText('other:pick-me')).toBeTruthy();
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
