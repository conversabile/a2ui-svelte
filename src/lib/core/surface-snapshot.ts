/**
 * Diff helpers for serialized surface JSON.
 *
 * `snapshotSurfaces` + `diffSurfaces` are what the `Agent` uses: a per-surface,
 * per-component diff whose payload stays proportional to the change, whatever
 * moved — a data-model value, a `Text` literal, a `disabled` flag.
 *
 * The structure-vs-value helpers (`structuralFingerprint`,
 * `diffDataModelsBySurface`) answer the narrower "did anything but a value
 * move?", which is too coarse to size a payload by but still the right question
 * for value-independent equality. Exported and unchanged.
 */

/**
 * Strip data-model *values* from a serialised surface, leaving only its
 * structure. A static surface carries values in a `dataModel` array
 * (`[{ key, valueString }]`); a dynamic surface in a `data` object. Removing
 * both yields a value-independent structural view, so a change here means the
 * structure itself changed (navigation, a component appearing) rather than a
 * mere value edit.
 */
export function stripDataModel(json: unknown): unknown {
	if (json && typeof json === 'object' && !Array.isArray(json)) {
		const { dataModel: _dataModel, data: _data, ...rest } = json as Record<string, unknown>;
		return rest;
	}
	return json;
}

/**
 * Value-independent fingerprint of one-or-many serialized surfaces. Two
 * fingerprints compare equal iff no component appeared, disappeared, or
 * changed its inline definition — data-model values are excluded.
 */
export function structuralFingerprint(surfaces: unknown): string {
	const list = Array.isArray(surfaces) ? surfaces : [surfaces];
	return JSON.stringify(list.map((s) => stripDataModel(s)));
}

/**
 * Derive a surface's flat `{ fieldId → value }` data model from its serialized
 * JSON — the static `dataModel` array (`[{ key, valueString }]`) or the
 * dynamic `data` object. Returns `{}` when neither is present.
 */
export function readDataModelFromJson(json: unknown): Record<string, unknown> {
	if (json && typeof json === 'object') {
		const obj = json as Record<string, unknown>;
		if (Array.isArray(obj.dataModel)) {
			const out: Record<string, unknown> = {};
			for (const entry of obj.dataModel as Array<{ key?: unknown; valueString?: unknown }>) {
				if (entry && typeof entry.key === 'string') out[entry.key] = entry.valueString;
			}
			return out;
		}
		if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) {
			return { ...(obj.data as Record<string, unknown>) };
		}
	}
	return {};
}

/**
 * Per-surface data models from one-or-many serialized surfaces, keyed by each
 * surface's `surfaceId` (falling back to the array index for hand-rolled
 * shapes without one). Surfaces with an empty data model are omitted.
 */
export function readDataModelsBySurface(
	surfaces: unknown
): Record<string, Record<string, unknown>> {
	const list = Array.isArray(surfaces) ? surfaces : [surfaces];
	const out: Record<string, Record<string, unknown>> = {};
	list.forEach((s, i) => {
		const model = readDataModelFromJson(s);
		if (Object.keys(model).length === 0) return;
		const id =
			s && typeof s === 'object' && typeof (s as Record<string, unknown>).surfaceId === 'string'
				? ((s as Record<string, unknown>).surfaceId as string)
				: String(i);
		out[id] = model;
	});
	return out;
}

/**
 * Changed `{ fieldId → value }` entries of `next` vs `prev` (latest wins). A
 * field cleared in `next` surfaces as its new (empty) value; fields absent
 * from `next` entirely are not reported — a removed field is a *structural*
 * change and is caught by the structural fingerprint instead.
 */
export function diffDataModel(
	prev: Record<string, unknown>,
	next: Record<string, unknown>
): Record<string, unknown> {
	const delta: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(next)) {
		if (JSON.stringify(prev[key]) !== JSON.stringify(value)) delta[key] = value;
	}
	return delta;
}

/**
 * Per-surface `diffDataModel` across two `readDataModelsBySurface` snapshots.
 * Only surfaces with at least one changed entry appear in the result.
 */
