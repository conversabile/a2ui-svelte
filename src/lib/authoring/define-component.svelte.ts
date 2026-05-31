import { onDestroy, getContext } from 'svelte';
import { getSurfaceContext, getParentId, setParentId } from '../core/surface-registry';
import { actionRegistry, type ActionType } from '../core/registries/action-registry';
import { unwrapProperties } from '../core/bound-value';
import { A2UI_REPRESENTATION_KEY } from './A2UIRepresentation.svelte';

/**
 * Inner properties of an A2UI ComponentDefinition (everything under the
 * `<Type>:` wrapper). Each value is either a literal, a BoundValue
 * (`{ literalString | literalNumber | literalBoolean | path }`), or a
 * structural sub-object (e.g. `children: { explicitList: [...] }`).
 */
export type A2uiProperties = Record<string, unknown>;

/**
 * Action registration shape passed to `defineA2uiComponent`. The framework
 * wires the callback into ActionRegistry under the component's id.
 *
 * - `'click'` callbacks take no value.
 * - `'update'` callbacks receive the new value as the first arg.
 */
export type ActionRegistration =
	| { type: 'click'; handler: () => void | Promise<void> | unknown }
	| { type: 'update'; handler: (value: string) => void | Promise<void> | unknown };

export interface DefineA2uiComponentOptions {
	/** A2UI v0.8 spec component-type name. Must match a key in the consumer's catalog for dynamic surfaces. */
	type: string;

	/** Stable id. Auto-generated as `${type.toLowerCase()}-${n}` when omitted. */
	id?: string;

	/**
	 * Reactive thunk returning the inner ComponentDefinition properties.
	 * The framework calls this once at setup and again inside a `$effect`
	 * so reactive deps trigger re-registration. Return only the inner
	 * object — the type wrapper (`{ Text: {...} }`) is added by the helper.
	 *
	 * Receives the resolved `componentId` (the provided `id` or the
	 * auto-generated one; `undefined` when rendered outside a surface) so a
	 * value-bearing input can path-bind to its own data-model key even when no
	 * explicit `fieldName`/`id` was given — e.g.
	 * `value: { path: '/' + (fieldName ?? componentId) }`. Pair it with a
	 * matching `data` registration (see below) to keep the value out of the
	 * structural snapshot so `'sync'`-mode delivery stays on the cheap delta
	 * path (see the surface-data-model-sync plan §6).
	 */
	a2ui: (componentId: string | undefined) => A2uiProperties;

	/**
	 * Optional data-source registration. `{ key, value: () => current }`
	 * binds a key in the surface data model to a reactive accessor — the
	 * agent reads it via JSON-Pointer `/{key}` paths. When `key` is omitted
	 * it defaults to the component's resolved `id`, so an input without an
	 * explicit `fieldName` still registers its value as a data source (keyed
	 * by id) rather than inlining it into the component tree.
	 */
	data?: { key?: string; value: () => unknown };

	/** Optional ActionRegistry registration; see `ActionRegistration`. */
	action?: ActionRegistration;

	/**
	 * Whether children rendered inside this component should be registered
	 * under it as parent. Defaults to false. Set true for Card, Column,
	 * Row, List, Tabs.
	 */
	isContainer?: boolean;
}

export interface A2uiComponentHandle<P extends A2uiProperties = A2uiProperties> {
	/** Final id (provided or auto-generated). `undefined` if not in a surface. */
	componentId: string | undefined;

	/**
	 * Spread on the rendered HTML root: `<p {...dataAttr}>...</p>`. Adds
	 * `data-a2ui-id={componentId}` so the highlight + reveal helpers can
	 * find the element. Empty object when not in a surface.
	 */
	readonly dataAttr: Record<string, string>;

	/**
	 * Accessibility attributes derived from the spec-standard `accessibility`
	 * common property (`{ label, role }`). Spread on the rendered HTML root
	 * alongside `dataAttr`: `<p {...dataAttr} {...a11yAttr}>`. Empty when the
	 * component declares no `accessibility`.
	 */
	readonly a11yAttr: Record<string, string>;

	/**
	 * CSS declaration translating the spec-standard `weight` common property
	 * into `flex-grow`, so a component placed inside a Row/Column/List can
	 * claim proportional space. Empty string when no `weight` is declared.
	 * Apply via `style={weightStyle}` on the rendered HTML root.
	 */
	readonly weightStyle: string;

	/**
	 * `true` when this component lives inside an `<A2UIRepresentation>` —
	 * the template should suppress its visible markup.
	 */
	readonly isHidden: boolean;

	/**
	 * Reactive resolved properties. BoundValue wrappers are stripped
	 * (`{ literalString: 'x' }` → `'x'`). Templates use this directly:
	 * `<p>{resolved.text}</p>`.
	 */
	readonly resolved: P;

