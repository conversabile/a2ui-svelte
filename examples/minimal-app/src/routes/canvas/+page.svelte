<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { DynamicSurface } from 'a2ui-svelte/renderer';
	import { DEFAULT_CATALOG } from 'a2ui-svelte/authoring';
	import { session } from '$lib/session.svelte';

	let surfaceRef: DynamicSurface | undefined = $state();

	onMount(() => {
		if (surfaceRef) session.surfaces = [surfaceRef];
		session.contextInstructions =
			'The canvas is empty. Render whatever the user asks for using surfaceUpdate + beginRendering.';
	});

	onDestroy(() => {
		session.surfaces = [];
		session.contextInstructions = '';
	});
</script>

<h2>Dynamic surface demo</h2>
<p>
	Try saying <em>"render a card with a yes button and a no button"</em>. The
	agent uses <code>surfaceUpdate</code> and <code>beginRendering</code>.
</p>

<div class="canvas">
	<DynamicSurface bind:this={surfaceRef} surfaceId="canvas" catalog={DEFAULT_CATALOG} />
</div>

<style>
	.canvas {
		min-height: 240px;
		padding: 1rem;
		border: 1px dashed var(--a2ui-input-border);
		border-radius: var(--a2ui-card-radius);
		background: var(--a2ui-card-bg);
	}
</style>
