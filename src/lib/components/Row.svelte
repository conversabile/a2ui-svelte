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
		type: 'Row',
		id,
		a2ui: () => ({ children: { explicitList: [] } }),
		isContainer: true
	});

	export const dataAttr = handle.dataAttr;
	export const componentId = handle.componentId;
</script>

{#if !handle.isHidden}
	<div {...dataAttr} class={`${className} row`}>
		{@render children?.()}
	</div>
{:else}
	{@render children?.()}
{/if}

<style>
	.row {
		display: flex;
		flex-direction: row;
		gap: var(--a2ui-spacing);
		align-items: flex-end;
	}

	@media (max-width: 720px) {
		.row {
			flex-direction: column;
			align-items: stretch;
		}
	}
</style>
