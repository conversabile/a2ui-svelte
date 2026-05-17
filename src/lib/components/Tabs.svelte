<script lang="ts">
	import type { Snippet } from 'svelte';
	import { defineA2uiComponent } from '../authoring/define-component.svelte';

	interface TabSpec {
		key: string;
		title: string;
	}

	/**
	 * An A2UI `tabItems` entry as it arrives from a dynamic surface's JSON:
	 * a `title` BoundValue (or plain string) plus the `child` component id.
	 */
	interface TabItem {
		title: string | { literalString?: string; literalNumber?: number };
		child?: string;
	}

	interface Props {
		id?: string;
		/** Static-authoring API: explicit tab list, paired with the `content` snippet. */
		tabs?: TabSpec[];
		content?: Snippet<[string]>;
		/**
		 * Dynamic-surface API: the A2UI `tabItems` property and the renderer's
		 * `renderChild` snippet. The renderer passes both when a Tabs is built
		 * from JSON; `tabs`/`content` are then absent.
		 */
		tabItems?: TabItem[];
		renderChild?: Snippet<[string]>;
		accessibility?: { label?: string; role?: string };
		weight?: number;
		class?: string;
	}

	let {
		id,
		tabs,
		content,
		tabItems,
		renderChild,
		accessibility,
		weight,
		class: className = ''
	}: Props = $props();

	/** Unwrap a `tabItems` title, which may be a plain string or a BoundValue. */
	function tabItemTitle(title: TabItem['title']): string {
		if (typeof title === 'string') return title;
		if (title && typeof title === 'object') {
			if (typeof title.literalString === 'string') return title.literalString;
			if (typeof title.literalNumber === 'number') return String(title.literalNumber);
		}
		return '';
	}

	// Normalise the two input shapes into a single `{ key, title }[]`. On a
	// dynamic surface the tab key is the child component id — exactly what
	// `renderChild` expects — so switching tabs and rendering both work off it.
	const resolvedTabs = $derived.by<TabSpec[]>(() => {
		if (tabs && tabs.length) return tabs;
		if (tabItems && tabItems.length) {
			return tabItems.map((t, i) => ({
				key: typeof t.child === 'string' ? t.child : String(i),
				title: tabItemTitle(t.title)
			}));
		}
		return [];
	});

	let activeIndex = $state(0);

	// Resolve an agent-supplied selector (tab key, title, or numeric index)
	// to a tab index. Returns -1 when nothing matches.
	function resolveTabIndex(selector: string): number {
		const trimmed = selector.trim();
		const byKeyOrTitle = resolvedTabs.findIndex(
			(t) => t.key === trimmed || t.title.toLowerCase() === trimmed.toLowerCase()
		);
		if (byKeyOrTitle >= 0) return byKeyOrTitle;
		const asNum = Number(trimmed);
		if (Number.isInteger(asNum) && asNum >= 0 && asNum < resolvedTabs.length) return asNum;
		return -1;
	}

	// `tabItems` is registered with titles only; SurfaceRegistry.toJSON()
	// pairs them with the children registered under this Tabs (order = tab order).
	const handle = defineA2uiComponent({
		type: 'Tabs',
		id,
		a2ui: () => ({
			tabItems: resolvedTabs.map((t) => ({ title: { literalString: t.title } })),
			...(accessibility ? { accessibility } : {}),
			...(weight != null ? { weight } : {})
		}),
		isContainer: true,
		// Lets the agent switch the active panel via `update_text_field`,
		// passing a tab title, key, or index as the value.
		action: {
			type: 'update',
			handler: (next: string): unknown => {
				const idx = resolveTabIndex(String(next));
				if (idx < 0) {
					return {
						field: id ?? 'tabs',
						message: `No tab matching "${next}". Available tabs: ${resolvedTabs.map((t) => t.title).join(', ')}.`
					};
				}
				activeIndex = idx;
				return {
					field: id ?? 'tabs',
					message: `Switched to the "${resolvedTabs[idx].title}" tab.`
				};
			}
		}
	});

	$effect(() => {
		if (activeIndex >= resolvedTabs.length) activeIndex = 0;
	});

	function attachReveal(node: HTMLElement) {
		const handler = (e: Event) => {
			const detail = (e as CustomEvent<{ index: number }>).detail;
			if (!detail) return;
			if (detail.index >= 0 && detail.index < resolvedTabs.length) {
				activeIndex = detail.index;
			}
		};
		node.addEventListener('a2ui:reveal', handler);
		return {
			destroy() {
				node.removeEventListener('a2ui:reveal', handler);
			}
		};
	}

	export const dataAttr = handle.dataAttr;
	export const componentId = handle.componentId;
</script>

<!-- Render a tab's body via whichever slot the host provided: the static
     `content` snippet (keyed by tab key) or the dynamic `renderChild`
     snippet (keyed by the child component id). -->
{#snippet tabBody(key: string)}
	{#if content}
		{@render content(key)}
	{:else if renderChild}
		{@render renderChild(key)}
	{/if}
{/snippet}

{#if handle.isHidden}
	<!-- Inside <A2UIRepresentation>: still render content snippets so descendants register -->
	{#each resolvedTabs as tab (tab.key)}
		{@render tabBody(tab.key)}
	{/each}
{:else}
	<div
		class="tabs {className}"
		{...dataAttr}
		{...handle.a11yAttr}
		style={handle.weightStyle}
		data-a2ui-tabs-root
		use:attachReveal
	>
		<div class="tab-headers" role="tablist">
			{#each resolvedTabs as tab, i (tab.key)}
				<button
					type="button"
					role="tab"
					class="tab-header"
					class:active={activeIndex === i}
					aria-selected={activeIndex === i}
					onclick={() => (activeIndex = i)}
				>
					{tab.title}
				</button>
			{/each}
		</div>
		<div class="tab-panels">
			{#each resolvedTabs as tab, i (tab.key)}
				<div
					class="tab-panel"
					class:active={activeIndex === i}
					role="tabpanel"
					data-a2ui-tab-panel-index={i}
					aria-hidden={activeIndex !== i}
				>
					{@render tabBody(tab.key)}
				</div>
			{/each}
		</div>
	</div>
{/if}

<style>
	.tabs {
		display: flex;
		flex-direction: column;
	}

	.tab-headers {
		display: flex;
		flex-wrap: wrap;
		gap: 0.15rem;
		padding: 0 0.25rem;
		border-bottom: 1px solid var(--pico-muted-border-color);
	}

	.tab-header {
		appearance: none;
		background: transparent;
		border: 1px solid transparent;
		border-bottom: none;
		padding: 0.45rem 0.9rem;
		margin: 0;
		margin-bottom: -1px;
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--pico-muted-color);
		cursor: pointer;
		border-radius: var(--pico-border-radius) var(--pico-border-radius) 0 0;
		transition: color 150ms ease, background 150ms ease, border-color 150ms ease;
	}

	.tab-header:hover {
		color: var(--pico-primary);
		background: color-mix(in srgb, var(--pico-primary) 6%, transparent);
	}

	.tab-header.active {
		color: var(--pico-primary);
		background: var(--pico-card-background-color);
		border-color: var(--pico-muted-border-color);
		border-bottom: 1px solid var(--pico-card-background-color);
	}

	.tab-panels {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--pico-muted-border-color);
		border-top: none;
		border-radius: 0 0 var(--pico-border-radius) var(--pico-border-radius);
		background: var(--pico-card-background-color);
		padding: 0.75rem 1rem;
	}

	.tab-panel {
		display: none;
	}

	.tab-panel.active {
		display: block;
	}
</style>