	/**
	 * Programmatically fire the registered action. No-op if no action.
	 * Exposed on the component instance for composite usage:
	 *
	 *   <button onclick={() => buttonNode.fire()}>Click</button>
	 */
	fire: (value?: string) => Promise<unknown>;
}

/**
 * The boilerplate-killing helper. Handles registration, $effect,
 * onDestroy, and BoundValue resolution. Works in both static-surface
 * mode (component is composed natively) and dynamic-surface mode
 * (component is rendered from JSON via the renderer's catalog).
 *
 * Safe to call outside any surface — returns inert handles so the
 * component still renders standalone.
 */
export function defineA2uiComponent<P extends A2uiProperties = A2uiProperties>(
	opts: DefineA2uiComponentOptions
): A2uiComponentHandle<P> {
	const ctx = getSurfaceContext();
	const isHidden = getContext<boolean | undefined>(A2UI_REPRESENTATION_KEY) === true;

	// Generate the id ONCE outside the effect so re-registration doesn't
	// mint a fresh id on every reactive tick.
	const componentId: string | undefined = ctx
		? (opts.id ?? ctx.generateId(opts.type))
		: undefined;

	if (ctx && componentId) {
		const parentId = getParentId();
		// Data-source key defaults to the component id when not given an
		// explicit one, so a `fieldName`-less input still binds its value into
		// the data model (keyed by id) instead of inlining it in the tree.
		const dataKey = opts.data ? (opts.data.key ?? componentId) : undefined;

		// Initial synchronous register so parents see this child during
		// their own setup (Card / Column / Row read childrenByParent).
		ctx.register(componentId, parentId, { [opts.type]: opts.a2ui(componentId) });

		if (opts.isContainer) setParentId(componentId);

		// Reactive re-registration. `register()` is upsert; the surface-watch
		// diff in the consumer host (e.g. GeminiLive) prevents duplicate
		// SURFACE_UPDATED notifications.
		$effect(() => {
			ctx.register(componentId, parentId, { [opts.type]: opts.a2ui(componentId) });
		});

		if (opts.data && dataKey) {
			ctx.registerData(dataKey, opts.data.value);
		}

		if (opts.action) {
			actionRegistry.register(componentId, opts.action.type, opts.action.handler, ctx.surfaceId);
		}

		onDestroy(() => {
			if (opts.action) actionRegistry.unregister(componentId);
			if (opts.data && dataKey) ctx.unregisterData(dataKey);
			ctx.unregister(componentId);
		});
	}

	const dataAttr: Record<string, string> = componentId
		? { 'data-a2ui-id': componentId }
		: {};

	// Honour the spec-standard common properties `accessibility` and `weight`.
	// Both are read from the component's declared A2UI properties so they are
	// also serialized into the surface JSON. They are treated as static here
	// (a reactive accessibility label is vanishingly rare); the probe call is
	// a pure thunk so calling it once more is cheap.
	const commonProbe = opts.a2ui(componentId);
	const a11yAttr: Record<string, string> = {};
	const accessibility = commonProbe?.accessibility as
		| { label?: string; role?: string }
		| undefined;
	if (accessibility && typeof accessibility === 'object') {
		if (typeof accessibility.label === 'string') a11yAttr['aria-label'] = accessibility.label;
		if (typeof accessibility.role === 'string') a11yAttr['role'] = accessibility.role;
	}
	const weight = commonProbe?.weight;
	const weightStyle = typeof weight === 'number' ? `flex-grow: ${weight};` : '';

	const resolved = $derived.by(() => unwrapProperties(opts.a2ui(componentId)) as P);

	const fire = async (value?: string): Promise<unknown> => {
		if (!opts.action) return undefined;
		// Without a surface-registry context (e.g. inside a <DynamicSurface>),
		// no actionRegistry entry was created at setup. Invoke the handler
		// directly so the user-click → action-handler path still fires; in
		// dynamic mode the handler is the synthetic `onclick` injected by the
		// renderer's Component.svelte, which forwards a userAction event back
		// to the agent.
		if (!componentId) {
			if (opts.action.type === 'update') {
				return (opts.action as { type: 'update'; handler: (v: string) => unknown }).handler(value ?? '');
			}
			return (opts.action as { type: 'click'; handler: () => unknown }).handler();
		}
		const type: ActionType = opts.action.type;
		if (type === 'update') {
			return actionRegistry.execute(componentId, type, value ?? '');
		}
		return actionRegistry.execute(componentId, type);
	};

	return {
		componentId,
		dataAttr,
		a11yAttr,
		weightStyle,
		isHidden,
		get resolved() {
			return resolved;
		},
		fire
	};
}
