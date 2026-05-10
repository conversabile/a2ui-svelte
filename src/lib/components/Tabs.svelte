<script lang="ts">
	import type { Snippet } from 'svelte';
	import { defineA2uiComponent } from '../authoring/define-component.svelte';

	interface TabSpec {
		key: string;
		title: string;
	}

	interface Props {
		id?: string;
		tabs: TabSpec[];
		content: Snippet<[string]>;
		class?: string;
	}

	let { id, tabs, content, class: className = '' }: Props = $props();

	// `tabItems` is registered with titles only; SurfaceRegistry.toJSON()
	// pairs them with the children registered under this Tabs (order = tab order).
	const handle = defineA2uiComponent({
		type: 'Tabs',
		id,
		a2ui: () => ({
			tabItems: tabs.map((t) => ({ title: { literalString: t.title } }))
		}),
		isContainer: true
	});

	let activeIndex = $state(0);

	$effect(() => {
		if (activeIndex >= tabs.length) activeIndex = 0;
	});

	function attachReveal(node: HTMLElement) {
		const handler = (e: Event) => {
			const detail = (e as CustomEvent<{ index: number }>).detail;
			if (!detail) return;
			if (detail.index >= 0 && detail.index < tabs.length) {
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

{#if handle.isHidden}
	<!-- Inside <A2UIRepresentation>: still render content snippets so descendants register -->
	{#each tabs as tab (tab.key)}
		{@render content(tab.key)}
	{/each}
{:else}
	<div class="tabs {className}" {...dataAttr} data-a2ui-tabs-root use:attachReveal>
		<div class="tab-headers" role="tablist">
			{#each tabs as tab, i (tab.key)}
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
			{#each tabs as tab, i (tab.key)}
				<div
					class="tab-panel"
					class:active={activeIndex === i}
					role="tabpanel"
					data-a2ui-tab-panel-index={i}
					aria-hidden={activeIndex !== i}
				>
					{@render content(tab.key)}
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
