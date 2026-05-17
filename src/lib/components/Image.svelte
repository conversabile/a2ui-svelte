<script lang="ts">
	import { defineA2uiComponent } from '../authoring/define-component.svelte';

	type Fit = 'cover' | 'contain' | 'fill' | 'none' | 'scaleDown';

	interface Props {
		id?: string;
		/** Image source URL. */
		url: string;
		/** How the image fills its box. Maps to CSS `object-fit`. */
		fit?: Fit;
		/** Free-form rendering hint (e.g. "hero", "thumbnail", "avatar"). */
		usageHint?: string;
		accessibility?: { label?: string; role?: string };
		weight?: number;
		class?: string;
	}

	let {
		id,
		url,
		fit = 'contain',
		usageHint,
		accessibility,
		weight,
		class: className = ''
	}: Props = $props();

	const FIT_TO_CSS: Record<Fit, string> = {
		cover: 'cover',
		contain: 'contain',
		fill: 'fill',
		none: 'none',
		scaleDown: 'scale-down'
	};

	const handle = defineA2uiComponent<{ url: string; fit: Fit; usageHint?: string }>({
		type: 'Image',
		id,
		a2ui: () => ({
			url: { literalString: url },
			fit,
			...(usageHint ? { usageHint } : {}),
			...(accessibility ? { accessibility } : {}),
			...(weight != null ? { weight } : {})
		})
	});

	export const dataAttr = handle.dataAttr;
	export const componentId = handle.componentId;
</script>

{#if !handle.isHidden}
	<img
		{...handle.dataAttr}
		{...handle.a11yAttr}
		class="a2ui-image {className}"
		src={handle.resolved.url}
		alt={accessibility?.label ?? ''}
		data-usage-hint={handle.resolved.usageHint}
		style="object-fit: {FIT_TO_CSS[handle.resolved.fit] ?? 'contain'}; {handle.weightStyle}"
	/>
{/if}

<style>
	.a2ui-image {
		display: block;
		max-width: 100%;
	}
</style>
