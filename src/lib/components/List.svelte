<script lang="ts">
	import { getSurfaceContext, getParentId, setParentId } from '../core/surface-registry';

	interface Props {
		children?: import('svelte').Snippet;
		id?: string;
		class?: string;
		direction?: 'vertical' | 'horizontal';
	}

	let { children, id, class: className = '', direction = 'vertical' }: Props = $props();

	const ctx = getSurfaceContext();
	if (ctx) {
		const parentId = getParentId();
		const componentId = id || ctx.generateId('list');
		ctx.register(componentId, parentId, {
			List: { children: { explicitList: [] }, direction }
		});
		setParentId(componentId);
	}
</script>

<div {id} class="a2ui-list {direction === 'horizontal' ? 'a2ui-list--horizontal' : ''} {className}">
	{@render children?.()}
</div>

<style>
	.a2ui-list {
		display: flex;
		flex-direction: column;
	}
	.a2ui-list--horizontal {
		flex-direction: row;
	}
</style>
