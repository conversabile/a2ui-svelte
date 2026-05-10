/**
 * Shared BoundValue resolution helpers.
 *
 * A2UI v0.8 properties may be either literals or "BoundValues" — small
 * wrapper objects that select between four representations:
 *
 *   { literalString: 'foo' }   → 'foo'
 *   { literalNumber: 42 }      → 42
 *   { literalBoolean: true }   → true
 *   { path: '/user/name' }     → looks up the data model via JSON Pointer
 *
 * Both the dynamic-surface renderer (`Component.svelte`) and the
 * authoring helper (`defineA2uiComponent`) need to unwrap these
 * structures, so the implementation lives here.
 */

/**
 * Resolve a JSON Pointer (RFC 6901) against a data model.
 * Returns `undefined` if any segment is missing.
 */
export function resolvePath(pointer: string, data: unknown): unknown {
	if (typeof pointer !== 'string') return undefined;
	const trimmed = pointer.startsWith('/') ? pointer.slice(1) : pointer;
	if (trimmed === '') return data;
	const segments = trimmed
		.split('/')
		.map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
	let current: unknown = data;
	for (const seg of segments) {
		if (current == null || typeof current !== 'object') return undefined;
		current = (current as Record<string, unknown>)[seg];
	}
	return current;
}

/**
 * Resolve a single BoundValue to its concrete JS value.
 * Non-BoundValue inputs are returned unchanged.
 */
export function resolveBoundValue(value: unknown, data?: unknown): unknown {
	if (value == null || typeof value !== 'object') return value;
	const v = value as Record<string, unknown>;
	if ('literalString' in v) return v.literalString;
	if ('literalNumber' in v) return v.literalNumber;
	if ('literalBoolean' in v) return v.literalBoolean;
	if ('path' in v && typeof v.path === 'string') return resolvePath(v.path, data);
	return value;
}

/**
 * Recursively unwrap BoundValues in a properties object. Used by
 * `defineA2uiComponent` to derive `resolved` from the thunk's output:
 * the helper feeds `a2ui()` back through this so templates can read
 * `resolved.text` instead of `text.literalString`.
 *
 * - Plain arrays pass through (e.g. `children: ['id-a', 'id-b']`).
 * - `{ explicitList }` collapses to its array.
 * - Nested objects without a BoundValue marker recurse.
 */
export function unwrapProperties(
	props: Record<string, unknown>,
	data?: unknown
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(props)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			out[key] = value;
			continue;
		}
		if (value && typeof value === 'object') {
			const v = value as Record<string, unknown>;
			if ('literalString' in v) out[key] = v.literalString;
			else if ('literalNumber' in v) out[key] = v.literalNumber;
			else if ('literalBoolean' in v) out[key] = v.literalBoolean;
			else if ('path' in v && typeof v.path === 'string') out[key] = resolvePath(v.path, data);
			else if ('explicitList' in v) out[key] = v.explicitList;
			else out[key] = unwrapProperties(v as Record<string, unknown>, data);
		} else {
			out[key] = value;
		}
	}
	return out;
}
