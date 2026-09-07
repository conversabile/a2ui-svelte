<script lang="ts">
	import StaticSurface from '../StaticSurface.svelte';
	import Button from '../../components/Button.svelte';

	interface Props {
		surfaceId: string;
		buttonId: string;
		onclick?: () => void;
	}

	let { surfaceId, buttonId, onclick }: Props = $props();
</script>

<StaticSurface {surfaceId}>
	<Button id={buttonId} label={buttonId} onclick={onclick ?? (() => {})} />
</StaticSurface>
