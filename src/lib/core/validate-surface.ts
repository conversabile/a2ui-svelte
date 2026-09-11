/**
 * Structural validator for serialized A2UI surfaces — the `getJson()` shape
 * (`{ surfaceId, rootId, components, … }`).
 *
 * One JSON shape, two sources: a static surface (our serializer's output from
 * the author's Svelte components) and a dynamic one (the tree the model
 * pushed). A failure means our serializer is wrong in the first case and the
 * model emitted a non-compliant tree in the second — so the callers report it
 * differently (throw vs. reject the update), but the checks are the same.
 *
 * Nothing here can be switched off. Every issue carries a `severity` — a
 * broken tree the agent will misread vs. a convention we recommend — and a
 * `scope`, and callers filter on those.
 */

/**
 * Component types of the v0.8 standard catalog, as this library renders them.
 *
 * Kept here rather than derived from `DEFAULT_CATALOG` so `core` never has to
 * import the Svelte components (that would drag all 16 into every headless
 * consumer). `default-catalog.test.ts` asserts the two agree, so they can't
 * drift.
 */
export const STANDARD_CATALOG_TYPES: ReadonlySet<string> = new Set([
	'Text',
	'Image',
	'Icon',
	'Divider',
	'Button',
	'TextField',
	'CheckBox',
	'Slider',
	'DateTimeInput',
	'MultipleChoice',
	'Row',
	'Column',
	'List',
	'Card',
	'Modal',
	'Tabs'
]);

/**
 * `error` — the agent misreads the tree, or a human sees something the agent
 * can't target. `warning` — legal, but a documented source of agent
 * hallucinations (host conventions, custom catalogs).
 */
export type SurfaceIssueSeverity = 'error' | 'warning';

/**
 * Which question the check answers:
 *
 * - `shape` — "is this component well-formed?" Answerable about one component
 *   in isolation, so it holds on a half-sent tree.
 * - `wiring` — "do the parts fit together?" (a root exists, every referenced
 *   id resolves, everything hangs off the root). Only meaningful once the
 *   tree claims to be complete: a dynamic surface is built by a
 *   `surfaceUpdate` that carries the components and a later `beginRendering`
 *   that names the root, so wiring is checked from `beginRendering` on.
 */
export type SurfaceIssueScope = 'shape' | 'wiring';

export interface SurfaceValidationIssue {
	/** Offending component id, or null for surface-level issues. */
	componentId: string | null;
	message: string;
	severity: SurfaceIssueSeverity;
	scope: SurfaceIssueScope;
}

export interface ValidateSurfaceOptions {
	/**
	 * Component types that count as known. Defaults to the v0.8 standard
	 * catalog; pass a custom catalog's keys so its own types don't warn.
	 */
	catalog?: ReadonlySet<string>;
}

interface SerializedComponent {
	id: string;
	component: Record<string, Record<string, unknown>>;
}

const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validate one serialized surface. Returns every issue found — an empty array
 * means the surface is compliant. Filter by `severity` / `scope`; there are no
 * options to turn a check off.
 */
