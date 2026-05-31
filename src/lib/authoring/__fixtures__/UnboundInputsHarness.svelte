<script lang="ts">
	import StaticSurface from '../../renderer/StaticSurface.svelte';
	import TextField from '../../components/TextField.svelte';

	/**
	 * Renders value-bearing inputs that have NO `fieldName` (the case Point 4 of
	 * the surface-data-model-sync plan generalises). `onReady` is called with the
	 * surface's serialised JSON and its `{ fieldId → value }` data model so the
	 * test can assert the value is path-bound + registered as a data source
	 * rather than inlined as a literal in the tree.
	 */
	let { onReady }: { onReady: (json: any, dataModel: Record<string, unknown>) => void } =
		$props();

	let surface = $state<
		{ getJson: () => any; getDataModel: () => Record<string, unknown> } | undefined
	>();

	$effect(() => {
		if (surface) onReady(surface.getJson(), surface.getDataModel());
	});
</script>

<StaticSurface bind:this={surface} surfaceId="unbound-inputs">
	{#snippet children()}
		<!-- Explicit id, no fieldName -->
		<TextField id="bio" label="Bio" value="hello" />
		<!-- No id, no fieldName → auto-generated id -->
		<TextField label="Notes" value="scratch" />
	{/snippet}
</StaticSurface>
