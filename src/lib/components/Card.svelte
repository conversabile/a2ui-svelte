<script lang="ts">
	import { onDestroy } from 'svelte';
	import { getSurfaceContext, getParentId, setParentId } from '../core/surface-registry';

	interface Props {
		children?: import('svelte').Snippet;
		id?: string;
		class?: string;
	}

	let { children, id, class: className = '' }: Props = $props();

	// A2UI self-registration (only when inside a static Surface).
	// Per A2UI spec, Card has a single `child` slot — always wrap
	// multiple elements in a Column or Row before placing inside a Card.
	const ctx = getSurfaceContext();
	let _componentId: string | undefined;
	if (ctx) {
		const parentId = getParentId();
		_componentId = id || ctx.generateId('card');
		ctx.register(_componentId, parentId, { Card: {} });
		// Children rendered inside <Card> become children of this Card in the registry.
		setParentId(_componentId);
	}

	onDestroy(() => {
		if (ctx && _componentId) {
			ctx.unregister(_componentId);
		}
	});
</script>

<article {id} class={className}>
	{@render children?.()}
</article>

<style>
	article {
		margin-bottom: 1em;
		border: 1px solid rgb(from var(--pico-secondary) r g b / 25%);
	}
</style>
