<script lang="ts">
	import type { Snippet } from 'svelte';
	import { defineA2uiComponent } from '../authoring/define-component.svelte';
	import {
		DISTRIBUTION_TO_JUSTIFY,
		ALIGNMENT_TO_ALIGN,
		type Distribution,
		type Alignment
	} from './Row.svelte';

	interface Props {
		children?: Snippet;
		id?: string;
		/** Main-axis (vertical) distribution of children. */
		distribution?: Distribution;
		/** Cross-axis (horizontal) alignment of children. */
		alignment?: Alignment;
		accessibility?: { label?: string; role?: string };
		weight?: number;
		class?: string;
	}

	let {
		children,
		id,
		// Defaults preserve the previous hardcoded visuals (no regression).
		distribution = 'start',
		alignment = 'stretch',
		accessibility,
		weight,
		class: className = ''
	}: Props = $props();

	const handle = defineA2uiComponent({
		type: 'Column',
		id,
		a2ui: () => ({
			children: { explicitList: [] },
			distribution,
			alignment,
			...(accessibility ? { accessibility } : {}),
			...(weight != null ? { weight } : {})
		}),
		isContainer: true
	});

	const layoutStyle = $derived(
		'display: flex; flex-direction: column; gap: var(--a2ui-spacing); ' +
			`justify-content: ${DISTRIBUTION_TO_JUSTIFY[distribution] ?? 'flex-start'}; ` +
			`align-items: ${ALIGNMENT_TO_ALIGN[alignment] ?? 'stretch'}; ${handle.weightStyle}`
	);

	export const dataAttr = handle.dataAttr;
	export const componentId = handle.componentId;
</script>

{#if !handle.isHidden}
	<div {...handle.dataAttr} {...handle.a11yAttr} class={className} style={layoutStyle}>
		{@render children?.()}
	</div>
{:else}
	{@render children?.()}
{/if}
