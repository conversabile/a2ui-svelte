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
		const componentId = id || ctx.generateId('row');
		// Register with empty children; toJSON() will fill them from the registry
		ctx.register(componentId, parentId, { Row: { children: { explicitList: [] } } });
		// Set this Row as the parent for nested children
		setParentId(componentId);
	}
</script>

<div class={`${className} row`}>
	{@render children?.()}
</div>

<style>
	.row {
		display: flex;
		flex-direction: row;
		gap: var(--pico-spacing);
		align-items: flex-end;
	}

	@media (max-width: 720px) {
		.row {
			flex-direction: column;
			align-items: stretch;
		}
	}
</style>
