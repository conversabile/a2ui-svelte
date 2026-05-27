import { describe, it, expect } from 'vitest';
import {
	STANDARD_CATALOG_ID,
	STANDARD_CATALOG_ALIAS,
	getClientCapabilities,
	getAgentCardExtensionParams
} from './catalog-selection';
import type { Catalog } from '../authoring/catalog';

const emptyCatalog: Catalog = {};

describe('catalog selection — STANDARD_CATALOG_ID', () => {
	it('is the canonical v0.8 standard catalog URI', () => {
		expect(STANDARD_CATALOG_ID).toBe(
			'https://a2ui.org/specification/v0_8/standard_catalog_definition.json'
		);
	});
});

describe('getClientCapabilities', () => {
	it('always advertises the standard catalog, even with no registry', () => {
		expect(getClientCapabilities()).toEqual({
			supportedCatalogIds: [STANDARD_CATALOG_ID]
		});
	});

	it('includes URI-keyed catalogs verbatim', () => {
		const custom = 'https://souschef.example/a2ui/v0_8/catalog';
		const caps = getClientCapabilities({
			[STANDARD_CATALOG_ID]: emptyCatalog,
			[custom]: emptyCatalog
		});
		expect(caps.supportedCatalogIds).toEqual(
			expect.arrayContaining([STANDARD_CATALOG_ID, custom])
		);
		expect(caps.supportedCatalogIds).toHaveLength(2);
	});

	it("normalises the 'standard' alias to the canonical URI", () => {
		const caps = getClientCapabilities({
			[STANDARD_CATALOG_ALIAS]: emptyCatalog
		});
		expect(caps.supportedCatalogIds).toEqual([STANDARD_CATALOG_ID]);
	});

	it('deduplicates when both alias and URI are present', () => {
		const caps = getClientCapabilities({
			[STANDARD_CATALOG_ALIAS]: emptyCatalog,
			[STANDARD_CATALOG_ID]: emptyCatalog
		});
		expect(caps.supportedCatalogIds).toEqual([STANDARD_CATALOG_ID]);
	});

	it('does NOT include acceptsInlineCatalogs (server-side only)', () => {
		const caps = getClientCapabilities();
		expect(caps).not.toHaveProperty('acceptsInlineCatalogs');
	});
});

describe('getAgentCardExtensionParams', () => {
	it('combines client supportedCatalogIds with the server-side acceptsInlineCatalogs flag', () => {
		const params = getAgentCardExtensionParams({
			catalogs: { [STANDARD_CATALOG_ID]: emptyCatalog },
			acceptsInlineCatalogs: true
		});
		expect(params).toEqual({
			supportedCatalogIds: [STANDARD_CATALOG_ID],
			acceptsInlineCatalogs: true
		});
	});
});
