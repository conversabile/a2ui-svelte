<script lang="ts">
	import { onDestroy } from 'svelte';
	import { getSurfaceContext, getParentId } from '../core/surface-registry';

	interface Props {
		id?: string;
		text: string;
		usageHint?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'caption' | 'body';
		class?: string;
	}

	let { id, text, usageHint = 'body', class: className = '' }: Props = $props();

	// A2UI self-registration (only when inside a static Surface).
	// Initial registration is synchronous so Text appears in the parent's
	// `childrenByParent` mapping immediately. The $effect below keeps the
	// registered text in sync if the prop changes — GeminiLive polls
	// registry.toJSON() every ~3s and emits a single SURFACE_UPDATED per
	// diff, so reactive updates do not cause duplicate notifications.
	const ctx = getSurfaceContext();
	const parentId = ctx ? getParentId() : null;
	const componentId = ctx ? id || ctx.generateId('text') : undefined;

	if (ctx && componentId) {
		ctx.register(componentId, parentId, {
			Text: { text: { literalString: text }, usageHint }
		});
	}

	$effect(() => {
		if (ctx && componentId) {
			ctx.register(componentId, parentId, {
				Text: { text: { literalString: text }, usageHint }
			});
		}
	});

	onDestroy(() => {
		if (ctx && componentId) ctx.unregister(componentId);
	});
</script>

{#if usageHint === 'h1'}
	<h1 {id} class={className}>{text}</h1>
{:else if usageHint === 'h2'}
	<h2 {id} class={className}>{text}</h2>
{:else if usageHint === 'h3'}
	<h3 {id} class={className}>{text}</h3>
{:else if usageHint === 'h4'}
	<h4 {id} class={className}>{text}</h4>
{:else if usageHint === 'h5'}
	<h5 {id} class={className}>{text}</h5>
{:else if usageHint === 'caption'}
	<small {id} class={className}>{text}</small>
{:else}
	<p {id} class={className}>{text}</p>
{/if}
