import type { Component } from 'svelte';
import { setContext, getContext } from 'svelte';

/**
 * A catalog maps A2UI component type names (e.g. "Button", "Card") to
 * the Svelte component that renders them on a dynamic surface.
 *
 * The renderer reads the catalog from Svelte context. Consumers set it
 * by passing a `catalog` prop to <DynamicSurface>.
 *
 * Keys MUST match the A2UI v0.8 spec component-type names exactly
 * (case-sensitive). Catalog values are typed as `Component<any>` because
 * the catalog is heterogeneous; per-component prop validation is the spec's
 * job and is enforced at runtime by the renderer's prop-resolution logic.
 */
export type Catalog = Record<string, Component<any>>;

const CATALOG_KEY = Symbol('a2ui:catalog');

export function setCatalog(catalog: Catalog): void {
	setContext(CATALOG_KEY, catalog);
}

export function getCatalog(): Catalog {
	const c = getContext<Catalog | undefined>(CATALOG_KEY);
	if (!c) {
		throw new Error(
			'[a2ui-svelte] No catalog in context. ' +
				'Wrap your dynamic surfaces in <DynamicSurface catalog={...}> ' +
				'or pass `catalog={DEFAULT_CATALOG}` for the built-in components.'
		);
	}
	return c;
}

/**
 * Create a fresh catalog from a record. Identity helper — exists so
 * downstream consumers and IDEs see the type explicitly.
 */
export function createCatalog(catalog: Catalog): Catalog {
	return { ...catalog };
}

/**
 * Extend an existing catalog with overrides. Later entries win.
 * Use this to swap out built-ins or add custom types.
 *
 * @example
 * import { DEFAULT_CATALOG, extendCatalog } from 'a2ui-svelte/authoring';
 * import MyButton from './MyButton.svelte';
 * import Chart   from './Chart.svelte';
 *
 * export const MY_CATALOG = extendCatalog(DEFAULT_CATALOG, {
 *   Button: MyButton,   // re-skin
 *   Chart               // brand-new type
 * });
 */
export function extendCatalog(base: Catalog, overrides: Catalog): Catalog {
	return { ...base, ...overrides };
}
