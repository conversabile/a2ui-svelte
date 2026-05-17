<script lang="ts">
	import { defineA2uiComponent } from '../authoring/define-component.svelte';

	type Axis = 'horizontal' | 'vertical';

	interface Props {
		id?: string;
		/** Orientation of the separator line. */
		axis?: Axis;
		accessibility?: { label?: string; role?: string };
		weight?: number;
		class?: string;
	}

	let { id, axis = 'horizontal', accessibility, weight, class: className = '' }: Props = $props();

	const handle = defineA2uiComponent<{ axis: Axis }>({
		type: 'Divider',
		id,
		a2ui: () => ({
			axis,
			...(accessibility ? { accessibility } : {}),
			...(weight != null ? { weight } : {})
		})
	});

	export const dataAttr = handle.dataAttr;
	export const componentId = handle.componentId;
</script>

{#if !handle.isHidden}
	<hr
		{...handle.dataAttr}
		{...handle.a11yAttr}
		class="a2ui-divider a2ui-divider--{handle.resolved.axis} {className}"
		style={handle.weightStyle}
		aria-orientation={handle.resolved.axis}
	/>
{/if}

<style>
	.a2ui-divider {
		border: none;
		background: var(--pico-muted-border-color, #ccc);
		margin: 0;
	}
	.a2ui-divider--horizontal {
		width: 100%;
		height: 1px;
	}
	.a2ui-divider--vertical {
		width: 1px;
		height: auto;
		align-self: stretch;
	}
</style>
