<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { a2uiState } from '../core/state.svelte';
	import {
		registerSurface,
		unregisterSurface,
		type AgentSurface
	} from '../core/registries/surface-index';
	import { serializeSurface } from '../core/serializer';
	import { setCatalog, type Catalog } from '../authoring/catalog';
	import { DEFAULT_CATALOG } from '../components/default-catalog';
	import { STANDARD_CATALOG_ID, STANDARD_CATALOG_ALIAS } from '../core/catalog-selection';
	import Component from './Component.svelte';
	import './styles.css';
	import '../core/dev-global';

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
	}

	let { surfaceId, catalog = DEFAULT_CATALOG, catalogs }: Props = $props();

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

	// Publish the renderable type names so `processMessage`'s validation judges
	// the agent's tree against this page's catalog, not just the standard 16.
	$effect(() => {
		a2uiState.setCatalogTypes(surfaceId, new Set(Object.keys(resolvedCatalog)));
	});

	// The handle the agent reads this surface through. Joins the global surface
	// index on mount (never at module scope — that would leave an entry behind
	// after a server render) so the agent's default surface source finds it.
	const handle: AgentSurface = {
		id: surfaceId,
		type: 'dynamic',
		getJson: () => serializeSurface(surfaceId),
		/**
		 * The surface's `{ fieldId → value }` data model — the agent's rendered
		 * data values, as the `Agent` syncs them in `'sync'` mode (A2UI v0.9).
		 * Sourced from the surface's live `data` object (the same map
		 * `getJson()` embeds under `data`).
		 */
		getDataModel: (): Record<string, unknown> => ({
			...(a2uiState.getSurface(surfaceId)?.data ?? {})
		})
	};
	onMount(() => registerSurface(handle));
	onDestroy(() => unregisterSurface(handle));

	// Expose properties for GeminiLive
	export const id = surfaceId;
	export const type = 'dynamic';
	export const getJson = handle.getJson;
	export const getDataModel = handle.getDataModel!;

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
