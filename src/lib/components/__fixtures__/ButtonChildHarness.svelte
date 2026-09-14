<script lang="ts">
	import StaticSurface from '../../renderer/StaticSurface.svelte';
	import Button from '../Button.svelte';
	import Icon from '../Icon.svelte';

	/**
	 * Covers the two Button behaviours the `label`-only path never exercises:
	 * a real `children` snippet as the spec `child` (`icon-btn`, no `label`
	 * at all), and a `label` that starts absent and arrives later
	 * (`late-label-btn`) — the case a setup-time-only `labelId` would miss.
	 */
	interface HarnessApi {
		getJson: () => { components: Array<{ id: string; component: Record<string, any> }> };
		setLateLabel: (next: string | undefined) => void;
	}

	let { onReady }: { onReady: (api: HarnessApi) => void } = $props();

	let lateLabel = $state<string | undefined>(undefined);

	let surface = $state<{ getJson: () => any } | undefined>();

	$effect(() => {
		if (!surface) return;
		const s = surface;
		onReady({
			getJson: () => s.getJson(),
			setLateLabel: (next) => {
				lateLabel = next;
			}
		});
	});
</script>

<StaticSurface bind:this={surface} surfaceId="button-children">
	{#snippet children()}
		<Button id="icon-btn" onclick={() => {}}>
			<Icon id="icon-btn-icon" name="star" />
		</Button>
		<Button id="late-label-btn" label={lateLabel} onclick={() => {}} />
	{/snippet}
</StaticSurface>
