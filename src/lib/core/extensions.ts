/**
 * A2UI v0.8 extension boundary.
 *
 * Everything the library emits or accepts that goes beyond the v0.8
 * specification lives behind a single, namespaced envelope so that
 * spec-compliant 3P consumers can safely ignore it.
 *
 * The spec-defined fields stay at the top level of every payload; the
 * extra fields move under `extensions: { 'a2ui-svelte': {...} }`.
 *
 * Spec-compliant consumers that do not recognise `extensions['a2ui-svelte']`
 * simply drop it — their core static / dynamic surface contracts are
 * unaffected.
 *
 * # Where extensions live
 *
 * `Extensions` is **one app-wide record**, set once at startup with
 * `configureExtensions` and read anywhere with `getExtensions`. An extension
 * describes the protocol this library speaks, not a region of the page: half
 * of them name a *global* tool, so two surfaces cannot disagree about whether
 * a tool name exists.
 *
 * ```svelte
 * <!-- src/routes/+layout.svelte -->
 * <script>
 *   import { configureExtensions } from 'a2ui-svelte/core';
 *   configureExtensions({ toolResultSurfaceEcho: 'changed' });
 * </script>
 * ```
 *
 * With no call at all the record is `ALL_EXTRAS`.
 */

/** Identifier under which all of this library's non-spec fields are namespaced. */
export const A2UI_EXTENSION_NAMESPACE = 'a2ui-svelte';

/**
 * Generic shape of an extensions container. Always a flat object keyed by
 * vendor namespace — never nested deeper than one level.
 */
export interface ExtensionEnvelope {
	[namespace: string]: unknown;
}

/** Build an `{ extensions: { [namespace]: payload } }` fragment. */
export function wrapExtension<P>(
	namespace: string,
	payload: P
): { extensions: ExtensionEnvelope } {
	return { extensions: { [namespace]: payload } };
}

/**
 * Read a namespaced payload back out of an envelope. Returns `undefined` when
 * the carrier has no `extensions` field or the requested namespace is absent.
 */
export function readExtension<T>(
	carrier: { extensions?: ExtensionEnvelope } | null | undefined,
	namespace: string
): T | undefined {
	return carrier?.extensions?.[namespace] as T | undefined;
}

/**
 * The app-wide extension record. Each field toggles one non-spec behaviour.
 * Use the `STRICT` / `ALL_EXTRAS` presets for the common cases; pass a
 * `Partial<Extensions>` to `configureExtensions` to change a single one.
 *
 * Note: these are extensions only. Knobs that are not extensions (e.g.
 * polling cadence in milliseconds) live on the consuming class directly,
 * not here.
 */
export interface Extensions {
	/**
	 * Surface-change watching — opts the app into the agent's change-delivery
	 * loop, so the `Agent` keeps the model's view of the mounted surfaces in
	 * sync with user-driven edits. How is governed by
	 * `surfaceWatchTuning.mode`: `'sync'` (default) pushes a silent A2UI v0.9
	 * data-model delta in idle windows; `'proactive'` pushes a turn-triggering
	 * `<event>SURFACE_UPDATED</event>` text message. Either way the payload is
	 * namespaced under `extensions['a2ui-svelte']`. To exclude one surface,
	 * leave it out of `definition.surfaces()` — an unchanged surface produces
	 * no diff and costs no tokens anyway.
	 */
	surfaceWatch: boolean;
	/**
	 * Batched click / update tools — registers `click_buttons({clicks: […]})`
	 * and `update_text_fields({updates: […]})` (batched variants) in addition
	 * to the single-element tools.
	 */
	batchTools: boolean;
	/**
	 * How much of the post-action surface a tool result echoes back, under the
	 * `a2ui-svelte` extension namespace. The `results` array is
	 * byte-identical in all three modes.
	 *
	 *  - `'full'` (default): every result echoes the FULL post-action state —
	 *    `updatedSurface`, `updatedContext`, `availableElementIds`. Maximally
	 *    informative, but the single biggest token amplifier on dense
	 *    surfaces: the whole tree is re-billed on every tool call.
	 *  - `'changed'`: results carry **only what changed** since the model's
	 *    last known state — `updatedSurface` only when the component STRUCTURE
	 *    changed (a delta cannot convey new structure, so that case still
	 *    sends the whole tree); `updatedDataModel`
	 *    (`{ surfaceId: { fieldId: value } }`) when field values changed; the
	 *    rest only when changed. An unchanged surface returns just
	 *    `{ results }`.
	 *  - `'none'` (STRICT): always just `{ results: [...] }` — no echo.
	 */
	toolResultSurfaceEcho: 'none' | 'full' | 'changed';
	/**
	 * On-demand pointer tool — registers `point_to_elements({ element_ids })`,
	 * a non-spec tool that makes components glow briefly and scrolls
	 * them into view so the agent can *point at* on-screen data (the user asks
	 * "where do I save this?" / "show me the total", or the agent references a
	 * value and wants to indicate it). Purely a client-side visual gesture: it
	 * mutates nothing and — unlike the click/update tools — always returns a
	 * lean result (no surface echo), so a "look here" call can't re-bill the
	 * whole surface. Off → the tool is not offered, and components only glow as
	 * a side effect of the agent editing them.
	 */
	pointerTool: boolean;
}

/** All extensions disabled — speaks the A2UI v0.8 spec verbatim. */
export const STRICT: Extensions = Object.freeze({
	surfaceWatch: false,
	batchTools: false,
	toolResultSurfaceEcho: 'none' as const,
	pointerTool: false
});

/**
 * All extensions enabled — the historical behaviour of this library.
 * Default for backwards compatibility.
 */
export const ALL_EXTRAS: Extensions = Object.freeze({
	surfaceWatch: true,
	batchTools: true,
	toolResultSurfaceEcho: 'full' as const,
	pointerTool: true
});

let current: Extensions = { ...ALL_EXTRAS };

/**
 * Set the app-wide extension record. Call it **once at startup** (a root
 * layout, or the entry module) — surfaces read it when they register their
 * tools, so a later call cannot un-register what is already live.
 *
 * The partial is merged over `ALL_EXTRAS`, not over the current record: the
 * call is an absolute set, so `configureExtensions({})` restores the defaults.
 *
 * On the server the record is module-level and therefore shared by every
 * request. That is correct — it describes the app, not the user — but it is
 * one more reason to set it at startup rather than per request.
 */
export function configureExtensions(partial: Partial<Extensions>): void {
	current = { ...ALL_EXTRAS, ...partial };
}

/** The app-wide extension record. `ALL_EXTRAS` until `configureExtensions` says otherwise. */
export function getExtensions(): Extensions {
	return current;
}
