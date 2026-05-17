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
	A <strong>dynamic surface</strong> is the opposite of a static one: instead
	of you laying out the UI, you hand the agent an empty canvas plus a catalog
	of components, and <em>it</em> decides what to render at runtime. The agent
	sends a component tree over the wire and A2UI renders it live.
</p>
<p>
	The canvas below starts empty. Try saying
	<em>"render a card with a yes button and a no button"</em>. The agent uses
	<code>surfaceUpdate</code> and <code>beginRendering</code> to build it.
</p>
<p>
	The <code>DEFAULT_CATALOG</code> registers all 16 A2UI v0.8 standard components:
	<code>Text</code>, <code>Image</code>, <code>Icon</code>, <code>Divider</code>,
	<code>Button</code>, <code>TextField</code>, <code>CheckBox</code>, <code>Slider</code>,
	<code>DateTimeInput</code>, <code>MultipleChoice</code>, <code>Row</code>,
	<code>Column</code>, <code>List</code>, <code>Card</code>, <code>Modal</code>,
	<code>Tabs</code>.
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
