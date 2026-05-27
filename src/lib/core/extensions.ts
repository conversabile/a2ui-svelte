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
 * # Where extension feature flags live
 *
 * `ExtensionOptions` is a **per-surface** record. Each `<StaticSurface>` /
 * `<DynamicSurface>` resolves its own copy from (in order):
 *
 *   1. its `options={...}` prop, then
 *   2. the Svelte context set under `A2UI_EXTENSIONS_CONTEXT_KEY` at the
 *      integration root (host-wide default), then
 *   3. the `ALL_EXTRAS` preset.
 *
 * The resolved record is exported on each surface as `extensions`, so when
 * the host publishes the surface handle the `VoiceAgent` sees the same
 * record and decides what to do for that surface. **`VoiceAgent` never owns
 * an extension feature flag.**
 */

/** Identifier under which all of this library's non-spec fields are namespaced. */
export const A2UI_EXTENSION_NAMESPACE = 'a2ui-svelte';

/**
 * Svelte context key under which a host can set a default
 * `Partial<ExtensionOptions>` once at the integration root. Every
 * `<StaticSurface>` / `<DynamicSurface>` mounted in that subtree picks it up
 * unless it overrides via its own `options` prop.
 */
export const A2UI_EXTENSIONS_CONTEXT_KEY = 'a2ui:extensions';

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
 * Per-surface feature flags. Each flag toggles one non-spec behaviour on
 * the surface that carries it. Use the `STRICT` / `ALL_EXTRAS` presets for
 * the common cases; pass `Partial<ExtensionOptions>` to flip a single
 * flag.
 *
 * Note: these are flags only. Knobs that are not feature flags (e.g.
 * polling cadence in milliseconds) live on the consuming class directly,
 * not here.
 */
export interface ExtensionOptions {
	/**
	 * Surface-change polling — opts the surface into the agent's polling
	 * loop. When `true`, the `VoiceAgent` diffs this surface's JSON /
	 * context instructions on a fixed cadence and emits a namespaced
	 * `<event>SURFACE_UPDATED</event>` text message when they change.
	 */
	surfaceWatch: boolean;
	/**
	 * Batched click / update tools — the surface registers
	 * `click_button({clicks: […]})` and `update_text_field({updates: […]})`
	 * (batched variants) in addition to the spec-canonical single-element
	 * tools. (Wired up in B3.)
	 */
	batchTools: boolean;
	/**
	 * Tool-result envelope — the surface's tool results include
	 * `updatedSurface`, `updatedContext`, and `availableElementIds` under
	 * the `a2ui-svelte` extension namespace. With this off, results are
	 * just `{ results: [...] }`. (Wired up in B4.)
	 */
	toolResultExtras: boolean;
}

/** All extensions disabled — speaks the A2UI v0.8 spec verbatim. */
export const STRICT: ExtensionOptions = Object.freeze({
	surfaceWatch: false,
	batchTools: false,
	toolResultExtras: false
});

/**
 * All extensions enabled — the historical behaviour of this library.
 * Default for backwards compatibility.
 */
export const ALL_EXTRAS: ExtensionOptions = Object.freeze({
	surfaceWatch: true,
	batchTools: true,
	toolResultExtras: true
});

/**
 * Resolve a partial extension-options bag into the full record, falling back
 * to `ALL_EXTRAS` for any key the caller omitted.
 */
export function resolveExtensionOptions(
	partial: Partial<ExtensionOptions> | undefined
): ExtensionOptions {
	if (!partial) return { ...ALL_EXTRAS };
	return { ...ALL_EXTRAS, ...partial };
}
