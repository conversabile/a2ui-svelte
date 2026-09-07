<script lang="ts">
	import DynamicSurface from '../../src/lib/renderer/DynamicSurface.svelte';

	/** Minimal dynamic-surface host for the dynamic eval scenarios. */
	let { surfaceId = 'ai-canvas' }: { surfaceId?: string } = $props();

	// The eval reads the surface from the library's index — `surface(surfaceId)`.
</script>

<DynamicSurface {surfaceId} />
