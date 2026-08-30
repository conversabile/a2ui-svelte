<script lang="ts">
	import StaticSurface from '../../renderer/StaticSurface.svelte';
	import TextField from '../TextField.svelte';

	/**
	 * Two TextFields differing only in whether they carry an explicit
	 * `fieldName`. Both must be equally writable by the agent: the id-only
	 * field's `update` action is keyed by its component id.
	 *
	 * `onReady` hands the test the surface's data model plus live readers for
	 * the two bound values, so a fill can be traced all the way from the tool
	 * call to the consumer's `$state`.
	 */
	interface HarnessApi {
		getDataModel: () => Record<string, unknown>;
		idOnly: () => string;
		withFieldName: () => string;
	}

	let { onReady }: { onReady: (api: HarnessApi) => void } = $props();

	let a = $state('');
	let b = $state('');

	let surface = $state<{ getDataModel: () => Record<string, unknown> } | undefined>();

	$effect(() => {
		if (!surface) return;
		const s = surface;
		onReady({
			getDataModel: () => s.getDataModel(),
			idOnly: () => a,
			withFieldName: () => b
		});
	});
</script>

<StaticSurface bind:this={surface} surfaceId="textfield-writability">
	{#snippet children()}
		<TextField id="only-id" label="A" bind:value={a} />
		<TextField id="with-field" fieldName="shared-key" label="B" bind:value={b} />
	{/snippet}
</StaticSurface>
