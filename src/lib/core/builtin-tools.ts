/**
 * The built-in tools the agent drives a static surface with.
 *
 * **These are ours, not A2UI's** — the spec has no agent-drives-the-UI
 * direction, only `userAction` (v0.8 §5). Don't call them spec-canonical.
 *
 * They are page-wide, not per-surface: `click_button` targets an element by
 * id, and ids are resolved through the global `actionRegistry`, so which
 * surface holds the element never matters. They are registered once, by the
 * surface index, while at least one static surface is mounted — see
 * `registries/surface-index.ts`.
 *
 * What they return is a bare `{ results }`. The `updatedSurface` /
 * `updatedDataModel` / `availableElementIds` echo is built by the `Agent` (it
 * owns the notion of "what this model last saw"), which is why the mutating
 * tools carry `mutatesSurface: true`.
 */

import { tick } from 'svelte';
import { actionRegistry } from './registries/action-registry';
import { toolRegistry, type ToolDefinition } from './registries/tool-registry';
import { getExtensions } from './extensions';
import { highlightElements } from './highlight';
import { revealElements } from './reveal';

/** Names this module owns, so unregistering is exhaustive without bookkeeping. */
const BUILTIN_TOOL_NAMES = [
	'click_button',
	'update_text_field',
	'click_buttons',
	'update_text_fields',
	'point_to_elements'
];

/**
 * Let a SvelteKit navigation / mount settle, then flush Svelte's reactive
 * updates, so the state the agent is told about is the post-action state.
 */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 150));
	await tick();
}

async function runClicks(ids: string[]) {
	revealElements(ids);
	highlightElements(ids);
	const results: Record<string, unknown>[] = [];
	for (const elementId of ids) {
		try {
			const result = await actionRegistry.execute(elementId, 'click');
			results.push({
				element_id: elementId,
				status: 'success',
				...(result && typeof result === 'object' ? result : {})
			});
		} catch (e) {
			results.push({
				element_id: elementId,
				status: 'error',
				error: (e as Error).message
			});
		}
	}
	await settle();
	return { results };
}

async function runUpdates(items: Array<{ element_id: string; value: string }>) {
	const ids = items.map((u) => u.element_id);
	revealElements(ids);
	highlightElements(ids);
	const results: Record<string, unknown>[] = [];
	for (const item of items) {
		try {
			const result = await actionRegistry.execute(item.element_id, 'update', item.value);
			results.push({
				element_id: item.element_id,
				status: 'success',
				...(result && typeof result === 'object' ? result : {})
			});
		} catch (e) {
			results.push({
				element_id: item.element_id,
				status: 'error',
				error: (e as Error).message
			});
		}
	}
	await settle();
	return { results };
}

/**
 * On-demand pointer gesture (`point_to_elements`). Reveals + glows the targets
 * so the agent can draw the user's eye to on-screen data, then reports per id
 * whether it resolved: `status: 'success'`, or `'error'` with a message when
 * nothing on screen carries that id — pointing at an id that isn't there is a
 * failure, and the model can act on the message.
 *
 * Unlike the click/update tools this mutates NOTHING, so it is deliberately
 * NOT marked `mutatesSurface`: echoing the whole serialized surface back on a
 * purely visual "look here" call is the exact token amplifier we avoid
 * elsewhere, and a highlight leaves the agent's surface understanding
 * unchanged.
 */
function runPointer(ids: string[]) {
	revealElements(ids);
	const found = new Set(highlightElements(ids));
	return {
		results: ids.map((element_id) =>
			found.has(element_id)
				? { element_id, status: 'success' }
				: {
						element_id,
						status: 'error',
						error: `No element "${element_id}" on any mounted surface`
					}
		)
	};
}

/**
 * The single-element tools. Registered unconditionally: they are how ANY agent
 * drives a static surface, and `toolRegistry.execute(name, args)` is the entry
 * point an external agent comes through, so they must not vanish because an
 * extension is on. (Which tools our OWN model is *told* about is a separate
 * question, answered in `Agent`.)
 */
function coreTools(): ToolDefinition[] {
	return [
		{
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
			mutatesSurface: true,
			execute: async (args: Record<string, any>) => runClicks([args.element_id])
		},
		{
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
			mutatesSurface: true,
			execute: async (args: Record<string, any>) =>
				runUpdates([{ element_id: args.element_id, value: args.value }])
		}
	];
}

/**
 * Batched variants — registered only when the `batchTools` extension is on.
 * Explicit plural names keep them distinct from the single-element tools.
 */
function batchedTools(): ToolDefinition[] {
	return [
		{
			name: 'click_buttons',
			description:
				'Click multiple buttons in the UI in one call (a2ui-svelte extension; the single-element form is `click_button`). Each element_id must match a Button component ID from the surface JSON.',
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
			mutatesSurface: true,
			execute: async (args: Record<string, any>) =>
				runClicks(args.clicks.map((c: any) => c.element_id))
		},
		{
			name: 'update_text_fields',
			description:
				'Update the value of multiple input components in the UI in one call (a2ui-svelte extension; the single-element form is `update_text_field`). Works for any value-bearing component: TextField, Slider, DateTimeInput, CheckBox, MultipleChoice, and Tabs.',
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
			mutatesSurface: true,
			execute: async (args: Record<string, any>) => runUpdates(args.updates)
		}
	];
}

/** The standalone "point at it" gesture — behind the `pointerTool` extension. */
function pointerTools(): ToolDefinition[] {
	return [
		{
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
		}
	];
}

/**
 * Install the built-in tools, reading the app-wide extension record for the
 * optional ones. Called by the surface index when the first static surface
 * mounts — never at module scope, or a server render would leave them behind.
 */
export function registerBuiltinTools(): void {
	const ext = getExtensions();
	const tools = [
		...coreTools(),
		...(ext.batchTools ? batchedTools() : []),
		...(ext.pointerTool ? pointerTools() : [])
	];
	for (const tool of tools) toolRegistry.register(tool);
}

/** Remove them again — called when the last static surface unmounts. */
export function unregisterBuiltinTools(): void {
	for (const name of BUILTIN_TOOL_NAMES) toolRegistry.unregister(name);
}
