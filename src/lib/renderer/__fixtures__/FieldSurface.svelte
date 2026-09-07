<script lang="ts">
	import StaticSurface from '../StaticSurface.svelte';
	import Button from '../../components/Button.svelte';
	import TextField from '../../components/TextField.svelte';

	/**
	 * A static surface with one field and one button, both id-prefixed, so two
	 * copies can be mounted side by side without colliding in the global action
	 * registry — the setup the per-surface echo baseline used to get wrong.
	 */
	interface Props {
		surfaceId: string;
		prefix: string;
	}

	let { surfaceId, prefix }: Props = $props();
	let value = $state('');
</script>

<StaticSurface {surfaceId}>
	<TextField id={`${prefix}-name`} fieldName="name" label="Name" bind:value />
	<Button id={`${prefix}-btn`} label="Go" onclick={() => {}} />
</StaticSurface>
