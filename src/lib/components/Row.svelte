<script lang="ts" module>
	export type Distribution =
		| 'start'
		| 'center'
		| 'end'
		| 'spaceBetween'
		| 'spaceAround'
		| 'spaceEvenly';
	export type Alignment = 'start' | 'center' | 'end' | 'stretch';

	/** A2UI `distribution` → CSS `justify-content`. */
	export const DISTRIBUTION_TO_JUSTIFY: Record<Distribution, string> = {
		start: 'flex-start',
		center: 'center',
		end: 'flex-end',
		spaceBetween: 'space-between',
		spaceAround: 'space-around',
		spaceEvenly: 'space-evenly'
	};

	/** A2UI `alignment` → CSS `align-items`. */
	export const ALIGNMENT_TO_ALIGN: Record<Alignment, string> = {
		start: 'flex-start',
		center: 'center',
		end: 'flex-end',
		stretch: 'stretch'
	};
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { defineA2uiComponent } from '../authoring/define-component.svelte';

	interface Props {
		children?: Snippet;
		id?: string;
		/** Main-axis (horizontal) distribution of children. */
		distribution?: Distribution;
		/** Cross-axis (vertical) alignment of children. */
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
		alignment = 'end',
		accessibility,
		weight,
		class: className = ''
	}: Props = $props();

	const handle = defineA2uiComponent({
		type: 'Row',
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
		`justify-content: ${DISTRIBUTION_TO_JUSTIFY[distribution] ?? 'flex-start'}; ` +
			`align-items: ${ALIGNMENT_TO_ALIGN[alignment] ?? 'flex-end'}; ${handle.weightStyle}`
	);

	export const dataAttr = handle.dataAttr;
	export const componentId = handle.componentId;
</script>

{#if !handle.isHidden}
	<div {...handle.dataAttr} {...handle.a11yAttr} class={`${className} row`} style={layoutStyle}>
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
	}

	@media (max-width: 720px) {
		.row {
			flex-direction: column;
			align-items: stretch;
		}
	}
</style>