export function validateSurface(
	json: unknown,
	options: ValidateSurfaceOptions = {}
): SurfaceValidationIssue[] {
	const { catalog = STANDARD_CATALOG_TYPES } = options;
	const issues: SurfaceValidationIssue[] = [];
	const err = (componentId: string | null, message: string, scope: SurfaceIssueScope = 'shape') =>
		issues.push({ componentId, message, severity: 'error', scope });
	const warn = (componentId: string | null, message: string, scope: SurfaceIssueScope = 'shape') =>
		issues.push({ componentId, message, severity: 'warning', scope });

	if (typeof json !== 'object' || json === null) {
		err(null, 'surface JSON is not an object');
		return issues;
	}
	const surface = json as { surfaceId?: unknown; rootId?: unknown; components?: unknown };
	if (typeof surface.surfaceId !== 'string' || !surface.surfaceId) {
		err(null, 'missing surfaceId');
	}
	if (typeof surface.rootId !== 'string' || !surface.rootId) {
		err(null, 'missing rootId', 'wiring');
	}
	if (!Array.isArray(surface.components)) {
		err(null, 'components is not an array');
		return issues;
	}

	// ---- Index components, checking uniqueness and single-type envelopes ----
	const byId = new Map<string, SerializedComponent>();
	for (const raw of surface.components) {
		const comp = raw as SerializedComponent;
		if (typeof comp?.id !== 'string' || !comp.id) {
			err(null, `component with missing id: ${JSON.stringify(raw).slice(0, 80)}`);
			continue;
		}
		if (byId.has(comp.id)) {
			err(comp.id, 'duplicate component id');
			continue;
		}
		if (typeof comp.component !== 'object' || comp.component === null) {
			err(comp.id, 'component envelope is not an object');
			continue;
		}
		const types = Object.keys(comp.component);
		if (types.length !== 1) {
			err(comp.id, `component envelope must have exactly one type key, got [${types.join(', ')}]`);
			continue;
		}
		byId.set(comp.id, comp);
	}

	const rootId = typeof surface.rootId === 'string' ? surface.rootId : null;
	if (rootId && !byId.has(rootId)) {
		err(null, `rootId "${rootId}" does not reference a component`, 'wiring');
	}

	// ---- Per-component contract checks ----
	const childRefs = new Map<string, string[]>(); // parent id -> referenced child ids
	for (const comp of byId.values()) {
		const type = Object.keys(comp.component)[0];
		const props = comp.component[type] ?? {};
		const refs: string[] = [];

		if (!catalog.has(type)) {
			warn(comp.id, `unknown component type "${type}" (not in catalog)`);
		}
		if (!KEBAB_ID.test(comp.id)) {
			warn(comp.id, 'id is not kebab-case');
		}

		switch (type) {
			case 'Row':
			case 'Column':
			case 'List': {
				const children = props.children as
					| { explicitList?: unknown; template?: unknown }
					| undefined;
				if (children == null) {
					err(comp.id, `${type} has no children property`);
				} else if (children.explicitList !== undefined) {
					if (!Array.isArray(children.explicitList)) {
						err(comp.id, `${type}.children.explicitList is not an array`);
					} else {
						for (const c of children.explicitList) {
							if (typeof c !== 'string') err(comp.id, `${type} child reference is not a string id`);
							else refs.push(c);
						}
					}
				} else if (children.template === undefined) {
					err(comp.id, `${type}.children has neither explicitList nor template`);
				}
				break;
			}
			case 'Card': {
				// An empty slot is a warning, not an error: a Card whose content is
				// conditional is empty on its first render, and taking the page
				// down for that is worse than the gap it reports. A slot that
				// points at the wrong kind of value is still an error.
				if (props.child === undefined) {
					warn(comp.id, 'Card has no `child` (an empty Card shows nothing)');
				} else if (typeof props.child !== 'string') {
					err(comp.id, 'Card must have a single string `child` (wrap multiples in a Column/Row)');
				} else {
					refs.push(props.child);
				}
				break;
			}
			case 'Button': {
				if (props.child === undefined) {
					warn(comp.id, 'Button has no `child` (its label Text node)');
				} else if (typeof props.child !== 'string') {
					err(comp.id, 'Button must have a single string `child` (its label Text node)');
				} else {
					refs.push(props.child);
				}
				// No `action.name === id` check: on our own trees the serializer
				// synthesises the name from the id (Rule 3, pinned by
				// Button.test.ts), and on an agent's tree the spec lets the model
				// name its actions freely — the `userAction` we emit carries the
				// name and the source component id both.
				break;
			}
			case 'Modal': {
				for (const slot of ['entryPointChild', 'contentChild'] as const) {
					const ref = props[slot];
					if (typeof ref === 'string') refs.push(ref);
				}
				break;
			}
			case 'Tabs': {
				const items = props.tabItems;
				if (Array.isArray(items)) {
					for (const item of items) {
						const child = (item as { child?: unknown })?.child;
						if (typeof child === 'string') refs.push(child);
					}
				}
				break;
			}
		}

		childRefs.set(comp.id, refs);
		for (const ref of refs) {
			if (!byId.has(ref)) {
				err(comp.id, `references missing component "${ref}"`, 'wiring');
			}
		}
	}

	// ---- Reachability: every component must hang off the root ----
	// An unreachable component is in the tree the agent reads but not on the
	// user's screen — a screen/tree parity violation (Rule 4).
	if (rootId && byId.has(rootId)) {
		const reachable = new Set<string>();
		const queue = [rootId];
		while (queue.length > 0) {
			const id = queue.pop()!;
			if (reachable.has(id)) continue;
			reachable.add(id);
			for (const ref of childRefs.get(id) ?? []) {
				if (byId.has(ref)) queue.push(ref);
			}
		}
		for (const id of byId.keys()) {
			if (!reachable.has(id)) {
				err(id, 'component is not reachable from the root (orphan)', 'wiring');
			}
		}
	}

	return issues;
}

/** One readable line per issue, for a console message or a thrown error. */
export function formatSurfaceIssues(issues: SurfaceValidationIssue[]): string {
	return issues
		.map((i) => `  - [${i.componentId ?? 'surface'}] ${i.message}`)
		.join('\n');
}
