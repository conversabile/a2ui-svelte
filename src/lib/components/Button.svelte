<script lang="ts">
	import type { Snippet } from 'svelte';
	import { getSurfaceContext } from '../core/surface-registry';
	import { defineA2uiComponent } from '../authoring/define-component.svelte';

	interface Props {
		children?: Snippet;
		id?: string;
		primary?: boolean;
		label?: string;
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
		onclick,
		type = 'button',
		accessibility,
		weight,
		class: className = ''
	}: Props = $props();

	// Pre-resolve the component id so the synthetic label child can reference it.
	const ctx = getSurfaceContext();
	const _componentId: string | undefined = ctx ? (id ?? ctx.generateId('button')) : undefined;
	const labelId = $derived(label && _componentId ? `${_componentId}-label` : undefined);

	const handle = defineA2uiComponent<{
		primary: boolean;
		action?: { name: string };
		child?: string;
	}>({
		type: 'Button',
		id: _componentId,
		// `action.name` IS the component id — the spec property is synthesised,
		// never authored, so the name the agent reads and the id it targets
		// cannot drift (CLAUDE.md Rule 3).
		a2ui: (componentId) => ({
			primary,
			...(componentId ? { action: { name: componentId } } : {}),
			// Synthetic label Text node; a real `children` snippet overrides
			// it in the serializer (`Button` case in surface-registry.ts).
			...(labelId ? { child: labelId } : {}),
			...(accessibility ? { accessibility } : {}),
			...(weight != null ? { weight } : {})
		}),
		// Registered unconditionally: a Button is clickable because it is a
		// Button, not because the author remembered to declare an action.
		action: { type: 'click', handler: () => onclick?.() },
		// Attaches a `children` snippet (e.g. an Icon) to this Button's id
		// instead of the parent's, so it can become the spec `child`.
		isContainer: true
	});

	// The label Text node is registered parentless (`null`) so it never
	// collides with a `children` snippet under the same Button id. The
	// effect re-runs when `labelId` changes, so clearing or setting `label`
	// unregisters or registers to match.
	$effect(() => {
		if (!ctx || !labelId) return;
		const currentLabelId = labelId;
		ctx.register(currentLabelId, null, { Text: { text: { literalString: label ?? '' } } });
		return () => ctx.unregister(currentLabelId);
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
