<script lang="ts">
	import { onDestroy, tick, getContext } from 'svelte';
	import { SurfaceRegistry, setSurfaceContext, setParentId } from '../core/surface-registry';
	import { actionRegistry } from '../core/registries/action-registry';
	import { highlightElements } from '../core/highlight';
	import { revealElements } from '../core/reveal';
	import { A2UI_EXTENSION_NAMESPACE, getExtensions } from '../core/extensions';
	import {
		structuralFingerprint,
		readDataModelsBySurface,
		diffDataModelsBySurface
	} from '../core/surface-snapshot';
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

	// ── 'changed' tool-result mode: the model's last-known state ──
	// Seeded lazily just before the FIRST tool action runs (at that moment the
	// surface state is exactly what the system prompt showed the model — any
	// earlier user edits were delivered by the surface-watch sync), then
	// advanced after every envelope build. Lets `buildToolResult` echo only
	// what the action actually changed instead of the whole tree.
	let echoBaseline: {
		structure: string;
		dataModels: Record<string, Record<string, unknown>>;
		context: string;
		elementIds: string;
	} | null = null;

	function captureEchoBaseline() {
		if (getExtensions().toolResultSurfaceEcho !== 'changed' || echoBaseline) return;
		const fb = effectiveFeedback;
		if (!fb) return;
		const surfaces = fb.globalSurfaces();
		echoBaseline = {
			structure: structuralFingerprint(surfaces),
			dataModels: readDataModelsBySurface(surfaces),
			context: fb.contextInstructions(),
			elementIds: JSON.stringify(actionRegistry.listActions())
		};
	}

	function buildToolResult(results: Record<string, unknown>[]) {
		// B4: shape the tool-result envelope per the app-wide
		// `toolResultSurfaceEcho` extension.
		//
		//   `'full'` (default): spec-canonical `results` at the top level; the
		//                     echo (`updatedSurface`, `updatedContext`,
		//                     `availableElementIds`) moved under
		//                     `extensions['a2ui-svelte']` so 3P consumers that
		//                     don't recognise the namespace can drop the whole
		//                     extension blob and still see the spec result.
		//   `'changed'`:      the echo carries only what CHANGED vs the model's
		//                     last-known state — `updatedSurface` only on a
		//                     structural change, `updatedDataModel` for value
		//                     changes, context/ids only when changed. Nothing
		//                     changed ⇒ just `{ results }`.
		//   `'none'` (STRICT): just `{ results: [...] }` — no echo.
		const mode = getExtensions().toolResultSurfaceEcho;
		if (mode === 'none') {
			return { results };
		}
		const fb = effectiveFeedback;
		if (mode === 'changed' && fb) {
			return buildDiffToolResult(results, fb);
		}
		const extras: Record<string, unknown> = {
			availableElementIds: actionRegistry.listActions()
		};
		if (fb) {
			extras.updatedSurface = fb.globalSurfaces();
			extras.updatedContext = fb.contextInstructions();
		}
		return {
			results,
			extensions: { [A2UI_EXTENSION_NAMESPACE]: extras }
		};
	}

	function buildDiffToolResult(results: Record<string, unknown>[], fb: SurfaceFeedback) {
		const surfaces = fb.globalSurfaces();
		const structure = structuralFingerprint(surfaces);
		const dataModels = readDataModelsBySurface(surfaces);
		const context = fb.contextInstructions();
		const elementIds = JSON.stringify(actionRegistry.listActions());

		const prev = echoBaseline;
		const extras: Record<string, unknown> = {};
		if (!prev || structure !== prev.structure) {
			// Structure changed (a component appeared/disappeared, navigation):
			// a value delta can't convey that, so echo the full tree — exactly
			// like `true` mode. The data-model values ride inside it.
			extras.updatedSurface = surfaces;
		} else {
			const delta = diffDataModelsBySurface(prev.dataModels, dataModels);
			// The model already knows the values it just wrote — but a click may
			// have mutated OTHER fields too (a form reset). Report every change;
			// the agent's own writes are a few bytes and double as confirmation.
			if (Object.keys(delta).length > 0) extras.updatedDataModel = delta;
		}
		if (!prev || context !== prev.context) extras.updatedContext = context;
		if (!prev || elementIds !== prev.elementIds) {
			extras.availableElementIds = JSON.parse(elementIds);
		}
		echoBaseline = { structure, dataModels, context, elementIds };

		if (Object.keys(extras).length === 0) return { results };
		return {
			results,
			extensions: { [A2UI_EXTENSION_NAMESPACE]: extras }
		};
	}

	async function runClicks(ids: string[]) {
		// 'changed' mode: the pre-action state is what the model last saw (the
		// system prompt at connect; sync-mode delivery covers user edits since).
		captureEchoBaseline();
		revealElements(ids);
		highlightElements(ids);
		const results: Record<string, any>[] = [];
		for (const elementId of ids) {
			try {
				const result = await actionRegistry.execute(elementId, 'click');
				results.push({
					element_id: elementId,
					status: 'success',
					...(result && typeof result === 'object' ? result : {})
				});
			} catch (e: any) {
				results.push({
					element_id: elementId,
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

	/**
	 * On-demand pointer gesture (`point_to_elements`). Reveals + glows the
	 * targets so the agent can draw the user's eye to on-screen data, then
	 * reports which IDs were found.
	 *
	 * Unlike `runClicks` / `runUpdates` this mutates NOTHING, so it deliberately
	 * returns a lean `{ results }` even when the surface echo is on: echoing
	 * the whole serialized surface back on a purely visual "look here" call is
	 * the exact token amplifier we avoid elsewhere, and a highlight leaves the
	 * agent's surface understanding unchanged.
	 */
	function runPointer(ids: string[]) {
		revealElements(ids);
		const found = new Set(highlightElements(ids));
		const results = ids.map((element_id) => ({
			element_id,
			status: found.has(element_id) ? 'pointed' : 'not_found'
		}));
		return { results };
	}

	async function runUpdates(items: Array<{ element_id: string; value: string }>) {
		captureEchoBaseline();
		const ids = items.map((u) => u.element_id);
		revealElements(ids);
		highlightElements(ids);
		const results: Record<string, any>[] = [];
		for (const item of items) {
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

	// B3: spec-canonical single-element tools — always registered. These match
	// the A2UI v0.8 generic-tool shape verbatim so any spec-compliant external
	// agent can drive the surface without surprises.
	registry.registerTool({
		name: 'click_button',
		description:
			'Click a single button in the UI. `element_id` must match a Button component ID from the surface JSON.',
		parameters: {
			type: 'object',
			properties: {
				element_id: {
					type: 'string',
					description: 'The component ID of the button to click'
				}
			},
			required: ['element_id']
		},
		execute: async (args: Record<string, any>) => runClicks([args.element_id])
	});

	registry.registerTool({
		name: 'update_text_field',
		description:
			'Update the value of a single input component in the UI. Works for any value-bearing component: TextField, Slider, DateTimeInput, CheckBox, MultipleChoice, and Tabs. `element_id` must match a component ID from the surface JSON. Pass the new value as a string — a number for Slider, an ISO date/time for DateTimeInput, "true"/"false" for CheckBox, an option value for MultipleChoice, or a tab title for Tabs.',
		parameters: {
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
		},
		execute: async (args: Record<string, any>) =>
			runUpdates([{ element_id: args.element_id, value: args.value }])
	});

	// B3: batched variants — registered only when the `batchTools` extension
	// is on. Explicit plural names (`click_buttons` /
	// `update_text_fields`) keep them distinct from the spec-canonical tools
	// above and signal "this is an `a2ui-svelte` extension, not v0.8 spec".
	if (getExtensions().batchTools) {
		registry.registerTool({
			name: 'click_buttons',
			description:
				'Click multiple buttons in the UI in one call (a2ui-svelte extension; the spec-canonical single-element form is `click_button`). Each element_id must match a Button component ID from the surface JSON.',
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
			execute: async (args: Record<string, any>) =>
				runClicks(args.clicks.map((c: any) => c.element_id))
		});

		registry.registerTool({
			name: 'update_text_fields',
			description:
				'Update the value of multiple input components in the UI in one call (a2ui-svelte extension; the spec-canonical single-element form is `update_text_field`). Works for any value-bearing component: TextField, Slider, DateTimeInput, CheckBox, MultipleChoice, and Tabs.',
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
			execute: async (args: Record<string, any>) => runUpdates(args.updates)
		});
	}

	// On-demand pointer tool — registered only when the `pointerTool`
	// extension is on. Lets the agent draw the user's eye to components WITHOUT
	// changing them; the click/update tools already glow their targets as a side
	// effect, this is the standalone "point at it" gesture. Not a v0.8 tool, so
	// it stays off under STRICT.
	if (getExtensions().pointerTool) {
		registry.registerTool({
			name: 'point_to_elements',
			description:
				"Draw the user's attention to one or more components on screen: each is scrolled into view and glows briefly. Use it when the user asks you to show, point out, or find something (\"where do I save this?\", \"show me the address field\"), or when you mention specific on-screen data and want to indicate it. `element_ids` are component IDs from the surface JSON, in the order to visit them. This is a PURELY VISUAL pointer — it does NOT change any values and does NOT activate anything. To edit a value use update_text_field; to activate a control use click_button.",
			parameters: {
				type: 'object',
				properties: {
					element_ids: {
						type: 'array',
						description: 'Component IDs to point at (glow + scroll into view), in visit order',
						items: { type: 'string' }
					}
				},
				required: ['element_ids']
			},
			execute: async (args: Record<string, any>) =>
				runPointer(Array.isArray(args.element_ids) ? args.element_ids : [args.element_ids])
		});
	}

	// Clean up this surface's registry entries on destroy: its actions, and the
	// tools above — whose closures would otherwise keep driving a dead surface.
	onDestroy(() => {
		actionRegistry.unregisterBySurface(surfaceId);
		registry.dispose();
	});

	// Expose properties for GeminiLive (or other controllers)
	export const id = surfaceId;
	export const type = 'static';
	export const getJson = () => registry.toJSON();
	export const getTools = () => registry.getTools();
	/**
	 * The surface's `{ fieldId → value }` data model — the unit the
	 * `Agent` syncs in `'sync'` mode (A2UI v0.9). Decoupled from the
	 * component tree so a keystroke ships as a tiny delta, not the whole tree.
	 */
	export const getDataModel = () => registry.getDataModel();
</script>

<div class="a2ui-surface a2ui-static-surface" data-surface-id={surfaceId}>
	{@render children()}
</div>

<style>
	/* Surface-specific styles are now in styles.css */
</style>
