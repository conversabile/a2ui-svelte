<script lang="ts">
	import StaticSurface from '../StaticSurface.svelte';
	import Button from '../../components/Button.svelte';
	import type { SurfaceFeedback } from '../surface-feedback';

	interface Props {
		surfaceId: string;
		buttonId: string;
		/** Marks which surface a tool result came from — see the lifecycle test. */
		tag: string;
		onclick?: () => void;
	}

	let { surfaceId, buttonId, tag, onclick }: Props = $props();

	const feedback: SurfaceFeedback = {
		globalSurfaces: () => ({ tag }),
		contextInstructions: () => tag
	};
</script>

<StaticSurface {surfaceId} {feedback}>
	<Button id={buttonId} label={buttonId} onclick={onclick ?? (() => {})} />
</StaticSurface>
