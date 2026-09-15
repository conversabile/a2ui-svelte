<script lang="ts">
	import StaticSurface from '../StaticSurface.svelte';
	import Button from '../../components/Button.svelte';
	import TextField from '../../components/TextField.svelte';
	import Text from '../../components/Text.svelte';

	/**
	 * A static surface with one field, one button, and a Text that mirrors the
	 * field's value, all id-prefixed so two copies can be mounted side by side
	 * without colliding in the global action registry — the setup the
	 * per-surface echo baseline used to get wrong.
	 *
	 * The Text holds its content as a literal inside the component tree (every
	 * Text does), so editing the field moves both the data model AND one
	 * component definition — the case that used to force a full re-sync.
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
	<Text id={`${prefix}-echo`} text={`Hello ${value}`} />
	<Button id={`${prefix}-btn`} label="Go" onclick={() => {}} />
</StaticSurface>
