<script lang="ts">
	import { getSurfaceContext, getParentId, setParentId } from '../core/surface-registry';

	interface Props {
		children?: import('svelte').Snippet;
		id?: string;
		class?: string;
	}

	let { children, id, class: className = '' }: Props = $props();

	// A2UI self-registration (only when inside a static Surface)
	const ctx = getSurfaceContext();
	if (ctx) {
		const parentId = getParentId();
		const componentId = id || ctx.generateId('column');
		// Register with empty children; toJSON() will fill them from the registry
		ctx.register(componentId, parentId, { Column: { children: { explicitList: [] } } });
		// Set this Column as the parent for nested children
		setParentId(componentId);
	}
</script>

<div class={className} style="display: flex; flex-direction: column; gap: var(--pico-spacing);">
	{@render children?.()}
</div>
