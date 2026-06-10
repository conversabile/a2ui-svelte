/**
 * Structure-vs-value helpers for serialized surface JSON.
 *
 * A serialized surface mixes two kinds of state: the component **structure**
 * (the tree the model must know to target elements) and the **data model**
 * (the `{ fieldId → value }` values the user/agent typed). Telling them apart
 * is what keeps context delivery cheap: a value edit ships as a tiny delta,
 * and only a structural change forces re-sending the tree.
 *
 * Used by the `Agent`'s surface-watch loop (`'sync'` mode) and by
 * `<StaticSurface>`'s `'diff'` tool-result mode, so both speak the exact same
 * notion of "structure changed".
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
