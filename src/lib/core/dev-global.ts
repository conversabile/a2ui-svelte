/**
 * A dev-only door onto the registries, reachable from outside the bundle.
 *
 * A Playwright (or any out-of-page) test cannot import `toolRegistry`, so it
 * has no way to drive the agent half of an end-to-end test. Importing this
 * module installs `window.__a2ui`, which is read-through only: every method
 * forwards to an existing registry, no new logic.
 *
 * The guard is `import.meta.env.DEV`, so a consumer's production build drops
 * the whole block. Our own `dist/` still contains it — `svelte-package`
 * transpiles per file and does not tree-shake — which is expected: the
 * consumer's bundler is what erases it.
 */

import { toolRegistry } from './registries/tool-registry';
import { mountedSurfaces, surface } from './registries/surface-index';

/** The shape of `window.__a2ui`. Exported so `page.evaluate` types resolve. */
export interface A2uiDevGlobal {
	/** Run a registered tool, e.g. `execute('click_button', { element_id })`. */
	execute(tool: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
	/** The names of every tool registered right now. */
	tools(): string[];
	/** The ids of every mounted surface, in mount order. */
	surfaces(): string[];
	/** One surface's A2UI JSON. With no id, the sole mounted surface. */
	json(id?: string): unknown;
}

declare global {
	interface Window {
		__a2ui?: A2uiDevGlobal;
	}
}

const mountedIds = () => mountedSurfaces().map((s) => s.id);

/** A list for an error message; `(none)` when nothing is mounted. */
const idList = () => mountedIds().join(', ') || '(none)';

export const devGlobal: A2uiDevGlobal = {
	execute: (tool, args = {}) => toolRegistry.execute(tool, args),
	tools: () => toolRegistry.getDeclarations().map((d) => d.name),
	surfaces: mountedIds,
	json(id) {
		// Both misses throw: a silent `undefined` inside `page.evaluate` shows
		// up as an unrelated failure three assertions later.
		if (id === undefined) {
			const all = mountedSurfaces();
			if (all.length === 1) return all[0].getJson();
			throw new Error(`__a2ui.json() needs a surface id — mounted: ${idList()}`);
		}
		const found = surface(id);
		if (!found) throw new Error(`No surface "${id}" is mounted — mounted: ${idList()}`);
		return found.getJson();
	}
};

if (import.meta.env.DEV && typeof window !== 'undefined') {
	window.__a2ui = devGlobal;
}
