/**
 * Global index of the surfaces currently mounted on the page.
 *
 * `<StaticSurface>` / `<DynamicSurface>` add themselves on mount and remove
 * themselves on destroy, so an app never has to keep its own list just to
 * answer `AgentDefinition.surfaces()` — `surfaces: mountedSurfaces` is the
 * whole wiring. Like the tool and action registries, this is module-global:
 * one page, one set of live surfaces.
 */

/**
 * The handle a surface exposes to an `Agent` — what `<StaticSurface>` and
 * `<DynamicSurface>` export, and the contract a hand-rolled surface must meet.
 */
export interface AgentSurface {
	id: string;
	type: 'static' | 'dynamic';
	getJson(): unknown;
	/**
	 * The surface's **data model** — a flat `{ fieldId → value }` map of the
	 * values the user (or agent) has entered, decoupled from the component
	 * tree. This is the unit of `'sync'`-mode delivery (A2UI v0.9
	 * `sendDataModel`): only changed entries are pushed to the agent, so a
	 * keystroke costs tens of bytes instead of the whole tree.
	 *
	 * `<StaticSurface>` / `<DynamicSurface>` implement this from their
	 * registry / data-model state. When a handle omits it, the agent derives
	 * the map from `getJson()` (the static `dataModel` array or the dynamic
	 * `data` object) — so pre-existing hand-rolled handles keep working.
	 */
	getDataModel?(): Record<string, unknown>;
}

/** Insertion-ordered, so `mountedSurfaces()` reads top-to-bottom on the page. */
const surfaces = new Map<string, AgentSurface>();

/**
 * Add a surface to the index. Mount-time only — never at module scope, or the
 * entry survives the server render that created it.
 *
 * Two live surfaces with the same id already break agent targeting (the id is
 * how the agent names things), so a duplicate warns and the newcomer wins.
 */
export function registerSurface(surface: AgentSurface): void {
	if (surfaces.has(surface.id)) {
		console.warn(
			`[a2ui] Two surfaces are mounted with id "${surface.id}". ` +
				'The agent cannot tell them apart — give each surface its own id.'
		);
	}
	surfaces.set(surface.id, surface);
}

/**
 * Remove a surface from the index. Only removes the given handle, so a
 * duplicate id unmounting does not evict the surface that replaced it.
 */
export function unregisterSurface(surface: AgentSurface): void {
	if (surfaces.get(surface.id) === surface) surfaces.delete(surface.id);
}

/** Every surface mounted right now, in mount order. */
export function mountedSurfaces(): AgentSurface[] {
	return [...surfaces.values()];
}

/** One mounted surface by id, or `undefined` if nothing with that id is up. */
export function surface(id: string): AgentSurface | undefined {
	return surfaces.get(id);
}

/**
 * How many **static** surfaces are mounted. The generic tools
 * (`click_button`, `update_text_field`) only make sense while at least one
 * static surface is up, so this count is what decides whether they are live.
 */
export function mountedStaticSurfaceCount(): number {
	let n = 0;
	for (const s of surfaces.values()) if (s.type === 'static') n++;
	return n;
}
