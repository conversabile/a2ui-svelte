<script lang="ts">
	import type { Snippet } from 'svelte';
	import { defineA2uiComponent } from '../authoring/define-component.svelte';

	interface Props {
		id?: string;
		/**
		 * Static-surface authoring: the always-visible element that opens the
		 * modal when activated (e.g. a Button).
		 */
		entryPoint?: Snippet;
		/** Static-surface authoring: the overlay content shown while open. */
		content?: Snippet;
		/**
		 * Dynamic-surface rendering: component IDs resolved from the A2UI JSON.
		 * `renderChild` (injected by the renderer) turns an ID into markup.
		 */
		entryPointChild?: string;
		contentChild?: string;
		renderChild?: Snippet<[string]>;
		/** Whether the overlay is currently shown. */
		open?: boolean;
		accessibility?: { label?: string; role?: string };
		weight?: number;
		class?: string;
	}

	let {
		id,
		entryPoint,
		content,
		entryPointChild,
		contentChild,
		renderChild,
		open = $bindable(false),
		accessibility,
		weight,
		class: className = ''
	}: Props = $props();

	// In static-authoring mode the entry point and content are registered as
	// the first and second children of the Modal; SurfaceRegistry.toJSON()
	// pairs them with `entryPointChild` / `contentChild`. In dynamic mode the
	// JSON already carries those IDs, so `a2ui()` only emits common props.
	const handle = defineA2uiComponent({
		type: 'Modal',
		id,
		a2ui: () => ({
			...(entryPointChild ? { entryPointChild } : {}),
			...(contentChild ? { contentChild } : {}),
			...(accessibility ? { accessibility } : {}),
			...(weight != null ? { weight } : {})
		}),
		isContainer: true
	});

	export const dataAttr = handle.dataAttr;
	export const componentId = handle.componentId;
</script>

{#if handle.isHidden}
	<!-- Inside <A2UIRepresentation>: still render children so they register. -->
	{#if entryPoint}{@render entryPoint()}{:else if entryPointChild && renderChild}{@render renderChild(
			entryPointChild
		)}{/if}
	{#if content}{@render content()}{:else if contentChild && renderChild}{@render renderChild(
			contentChild
		)}{/if}
{:else}
	<div {...handle.dataAttr} {...handle.a11yAttr} class="a2ui-modal {className}" style={handle.weightStyle}>
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<span class="a2ui-modal-entry" onclick={() => (open = true)}>
			{#if entryPoint}{@render entryPoint()}{:else if entryPointChild && renderChild}{@render renderChild(
					entryPointChild
				)}{/if}
		</span>

		{#if open}
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
			<div class="a2ui-modal-backdrop" onclick={() => (open = false)}>
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
				<div
					class="a2ui-modal-dialog"
					role="dialog"
					tabindex="-1"
					aria-modal="true"
					aria-label={accessibility?.label}
					onclick={(e) => e.stopPropagation()}
				>
					<button
						type="button"
						class="a2ui-modal-close outline secondary"
						aria-label="Close"
						onclick={() => (open = false)}>✕</button
					>
					{#if content}{@render content()}{:else if contentChild && renderChild}{@render renderChild(
							contentChild
						)}{/if}
				</div>
			</div>
		{/if}
	</div>
{/if}

<style>
	.a2ui-modal {
		display: contents;
	}
	.a2ui-modal-entry {
		display: inline-block;
		cursor: pointer;
	}
	.a2ui-modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		padding: 1rem;
	}
	.a2ui-modal-dialog {
		position: relative;
		background: var(--pico-card-background-color, #fff);
		border-radius: var(--pico-border-radius, 0.25rem);
		padding: 1.5rem;
		max-width: 90vw;
		max-height: 85vh;
		overflow: auto;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
	}
	.a2ui-modal-close {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		width: 2rem;
		height: 2rem;
		padding: 0;
		line-height: 1;
	}
</style>
