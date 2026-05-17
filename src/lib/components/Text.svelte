<script lang="ts">
	import { defineA2uiComponent } from '../authoring/define-component.svelte';

	type UsageHint = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'caption' | 'body';

	interface Props {
		id?: string;
		text: string;
		usageHint?: UsageHint;
		accessibility?: { label?: string; role?: string };
		weight?: number;
		class?: string;
	}

	let { id, text, usageHint = 'body', accessibility, weight, class: className = '' }: Props =
		$props();

	const handle = defineA2uiComponent<{ text: string; usageHint: UsageHint }>({
		type: 'Text',
		id,
		a2ui: () => ({
			text: { literalString: text },
			usageHint,
			...(accessibility ? { accessibility } : {}),
			...(weight != null ? { weight } : {})
		})
	});

	const rootAttrs = $derived({
		...handle.dataAttr,
		...handle.a11yAttr,
		...(handle.weightStyle ? { style: handle.weightStyle } : {})
	});

	export const dataAttr = handle.dataAttr;
	export const componentId = handle.componentId;
</script>

{#if !handle.isHidden}
	{#if handle.resolved.usageHint === 'h1'}
		<h1 {...rootAttrs} class={className}>{handle.resolved.text}</h1>
	{:else if handle.resolved.usageHint === 'h2'}
		<h2 {...rootAttrs} class={className}>{handle.resolved.text}</h2>
	{:else if handle.resolved.usageHint === 'h3'}
		<h3 {...rootAttrs} class={className}>{handle.resolved.text}</h3>
	{:else if handle.resolved.usageHint === 'h4'}
		<h4 {...rootAttrs} class={className}>{handle.resolved.text}</h4>
	{:else if handle.resolved.usageHint === 'h5'}
		<h5 {...rootAttrs} class={className}>{handle.resolved.text}</h5>
	{:else if handle.resolved.usageHint === 'caption'}
		<small {...rootAttrs} class={className}>{handle.resolved.text}</small>
	{:else}
		<p {...rootAttrs} class={className}>{handle.resolved.text}</p>
	{/if}
{/if}
