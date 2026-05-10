/**
 * Optional feedback contract for `<StaticSurface>` tool results.
 *
 * When the agent calls a tool on a surface (e.g. `click_button`), the tool
 * result includes a snapshot of the global UI state so the model can reason
 * about the post-action world without polling. Returning the values is the
 * host app's responsibility — the library does not know about other surfaces
 * or context strings.
 *
 * Hosts wire this in once at the layout level via Svelte context:
 *
 *   import { setContext } from 'svelte';
 *   import { SURFACE_FEEDBACK_KEY, type SurfaceFeedback } from 'a2ui-svelte/renderer';
 *   setContext<SurfaceFeedback>(SURFACE_FEEDBACK_KEY, { globalSurfaces, contextInstructions });
 *
 * Individual `<StaticSurface>` mounts may also pass a `feedback` prop to
 * override or augment the layout-level provider for their subtree.
 */
export interface SurfaceFeedback {
	/** Aggregate JSON of every static surface currently mounted, for the agent's context. */
	globalSurfaces: () => unknown;
	/** Current page-specific context instructions to ship alongside. */
	contextInstructions: () => string;
}

/** Svelte context key used by `<StaticSurface>` to read a host-provided `SurfaceFeedback`. */
export const SURFACE_FEEDBACK_KEY = 'a2ui:surface-feedback';
