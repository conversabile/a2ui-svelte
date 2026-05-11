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
	 */
	a2ui: () => A2uiProperties;

	/**
	 * Optional data-source registration. `{ key, value: () => current }`
	 * binds a key in the surface data model to a reactive accessor — the
	 * agent reads it via JSON-Pointer `/{key}` paths.
	 */
	data?: { key: string; value: () => unknown };

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

		// Initial synchronous register so parents see this child during
		// their own setup (Card / Column / Row read childrenByParent).
		ctx.register(componentId, parentId, { [opts.type]: opts.a2ui() });

		if (opts.isContainer) setParentId(componentId);

		// Reactive re-registration. `register()` is upsert; the surface-watch
		// diff in the consumer host (e.g. GeminiLive) prevents duplicate
		// SURFACE_UPDATED notifications.
		$effect(() => {
			ctx.register(componentId, parentId, { [opts.type]: opts.a2ui() });
		});

		if (opts.data) {
			ctx.registerData(opts.data.key, opts.data.value);
		}

		if (opts.action) {
			actionRegistry.register(componentId, opts.action.type, opts.action.handler, ctx.surfaceId);
		}

		onDestroy(() => {
			if (opts.action) actionRegistry.unregister(componentId);
			if (opts.data) ctx.unregisterData(opts.data.key);
			ctx.unregister(componentId);
		});
	}

	const dataAttr: Record<string, string> = componentId
		? { 'data-a2ui-id': componentId }
		: {};

	const resolved = $derived.by(() => unwrapProperties(opts.a2ui()) as P);

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
		isHidden,
		get resolved() {
			return resolved;
		},
		fire
	};
}
