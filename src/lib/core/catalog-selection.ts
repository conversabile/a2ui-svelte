/**
 * A2UI v0.8 catalog selection handshake.
 *
 * The spec describes catalog selection as a one-shot handshake (NOT a
 * negotiation):
 *
 *   1. The **server** advertises which catalogs it can drive via its
 *      AgentCard (`AgentCapabilities.extensions[].params`).
 *   2. The **client** declares its supported catalogs in **every** outbound
 *      A2A message's metadata under the `a2uiClientCapabilities` key.
 *   3. The server picks a `catalogId` per surface via `beginRendering`. If
 *      omitted, the client MUST default to the standard catalog for the
 *      protocol version (per A2UI v0.8 §2.1.3).
 *
 * This module gives the **client-side** building blocks: a canonical URI
 * for the v0.8 standard catalog, a derivation of client capabilities from a
 * catalogs registry, and a separate helper for server-side AgentCard
 * extension params (in case the library ever ships such a builder).
 */
import type { Catalog } from '../authoring/catalog';

/**
 * Canonical v0.8 standard catalog identifier (URI form, per the A2UI v0.8
 * specification). When `beginRendering` omits `catalogId`, the renderer
 * resolves it to this URI before catalog lookup.
 */
export const STANDARD_CATALOG_ID =
	'https://a2ui.org/specification/v0_8/standard_catalog_definition.json';

/**
 * Convenience alias accepted in the catalogs registry alongside the URI. Hosts
 * may register the standard catalog under either key; the renderer falls back
 * through `surface.catalogId → STANDARD_CATALOG_ID → 'standard'` in turn.
 */
export const STANDARD_CATALOG_ALIAS = 'standard';

/**
 * Inline catalog descriptor as defined by `catalog_description_schema.json`
 * (v0.8). All three fields are REQUIRED — use `styles: {}` when the catalog
 * declares no theme.
 */
export interface CatalogDescription {
	catalogId: string;
	components: Record<string, unknown>;
	styles: Record<string, unknown>;
}

/**
 * Shape of the `a2uiClientCapabilities` metadata blob that must accompany
 * **every** outbound A2A `Message` (per A2UI v0.8 §2.1.2). Mirrors
 * `a2ui_client_capabilities_schema.json`.
 *
 * Note: `acceptsInlineCatalogs` is **NOT** part of this object — that flag
 * lives on the server side (see `getAgentCardExtensionParams`).
 */
export interface A2UIClientCapabilities {
	supportedCatalogIds: string[];
	inlineCatalogs?: CatalogDescription[];
}

/**
 * Derive the client capabilities for an A2A handshake from the catalogs the
 * renderer is willing to render. The result is suitable for direct injection
 * into A2A message metadata under the `a2uiClientCapabilities` key.
 *
 * The standard catalog URI is always advertised — per spec, a client without
 * the standard catalog cannot interoperate at all.
 *
 * @param catalogs Registry passed to `<DynamicSurface catalogs={...} />`.
 *                 Keys may be URIs or the `'standard'` alias. Both forms are
 *                 normalised to the canonical URI in the output.
 */
export function getClientCapabilities(
	catalogs?: Record<string, Catalog>
): A2UIClientCapabilities {
	const ids = new Set<string>([STANDARD_CATALOG_ID]);
	if (catalogs) {
		for (const key of Object.keys(catalogs)) {
			if (key === STANDARD_CATALOG_ALIAS) {
				ids.add(STANDARD_CATALOG_ID);
			} else {
				ids.add(key);
			}
		}
	}
	return { supportedCatalogIds: [...ids] };
}

/**
 * Server-side AgentCard extension params for hosts that *expose* an
 * A2UI-driving agent. Separated from `getClientCapabilities` because the
 * `acceptsInlineCatalogs` flag is a server property, not a client one.
 *
 * Use this when serialising an `AgentCapabilities.extensions[].params`
 * object for a hosted agent (B7 territory).
 */
export interface AgentCardExtensionParams {
	supportedCatalogIds: string[];
	acceptsInlineCatalogs: boolean;
}

export function getAgentCardExtensionParams(opts: {
	catalogs?: Record<string, Catalog>;
	acceptsInlineCatalogs: boolean;
}): AgentCardExtensionParams {
	const { supportedCatalogIds } = getClientCapabilities(opts.catalogs);
	return {
		supportedCatalogIds,
		acceptsInlineCatalogs: opts.acceptsInlineCatalogs
	};
}
