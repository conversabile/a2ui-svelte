<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onDestroy } from 'svelte';
	import { getSurfaceContext } from '../core/surface-registry';
	import { defineA2uiComponent } from '../authoring/define-component.svelte';

	interface Props {
		children?: Snippet;
		id?: string;
		primary?: boolean;
		label?: string;
		action?: { name: string };
		onclick?: () => void | Promise<void>;
		type?: 'button' | 'submit' | 'reset';
		accessibility?: { label?: string; role?: string };
		weight?: number;
		class?: string;
	}

	let {
		children,
		id,
		primary = false,
		label,
		action,
		onclick,
		type = 'button',
		accessibility,
		weight,
		class: className = ''
	}: Props = $props();

	// Pre-resolve the component id so the synthetic label child can reference it.
	const ctx = getSurfaceContext();
	const _componentId: string | undefined = ctx
		? (id ?? action?.name ?? ctx.generateId('button'))
		: undefined;
	const labelId = label && _componentId ? `${_componentId}-label` : undefined;

	const handle = defineA2uiComponent<{
		primary: boolean;
		action?: { name: string };
		child?: string;
	}>({
		type: 'Button',
		id: _componentId,
		a2ui: () => ({
			primary,
			action,
			...(labelId ? { child: labelId } : {}),
			...(accessibility ? { accessibility } : {}),
			...(weight != null ? { weight } : {})
		}),
		action: action ? { type: 'click', handler: () => onclick?.() } : undefined
	});

	// Per A2UI spec, Button has a single `child` (its label Text node).
	// The label is registered as a free-standing Text component referenced
	// by `child` — not as a positional child of any container.
	if (ctx && labelId) {
		$effect(() => {
			ctx.register(labelId, null, { Text: { text: { literalString: label ?? '' } } });
		});
	}

	onDestroy(() => {
		if (ctx && labelId) ctx.unregister(labelId);
	});

	export const dataAttr = handle.dataAttr;
	export const fire = handle.fire;
	export const componentId = _componentId;
</script>

{#if !handle.isHidden}
	<button
		{...dataAttr}
		{...handle.a11yAttr}
		{id}
		{type}
		onclick={() => handle.fire()}
		class="{className} {primary ? '' : 'secondary'}"
		style={handle.weightStyle}
	>
		{#if children}{@render children()}{:else if label}{label}{/if}
	</button>
{/if}

<style>
	/* Make the catalog Button honour the A2UI button tokens. The token defaults
	   (renderer/styles.css) resolve to Pico's filled-button colours, so the look
	   is unchanged until an app overrides a token. Scoped class/element selectors
	   out-specify Pico's bare `button` rules, so no !important is needed. Hover
	   darkens the base colour so custom themes keep their press feedback. */
	button {
		background-color: var(--a2ui-button-primary-bg);
		border-color: var(--a2ui-button-primary-bg);
		color: var(--a2ui-button-primary-fg);
	}
	button:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--a2ui-button-primary-bg) 88%, #000);
		border-color: color-mix(in srgb, var(--a2ui-button-primary-bg) 88%, #000);
	}
	button.secondary {
		background-color: var(--a2ui-button-secondary-bg);
		border-color: var(--a2ui-button-secondary-bg);
		color: var(--a2ui-button-secondary-fg);
	}
	button.secondary:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--a2ui-button-secondary-bg) 88%, #000);
		border-color: color-mix(in srgb, var(--a2ui-button-secondary-bg) 88%, #000);
	}
</style>
