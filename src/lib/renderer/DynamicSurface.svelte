<script lang="ts">
	import { a2uiState } from '../core/state.svelte';
	import { serializeSurface } from '../core/serializer';
	import { setCatalog, type Catalog } from '../authoring/catalog';
	import { DEFAULT_CATALOG } from '../components/default-catalog';
	import Component from './Component.svelte';
	import './styles.css';

	interface Props {
		surfaceId: string;
		/** Catalog mapping A2UI type names → Svelte components. Defaults to DEFAULT_CATALOG. */
		catalog?: Catalog;
	}

	let { surfaceId, catalog = DEFAULT_CATALOG }: Props = $props();

	// Make the catalog available to descendant <Component> instances via context.
	setCatalog(catalog);

	// Dynamic mode: read from a2uiState
	let surface = $derived(a2uiState.getSurface(surfaceId));

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
