<script lang="ts">
	import type { Snippet } from 'svelte';
	import { defineA2uiComponent } from '../authoring/define-component.svelte';
	import { ALIGNMENT_TO_ALIGN, type Alignment } from './Row.svelte';

	interface Props {
		children?: Snippet;
		id?: string;
		class?: string;
		direction?: 'vertical' | 'horizontal';
		/** Cross-axis alignment of list items. */
		alignment?: Alignment;
		accessibility?: { label?: string; role?: string };
		weight?: number;
	}

	let {
		children,
		id,
		class: className = '',
		direction = 'vertical',
		alignment = 'stretch',
		accessibility,
		weight
	}: Props = $props();

	const handle = defineA2uiComponent({
		type: 'List',
		id,
		a2ui: () => ({
			children: { explicitList: [] },
			direction,
			alignment,
			...(accessibility ? { accessibility } : {}),
			...(weight != null ? { weight } : {})
		}),
		isContainer: true
	});

	const layoutStyle = $derived(
		`align-items: ${ALIGNMENT_TO_ALIGN[alignment] ?? 'stretch'}; ${handle.weightStyle}`
	);

	export const dataAttr = handle.dataAttr;
	export const componentId = handle.componentId;
</script>

{#if !handle.isHidden}
	<div
		{...handle.dataAttr}
		{...handle.a11yAttr}
		class="a2ui-list {direction === 'horizontal' ? 'a2ui-list--horizontal' : ''} {className}"
		style={layoutStyle}
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
