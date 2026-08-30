<script lang="ts">
	import StaticSurface from '../../renderer/StaticSurface.svelte';
	import Button from '../Button.svelte';

	/**
	 * Two Buttons covering the action matrix: neither declares an `action`
	 * prop, because there isn't one any more — `action.name` is synthesised
	 * from the id. `plain-btn` is the everyday case (id + onclick);
	 * `inert-btn` has no handler at all and must still be agent-clickable
	 * (Rule 4: on screen ⇒ in the tree ⇒ targetable).
	 *
	 * `onReady` hands the test the surface JSON plus the click counters.
	 */
	interface HarnessApi {
		getJson: () => { components: Array<{ id: string; component: Record<string, any> }> };
		clicks: () => Record<string, number>;
	}

	let { onReady }: { onReady: (api: HarnessApi) => void } = $props();

	let plain = $state(0);

	let surface = $state<{ getJson: () => any } | undefined>();

	$effect(() => {
		if (!surface) return;
		const s = surface;
		onReady({
			getJson: () => s.getJson(),
			clicks: () => ({ 'plain-btn': plain })
		});
	});
</script>

<StaticSurface bind:this={surface} surfaceId="button-actions">
	{#snippet children()}
		<Button
			id="plain-btn"
			label="Save"
			onclick={() => {
				plain++;
			}}
		/>
		<Button id="inert-btn" label="Nothing" />
	{/snippet}
</StaticSurface>