export function diffDataModelsBySurface(
	prev: Record<string, Record<string, unknown>>,
	next: Record<string, Record<string, unknown>>
): Record<string, Record<string, unknown>> {
	const out: Record<string, Record<string, unknown>> = {};
	for (const [id, model] of Object.entries(next)) {
		const delta = diffDataModel(prev[id] ?? {}, model);
		if (Object.keys(delta).length > 0) out[id] = delta;
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-component surface diff
// ─────────────────────────────────────────────────────────────────────────────
//
// A serialized surface's `components` is a flat list keyed by `id`, so two
// snapshots compare entry by entry and only the entries that differ go on the
// wire. Upsert-by-id is A2UI's own update semantic (`surfaceUpdate` applies its
// `components` one id at a time and never clears the rest — see
// `processor.ts`); only removal has no spec verb, which is why the delta
// travels namespaced.

/** One serialized surface reduced to the form the component diff compares. */
export interface SurfaceSnapshot {
	surfaceId: string;
	rootId?: unknown;
	/** `componentId → serialized component definition`. */
	components: Map<string, string>;
	dataModel: Record<string, unknown>;
	/** The surface as serialized, kept so a full re-sync needs no re-read. */
	json: unknown;
}

/** What changed in one surface since the reader's last known state. */
export interface SurfaceDeltaEntry {
	surfaceId: string;
	/**
	 * Set when the delta would have cost about as much as the tree itself (a
	 * route change, a first mount): `surface` then replaces everything the reader
	 * knows about this id, and `changed` / `removed` are absent.
	 */
	full?: true;
	/** Present iff `full` — the whole surface, same shape as at session start. */
	surface?: unknown;
	/** Present iff it changed. */
	rootId?: unknown;
	/** Components to upsert by id — both newly added and modified ones. */
	changed?: Array<{ id: string; component: unknown }>;
	/** Component ids that are no longer on the surface. */
	removed?: string[];
	/** Changed `{ fieldId → value }` entries only. */
	dataModel?: Record<string, unknown>;
}

export interface SurfaceDelta {
	/** Only surfaces with at least one change. An untouched surface is absent. */
	surfaces: SurfaceDeltaEntry[];
	/** Surface ids that unmounted (navigation). Omitted when none did. */
	removedSurfaces?: string[];
	/**
	 * True when a component or a whole surface appeared or disappeared, rather
	 * than only changing in place. Scheduling information for the caller, not
	 * content — the `Agent` uses it to skip the settle window — so it is
	 * deliberately kept off the wire.
	 */
	structural: boolean;
}

/**
 * Share of a surface's own serialized size past which a delta stops being worth
 * sending: at that point the full tree is both smaller than delta-plus-removals
 * and unambiguous for the reader, so `full` is set instead.
 */
export const FULL_RESYNC_RATIO = 0.6;

/** `componentId → serialized definition` from a serialized surface. */
function readComponents(json: unknown): Map<string, string> {
	const out = new Map<string, string>();
	const list = (json as Record<string, unknown> | null)?.components;
	if (!Array.isArray(list)) return out;
	for (const entry of list) {
		if (!entry || typeof entry !== 'object') continue;
		const { id, component } = entry as { id?: unknown; component?: unknown };
		if (typeof id !== 'string') continue;
		out.set(id, JSON.stringify(component ?? null));
	}
	return out;
}

/**
 * Snapshot one serialized surface. `id` overrides the JSON's own `surfaceId`
 * (callers holding a surface handle know the id authoritatively); `dataModel`
 * overrides the model derived from the JSON, for handles that expose their
 * values through a `getDataModel()` instead of inside the serialized tree.
 */
export function snapshotSurface(
	json: unknown,
	id?: string,
	dataModel?: Record<string, unknown>
): SurfaceSnapshot {
	const obj = (json ?? {}) as Record<string, unknown>;
	const surfaceId =
		id ?? (typeof obj.surfaceId === 'string' ? (obj.surfaceId as string) : '0');
	return {
		surfaceId,
		rootId: obj.rootId,
		components: readComponents(json),
		dataModel: dataModel ?? readDataModelFromJson(json),
		json
	};
}

/**
 * Snapshot one-or-many serialized surfaces, keyed by `surfaceId` (falling back
 * to the array index for hand-rolled shapes without one — the same fallback
 * `readDataModelsBySurface` uses, so the two stay aligned).
 */
export function snapshotSurfaces(surfaces: unknown): Map<string, SurfaceSnapshot> {
	const list = Array.isArray(surfaces) ? surfaces : [surfaces];
	const out = new Map<string, SurfaceSnapshot>();
	list.forEach((json, i) => {
		const obj = (json ?? {}) as Record<string, unknown>;
		const id = typeof obj.surfaceId === 'string' ? (obj.surfaceId as string) : String(i);
		out.set(id, snapshotSurface(json, id));
	});
	return out;
}

/**
 * Change-detection fingerprint of a snapshot map — equal strings mean nothing
 * moved. Cheaper to keep than the map for settle/debounce tracking, where only
 * equality matters.
 */
export function snapshotFingerprint(snapshots: Map<string, SurfaceSnapshot>): string {
	return JSON.stringify(
		Array.from(snapshots.values()).map((s) => [
			s.surfaceId,
			s.rootId,
			Array.from(s.components.entries()),
			s.dataModel
		])
	);
}

function byteLength(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}

/**
 * What changed between two snapshot maps, per surface and per component.
 * Returns `null` when nothing changed at all — the caller then sends nothing.
 *
 * A surface absent from `prev` is delivered whole (`full`), because a delta has
 * nothing to merge onto. A surface absent from `next` is reported in
 * `removedSurfaces` and nothing else. A surface whose delta would cost at least
 * `fullResyncRatio` of its own serialized size is also delivered whole.
 */
export function diffSurfaces(
	prev: Map<string, SurfaceSnapshot>,
	next: Map<string, SurfaceSnapshot>,
	fullResyncRatio: number = FULL_RESYNC_RATIO
): SurfaceDelta | null {
	const surfaces: SurfaceDeltaEntry[] = [];
	let structural = false;

	for (const [surfaceId, cur] of next) {
		const before = prev.get(surfaceId);
		if (!before) {
			// Nothing to merge onto — the reader has never seen this surface.
			surfaces.push({ surfaceId, full: true, surface: cur.json });
			structural = true;
			continue;
		}

		const changed: Array<{ id: string; component: unknown }> = [];
		for (const [id, serialized] of cur.components) {
			const previous = before.components.get(id);
			if (previous === serialized) continue;
			if (previous === undefined) structural = true;
			changed.push({ id, component: JSON.parse(serialized) });
		}
		const removed: string[] = [];
		for (const id of before.components.keys()) {
			if (!cur.components.has(id)) removed.push(id);
		}
		if (removed.length > 0) structural = true;

		const dataModel = diffDataModel(before.dataModel, cur.dataModel);
		const rootChanged = JSON.stringify(before.rootId) !== JSON.stringify(cur.rootId);
		const hasDataChange = Object.keys(dataModel).length > 0;
		if (changed.length === 0 && removed.length === 0 && !rootChanged && !hasDataChange) continue;

		// Past the threshold the delta stops paying for itself — send the tree.
		const deltaBytes = byteLength(changed) + byteLength(removed);
		if (deltaBytes >= byteLength(cur.json) * fullResyncRatio) {
			surfaces.push({ surfaceId, full: true, surface: cur.json });
			structural = true;
			continue;
		}

		const delta: SurfaceDeltaEntry = { surfaceId };
		if (rootChanged) delta.rootId = cur.rootId;
		if (changed.length > 0) delta.changed = changed;
		if (removed.length > 0) delta.removed = removed;
		if (hasDataChange) delta.dataModel = dataModel;
		surfaces.push(delta);
	}

	const removedSurfaces: string[] = [];
	for (const surfaceId of prev.keys()) {
		if (!next.has(surfaceId)) removedSurfaces.push(surfaceId);
	}
	if (removedSurfaces.length > 0) structural = true;

	if (surfaces.length === 0 && removedSurfaces.length === 0) return null;
	return {
		surfaces,
		...(removedSurfaces.length > 0 ? { removedSurfaces } : {}),
		structural
	};
}
