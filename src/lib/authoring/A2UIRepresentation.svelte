<script lang="ts" module>
	/**
	 * Context key components observe to detect they are inside an
	 * `<A2UIRepresentation>` boundary. Public so `defineA2uiComponent` can
	 * read it; consumers should not read it directly.
	 */
	export const A2UI_REPRESENTATION_KEY = Symbol('a2ui:representation');
</script>

<script lang="ts">
	import { setContext, type Snippet } from 'svelte';

	/**
	 * Boundary marker for composite components.
	 *
	 * Anything rendered inside <A2UIRepresentation> registers with the
	 * surface registry as normal but produces no visible DOM. Use it
	 * inside a custom Svelte component to declare the A2UI tree the
	 * agent should see, while rendering bespoke HTML for the user
	 * outside the boundary.
	 *
	 * Built-in catalog components observe the boundary via Svelte
	 * context (see `defineA2uiComponent`'s `isHidden` handle).
	 */
	interface Props {
		children: Snippet;
	}
	let { children }: Props = $props();

	setContext(A2UI_REPRESENTATION_KEY, true);
</script>

{@render children()}
