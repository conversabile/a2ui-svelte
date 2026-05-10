<script lang="ts">
	import { defineA2uiComponent } from '../authoring/define-component.svelte';

	type UsageHint = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'caption' | 'body';

	interface Props {
		id?: string;
		text: string;
		usageHint?: UsageHint;
		class?: string;
	}

	let { id, text, usageHint = 'body', class: className = '' }: Props = $props();

	const handle = defineA2uiComponent<{ text: string; usageHint: UsageHint }>({
		type: 'Text',
		id,
		a2ui: () => ({ text: { literalString: text }, usageHint })
	});

	export const dataAttr = handle.dataAttr;
	export const componentId = handle.componentId;
</script>

{#if !handle.isHidden}
	{#if handle.resolved.usageHint === 'h1'}
		<h1 {...dataAttr} class={className}>{handle.resolved.text}</h1>
	{:else if handle.resolved.usageHint === 'h2'}
		<h2 {...dataAttr} class={className}>{handle.resolved.text}</h2>
	{:else if handle.resolved.usageHint === 'h3'}
		<h3 {...dataAttr} class={className}>{handle.resolved.text}</h3>
	{:else if handle.resolved.usageHint === 'h4'}
		<h4 {...dataAttr} class={className}>{handle.resolved.text}</h4>
	{:else if handle.resolved.usageHint === 'h5'}
		<h5 {...dataAttr} class={className}>{handle.resolved.text}</h5>
	{:else if handle.resolved.usageHint === 'caption'}
		<small {...dataAttr} class={className}>{handle.resolved.text}</small>
	{:else}
		<p {...dataAttr} class={className}>{handle.resolved.text}</p>
	{/if}
{/if}
