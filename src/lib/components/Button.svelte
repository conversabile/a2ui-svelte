<script lang="ts">
	import { onDestroy } from 'svelte';
	import { getSurfaceContext, getParentId } from '../core/surface-registry';
	import { actionRegistry } from '../core/registries/action-registry';

	interface Props {
		children?: import('svelte').Snippet;
		id?: string;
		primary?: boolean;
		label?: string;
		action?: { name: string };
		onclick?: () => void | Promise<void>;
		type?: 'button' | 'submit' | 'reset';
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
		class: className = ''
	}: Props = $props();

	// A2UI self-registration (only when inside a static Surface)
	const ctx = getSurfaceContext();
	let _componentId: string | undefined;
	let _labelId: string | undefined;
	if (ctx) {
		const parentId = getParentId();
		// Prefer action.name for semantic IDs, fallback to auto-generated
		_componentId = id || action?.name || ctx.generateId('button');
		const buttonDef: Record<string, any> = { primary, action };

		// If a label is provided, register a synthetic Text child for it
		if (label) {
			_labelId = `${_componentId}-label`;
			buttonDef.child = _labelId;
			ctx.register(_labelId, null, {
				Text: { text: { literalString: label } }
			});
		}

		ctx.register(_componentId, parentId, { Button: buttonDef });

		// Register click callback in ActionRegistry for the generic click_button tool
		if (action) {
			actionRegistry.register(_componentId, 'click', handleClick, ctx.surfaceId);
		}
	}

	onDestroy(() => {
		if (ctx && _componentId) {
			actionRegistry.unregister(_componentId);
			ctx.unregister(_componentId);
			if (_labelId) ctx.unregister(_labelId);
		}
	});

	function handleClick() {
		if (action) {
			console.log(`Action triggered: ${action.name}`);
		}
		return onclick?.();
	}
</script>

<button {id} {type} onclick={handleClick} class="{className} {primary ? '' : 'secondary'}" data-a2ui-id={_componentId}>
	{#if children}
		{@render children()}
	{:else if label}
		{label}
	{/if}
</button>
