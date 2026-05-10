<script lang="ts">
	import type { Snippet } from 'svelte';
	import { defineA2uiComponent } from '../authoring/define-component.svelte';

	interface Props {
		children?: Snippet;
		id?: string;
		class?: string;
		direction?: 'vertical' | 'horizontal';
	}

	let { children, id, class: className = '', direction = 'vertical' }: Props = $props();

	const handle = defineA2uiComponent({
		type: 'List',
		id,
		a2ui: () => ({ children: { explicitList: [] }, direction }),
		isContainer: true
	});

	export const dataAttr = handle.dataAttr;
	export const componentId = handle.componentId;
</script>

{#if !handle.isHidden}
	<div
		{...dataAttr}
		class="a2ui-list {direction === 'horizontal' ? 'a2ui-list--horizontal' : ''} {className}"
	>
		{@render children?.()}
	</div>
{:else}
	{@render children?.()}
{/if}

<style>
	.a2ui-list {
		display: flex;
		flex-direction: column;
	}
	.a2ui-list--horizontal {
		flex-direction: row;
	}
</style>
