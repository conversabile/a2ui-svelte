<script lang="ts">
	import type { Snippet } from 'svelte';
	import { defineA2uiComponent } from '../authoring/define-component.svelte';

	interface Props {
		children?: Snippet;
		id?: string;
		class?: string;
	}

	let { children, id, class: className = '' }: Props = $props();

	// Per A2UI spec, Card has a single `child` slot — wrap multiple
	// elements in a Column or Row before placing inside a Card.
	const handle = defineA2uiComponent({
		type: 'Card',
		id,
		a2ui: () => ({}),
		isContainer: true
	});

	export const dataAttr = handle.dataAttr;
	export const componentId = handle.componentId;
</script>

{#if !handle.isHidden}
	<article {...dataAttr} class={className}>
		{@render children?.()}
	</article>
{:else}
	{@render children?.()}
{/if}

<style>
	article {
		margin-bottom: 1em;
		border: var(--a2ui-card-border);
		border-radius: var(--a2ui-card-radius);
		background: var(--a2ui-card-bg);
	}
</style>
