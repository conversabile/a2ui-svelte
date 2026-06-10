<script lang="ts">
	import DynamicSurface from '../../src/lib/renderer/DynamicSurface.svelte';

	/** Minimal dynamic-surface host for the dynamic eval scenarios. */
	let { surfaceId = 'ai-canvas' }: { surfaceId?: string } = $props();

	let ref: DynamicSurface | undefined = $state();
	export const surface = () => ref;
</script>

<DynamicSurface bind:this={ref} {surfaceId} />
