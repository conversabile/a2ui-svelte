<script lang="ts">
	import { getContext } from 'svelte';
	import { a2uiState } from '../core/state.svelte';
	import { serializeSurface } from '../core/serializer';
	import { setCatalog, type Catalog } from '../authoring/catalog';
	import { DEFAULT_CATALOG } from '../components/default-catalog';
	import { STANDARD_CATALOG_ID, STANDARD_CATALOG_ALIAS } from '../core/catalog-selection';
	import {
		A2UI_EXTENSIONS_CONTEXT_KEY,
		resolveExtensionOptions,
		type ExtensionOptions
	} from '../core/extensions';
	import Component from './Component.svelte';
	import './styles.css';

	interface Props {
		surfaceId: string;
		/**
		 * Catalog mapping A2UI type names → Svelte components, used as the
		 * default / fallback. Defaults to DEFAULT_CATALOG.
		 */
		catalog?: Catalog;
		/**
		 * Optional registry of named catalogs. When the agent's `beginRendering`
		 * declares a `catalogId`, the matching entry here is used; otherwise the
		 * `'standard'` entry (if present) or the `catalog` prop is used.
		 *
		 * Keys SHOULD be catalog URIs (per A2UI v0.8 — the standard catalog ID
		 * is `https://a2ui.org/specification/v0_8/standard_catalog_definition.json`,
		 * exported as `STANDARD_CATALOG_ID`). The `'standard'` alias is also
		 * accepted for ergonomic registration of the built-in catalog.
		 */
		catalogs?: Record<string, Catalog>;
		/**
		 * Per-surface extension flags. Missing keys fall back to the host-wide
		 * default set under `A2UI_EXTENSIONS_CONTEXT_KEY` on Svelte context, or
		 * to `ALL_EXTRAS` if no context default is set. Pass `STRICT` (from
		 * `a2ui-svelte/core`) to opt this surface into v0.8 spec-strict
		 * behaviour — which, among other things, disables the agent's
		 * surface-watch polling for this surface.
		 */
		options?: Partial<ExtensionOptions>;
	}

	let { surfaceId, catalog = DEFAULT_CATALOG, catalogs, options }: Props = $props();

	// Resolve extension options once at mount. Props beat context; context
	// beats ALL_EXTRAS. Mirrors <StaticSurface> so a dynamic surface can opt
	// out of polling under STRICT mode.
	const ctxExtensions = getContext<Partial<ExtensionOptions> | undefined>(
		A2UI_EXTENSIONS_CONTEXT_KEY
	);
	const resolvedExtensions: ExtensionOptions = resolveExtensionOptions(options ?? ctxExtensions);

	// Dynamic mode: read from a2uiState
	let surface = $derived(a2uiState.getSurface(surfaceId));

	/**
	 * Resolve the active catalog from the surface's declared `catalogId`.
	 * `catalogId` arrives with `beginRendering` (after init), so this is
	 * reactive — the catalog context holds a thunk that reads it.
	 *
	 * Resolution order:
	 *   1. `surface.catalogId` (literal lookup in `catalogs`).
	 *   2. Per A2UI v0.8 §2.1.3, if the agent omitted `catalogId` the client
	 *      MUST default to the standard catalog — look up the canonical URI.
	 *   3. The ergonomic `'standard'` alias (back-compat for older registries).
	 *   4. The `catalog` prop (or `DEFAULT_CATALOG` fallback).
	 */
	const resolvedCatalog = $derived.by<Catalog>(() => {
		const id = surface?.catalogId;
		if (id && catalogs?.[id]) return catalogs[id];
		return (
			catalogs?.[STANDARD_CATALOG_ID] ??
			catalogs?.[STANDARD_CATALOG_ALIAS] ??
			catalog
		);
	});

	// Make the catalog available to descendant <Component> instances via context.
	setCatalog(() => resolvedCatalog);

	// Expose properties for GeminiLive
	export const id = surfaceId;
	export const type = 'dynamic';
	export const getJson = () => serializeSurface(surfaceId);
	/**
	 * The surface's `{ fieldId → value }` data model — the agent's rendered
	 * data values, as the `Agent` syncs them in `'sync'` mode (A2UI v0.9).
	 * Sourced from the surface's live `data` object (the same map `getJson()`
	 * embeds under `data`).
	 */
	export const getDataModel = (): Record<string, unknown> => ({
		...(a2uiState.getSurface(surfaceId)?.data ?? {})
	});
	/**
	 * Resolved per-surface extension flags. Hosts publish this surface handle
	 * to an `Agent`, which reads it to decide which non-spec behaviours
	 * apply — notably `surfaceWatch` polling, which keeps the agent's view of
	 * a path-bound field in sync with what the user typed.
	 */
	export const extensions: ExtensionOptions = resolvedExtensions;

	$effect(() => {
		console.log(`[DynamicSurface:${surfaceId}] surface updated:`, surface);
	});
</script>

<div class="a2ui-surface a2ui-dynamic-surface" data-surface-id={surfaceId}>
	{#if surface && surface.isRendering && surface.rootId}
		<Component id={surface.rootId} {surfaceId} />
	{:else}
		<!-- Waiting for content or beginRendering... -->
	{/if}
</div>

<style>
	/* Surface-specific styles are now in styles.css */
</style>
