<script lang="ts">
	import { a2uiState } from '../core/state.svelte';
	import { serializeSurface } from '../core/serializer';
	import { setCatalog, type Catalog } from '../authoring/catalog';
	import { DEFAULT_CATALOG } from '../components/default-catalog';
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
	 */
	const resolvedCatalog = $derived.by<Catalog>(() => {
		const id = surface?.catalogId ?? 'standard';
		return catalogs?.[id] ?? catalogs?.['standard'] ?? catalog;
	});

	// Make the catalog available to descendant <Component> instances via context.
	setCatalog(() => resolvedCatalog);

	// Expose properties for GeminiLive
	export const id = surfaceId;
	export const type = 'dynamic';
	export const getJson = () => serializeSurface(surfaceId);

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
