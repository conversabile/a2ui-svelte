<script lang="ts">
	import type { Snippet } from 'svelte';
	import { defineA2uiComponent } from '../authoring/define-component.svelte';

	interface Props {
		children?: Snippet;
		id?: string;
		class?: string;
	}

	let { children, id, class: className = '' }: Props = $props();

	const handle = defineA2uiComponent({
		type: 'Column',
		id,
		a2ui: () => ({ children: { explicitList: [] } }),
		isContainer: true
	});

	export const dataAttr = handle.dataAttr;
	export const componentId = handle.componentId;
</script>

{#if !handle.isHidden}
	<div {...dataAttr} class={className} style="display: flex; flex-direction: column; gap: var(--a2ui-spacing);">
		{@render children?.()}
	</div>
{:else}
	{@render children?.()}
{/if}
