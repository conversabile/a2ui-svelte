<script lang="ts">
	import { onDestroy, tick, getContext } from 'svelte';
	import { SurfaceRegistry, setSurfaceContext, setParentId } from '../core/surface-registry';
	import { actionRegistry } from '../core/registries/action-registry';
	import { highlightElements } from '../core/highlight';
	import { revealElements } from '../core/reveal';
	import type { Snippet } from 'svelte';
	import { SURFACE_FEEDBACK_KEY, type SurfaceFeedback } from './surface-feedback';
	import './styles.css';

	interface Props {
		surfaceId: string;
		children: Snippet;
		/**
		 * Optional global-state feedback callbacks. When omitted, the surface
		 * falls back to a `SurfaceFeedback` set on Svelte context under
		 * `SURFACE_FEEDBACK_KEY`. If neither is present the tool result simply
		 * omits `updatedSurface` / `updatedContext`.
		 */
		feedback?: SurfaceFeedback;
	}

	let { surfaceId, children, feedback }: Props = $props();

	// Resolve once at init: the surface's own `<script>` may still be running
	// `buildToolResult` after the host has navigated away and torn this
	// component down. Reading a `$derived` post-destroy yields an object
	// without callable methods.
	const ctxFeedback = getContext<SurfaceFeedback | undefined>(SURFACE_FEEDBACK_KEY);
	const effectiveFeedback: SurfaceFeedback | undefined = feedback ?? ctxFeedback;

	// Create registry for static surface
	const registry = new SurfaceRegistry(surfaceId);
	setSurfaceContext(registry);
	setParentId('root');

	function buildToolResult(results: Record<string, unknown>[]) {
		const fb = effectiveFeedback;
		return {
			results,
			...(fb
				? {
						updatedSurface: fb.globalSurfaces(),
						updatedContext: fb.contextInstructions()
					}
				: {}),
			availableElementIds: actionRegistry.listActions()
		};
	}

	// Register generic tools — these delegate to ActionRegistry
	// Both tools accept arrays for bulk operations (single-element arrays work fine for one-off calls)
	registry.registerTool({
		name: 'click_button',
		description:
			'Click one or more buttons in the UI. Each element_id must match a Button component ID from the surface JSON.',
		parameters: {
			type: 'object',
			properties: {
				clicks: {
					type: 'array',
					description: 'List of buttons to click',
					items: {
						type: 'object',
						properties: {
							element_id: {
								type: 'string',
								description: 'The component ID of the button to click'
							}
						},
						required: ['element_id']
					}
				}
			},
			required: ['clicks']
		},
		execute: async (args: Record<string, any>) => {
			const ids = args.clicks.map((c: any) => c.element_id);
			revealElements(ids);
			highlightElements(ids);
			const results: Record<string, any>[] = [];
			for (const item of args.clicks) {
				try {
					const result = await actionRegistry.execute(item.element_id, 'click');
					results.push({
						element_id: item.element_id,
						status: 'success',
						...(result && typeof result === 'object' ? result : {})
					});
				} catch (e: any) {
					results.push({
						element_id: item.element_id,
						status: 'error',
						error: e.message
					});
				}
			}

			// Give SvelteKit navigations/mounts a moment to settle, allowing
			// new StaticSurface components to register on the host's session.
			await new Promise((resolve) => setTimeout(resolve, 150));
			await tick(); // Wait for Svelte to render any reactive updates

			return buildToolResult(results);
		}
	});

	registry.registerTool({
		name: 'update_text_field',
		description:
			'Update one or more text field values in the UI. Each element_id must match a TextField component ID from the surface JSON.',
		parameters: {
			type: 'object',
			properties: {
				updates: {
					type: 'array',
					description: 'List of text fields to update, each with an element_id and a value',
					items: {
						type: 'object',
						properties: {
							element_id: {
								type: 'string',
								description: 'The component ID of the text field to update'
							},
							value: {
								type: 'string',
								description: 'The new value for the text field'
							}
						},
						required: ['element_id', 'value']
					}
				}
			},
			required: ['updates']
		},
		execute: async (args: Record<string, any>) => {
			const ids = args.updates.map((u: any) => u.element_id);
			revealElements(ids);
			highlightElements(ids);
			const results: Record<string, any>[] = [];
			for (const item of args.updates) {
				try {
					const result = await actionRegistry.execute(item.element_id, 'update', item.value);
					results.push({
						element_id: item.element_id,
						status: 'success',
						...(result && typeof result === 'object' ? result : {})
					});
				} catch (e: any) {
					results.push({
						element_id: item.element_id,
						status: 'error',
						error: e.message
					});
				}
			}

			// Give SvelteKit navigations/mounts a moment to settle, allowing
			// new StaticSurface components to register on the host's session.
			await new Promise((resolve) => setTimeout(resolve, 150));
			await tick(); // Wait for Svelte to render any reactive updates

			return buildToolResult(results);
		}
	});

	// Clean up ActionRegistry entries for this surface on destroy
	onDestroy(() => {
		actionRegistry.unregisterBySurface(surfaceId);
	});

	// Expose properties for GeminiLive (or other controllers)
	export const id = surfaceId;
	export const type = 'static';
	export const getJson = () => registry.toJSON();
	export const getTools = () => registry.getTools();
</script>

<div class="a2ui-surface a2ui-static-surface" data-surface-id={surfaceId}>
	{@render children()}
</div>

<style>
	/* Surface-specific styles are now in styles.css */
</style>
