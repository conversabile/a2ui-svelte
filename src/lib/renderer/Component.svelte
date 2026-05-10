<script lang="ts">
	import { a2uiState } from '../core/state.svelte';
	import { userActionBus } from '../core/registries/event-bus';
	import { getCatalog } from '../authoring/catalog';
	import { resolveBoundValue, resolvePath } from '../core/bound-value';
	import Component from './Component.svelte';

	interface Props {
		surfaceId: string;
		id: string;
	}

	let { surfaceId, id }: Props = $props();

	const catalog = getCatalog();

	// Reactive derivation of component definition and props
	let surface = $derived(a2uiState.getSurface(surfaceId));
	let definition = $derived(surface?.components[id]);
	let ComponentConstructor = $derived(definition ? catalog[definition.type] : null);

	$effect(() => {
		if (definition) {
			console.log(`[Component:${id}] Type: ${definition.type}, Props:`, resolvedProps);
		} else {
			// Only log missing definition if we expected one (which we always do if this component is mounted)
			console.log(`[Component:${id}] Waiting for definition...`);
		}
	});

	/**
	 * Build the context payload for a `userAction` event by resolving every
	 * BoundValue inside the component's declared `action.context` against the
	 * current data model. Accepts either the spec adjacency-list form
	 * (`[{key, value}]`) or the plain object form that some agents emit.
	 */
	function resolveActionContext(rawContext: any): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		if (rawContext == null) return out;
		const data = surface?.data;
		if (Array.isArray(rawContext)) {
			for (const entry of rawContext) {
				if (entry && typeof entry.key === 'string') {
					out[entry.key] = resolveBoundValue(entry.value, data);
				}
			}
		} else if (typeof rawContext === 'object') {
			for (const [k, v] of Object.entries(rawContext)) {
				out[k] = resolveBoundValue(v, data);
			}
		}
		return out;
	}

	/**
	 * Emit a `userAction` event for the current component. Called by the
	 * synthetic `onclick` handler injected into interactive components that
	 * carry an A2UI `action` definition.
	 */
	function emitUserAction() {
		const rawAction = definition?.properties?.action;
		if (!rawAction || typeof rawAction.name !== 'string') return;
		userActionBus.emit({
			name: rawAction.name,
			surfaceId,
			componentId: id,
			context: resolveActionContext(rawAction.context)
		});
	}

	// Property Resolution Logic
	function resolveProps(props: Record<string, any>) {
		const resolved: Record<string, any> = {};
		for (const [key, value] of Object.entries(props)) {
			if (Array.isArray(value)) {
				// Plain arrays pass through directly (e.g. children: ["id1", "id2"])
				resolved[key] = value;
			} else if (value && typeof value === 'object') {
				if ('literalString' in value) resolved[key] = value.literalString;
				else if ('literalNumber' in value) resolved[key] = value.literalNumber;
				else if ('literalBoolean' in value) resolved[key] = value.literalBoolean;
				else if ('path' in value) {
					// A2UI v0.8 data binding: resolve via JSON Pointer (RFC 6901).
					resolved[key] = resolvePath(value.path, surface?.data);
				} else if ('explicitList' in value) {
					// Pass the list of IDs directly, logic will be handled in template
					resolved[key] = value.explicitList;
				} else {
					// Recursive resolution for nested objects (e.g. action map)
					resolved[key] = resolveProps(value);
				}
			} else {
				resolved[key] = value;
			}
		}
		return resolved;
	}

	let resolvedProps = $derived.by(() => {
		if (!definition) return {} as Record<string, any>;
		const props = resolveProps(definition.properties);
		// If the component declares an A2UI `action`, inject a synthetic
		// `onclick` handler so interactive components (Button) can emit a
		// `userAction` event to the agent when clicked. We keep the resolved
		// `action` object on the props too so the component can still read
		// metadata (e.g. name) if needed.
		if (definition.properties?.action?.name) {
			props.onclick = emitUserAction;
		}
		return props;
	});
	let childIds = $derived(
		Array.isArray(resolvedProps.children) ? resolvedProps.children :
		(typeof resolvedProps.child === 'string' ? [resolvedProps.child] : undefined)
	);
</script>

{#if definition && ComponentConstructor}
	<ComponentConstructor {...resolvedProps}>
		{#if childIds}
			{#each childIds as childId (childId)}
				<Component {surfaceId} id={childId} />
			{/each}
		{/if}
	</ComponentConstructor>
{:else if definition}
	<!-- Helpful dev-mode error: the catalog has no entry for this type. -->
	<pre class="a2ui-missing-component">[a2ui-svelte] No component for type "{definition.type}" in catalog.</pre>
{/if}
