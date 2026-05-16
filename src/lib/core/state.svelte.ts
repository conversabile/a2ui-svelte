import type { SurfaceState as ISurfaceState, ComponentDefinition } from './types';

// Data entry shape from the A2UI v0.8 `dataModelUpdate` message.
// `contents` is an adjacency list — each entry has a key and exactly one
// typed value (`valueString`, `valueNumber`, `valueBoolean`, or `valueMap`,
// where `valueMap` recursively contains more entries to build nested objects).
interface DataEntry {
    key: string;
    valueString?: string;
    valueNumber?: number;
    valueBoolean?: boolean;
    valueMap?: DataEntry[];
}

/**
 * Convert a v0.8 A2UI `contents` adjacency list into a plain JSON object.
 * `valueMap` entries are recursively converted so the renderer can bind to
 * regular JS paths like `/user/name`.
 */
function entriesToObject(entries: DataEntry[]): Record<string, any> {
    const out: Record<string, any> = {};
    if (!Array.isArray(entries)) return out;
    for (const entry of entries) {
        if (!entry || typeof entry.key !== 'string') continue;
        if (entry.valueString !== undefined) out[entry.key] = entry.valueString;
        else if (entry.valueNumber !== undefined) out[entry.key] = entry.valueNumber;
        else if (entry.valueBoolean !== undefined) out[entry.key] = entry.valueBoolean;
        else if (entry.valueMap !== undefined) out[entry.key] = entriesToObject(entry.valueMap);
    }
    return out;
}

/**
 * Parse a JSON Pointer (RFC 6901) into path segments.
 * Leading `/` is optional and tolerated. Empty strings yield no segments
 * (i.e. the root). Escaped sequences `~1` → `/`, `~0` → `~` are decoded.
 */
function parseJsonPointer(pointer: string): string[] {
    if (!pointer) return [];
    const trimmed = pointer.startsWith('/') ? pointer.slice(1) : pointer;
    if (trimmed === '') return [];
    return trimmed.split('/').map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
}

// Define a reactive Surface class to properly use $state
class Surface implements ISurfaceState {
    id: string;
    rootId = $state<string | null>(null);
    components = $state<Record<string, ComponentDefinition>>({});
    data = $state<Record<string, any>>({});
    isRendering = $state(false);

    constructor(id: string) {
        this.id = id;
    }
}

class A2UIStateManager {
    // Using a plain object for surfaces to ensure maximum reactivity compatibility
    surfaces = $state<Record<string, Surface>>({});

    getSurface(surfaceId: string): Surface | undefined {
        return this.surfaces[surfaceId];
    }

    // helper to get or create
    getOrCreateSurface(surfaceId: string): Surface {
        if (!this.surfaces[surfaceId]) {
            console.log(`[A2UI] Creating new surface: ${surfaceId}`);
            this.surfaces[surfaceId] = new Surface(surfaceId);
        }
        return this.surfaces[surfaceId]!;
    }

    deleteSurface(surfaceId: string) {
        console.log(`[A2UI] Deleting surface: ${surfaceId}`);
        delete this.surfaces[surfaceId];
    }

    updateComponent(surfaceId: string, componentId: string, definition: ComponentDefinition) {
        const surface = this.getOrCreateSurface(surfaceId);
        // Using object assignment for reactivity
        surface.components[componentId] = definition;
        console.log(`[A2UI] Updated component "${componentId}" on surface "${surfaceId}"`, definition);
    }

    setRoot(surfaceId: string, rootId: string) {
        console.log(`[A2UI] Setting root for ${surfaceId} to ${rootId}`);
        const surface = this.getOrCreateSurface(surfaceId);
        surface.rootId = rootId;
        surface.isRendering = true;
    }

    updateData(
        surfaceId: string,
        path: string | undefined,
        contents: DataEntry[]
    ) {
        const surface = this.getOrCreateSurface(surfaceId);

        // Convert adjacency-list contents into a plain JSON object.
        const patch = entriesToObject(contents);

        if (path == null) {
            // Per A2UI v0.8: when `path` is omitted, `contents` replaces the
            // entire data model for the surface. An explicit empty string or
            // "/" is treated as "root" and still merges so siblings survive.
            surface.data = patch;
        } else {
            // Navigate/create the target location using JSON-Pointer semantics
            // (RFC 6901). Accepts both "/a/b" and "a/b" / "a.b" shorthand.
            const segments = parseJsonPointer(path);
            let targetObj: any = surface.data;
            for (const seg of segments) {
                if (targetObj[seg] == null || typeof targetObj[seg] !== 'object') {
                    targetObj[seg] = {};
                }
                targetObj = targetObj[seg];
            }
            // Merge the patch at the target location so sibling keys survive.
            for (const [k, v] of Object.entries(patch)) {
                targetObj[k] = v;
            }
        }

        console.log(`[A2UI] Updated data for ${surfaceId}`, surface.data);
    }

    /**
     * Write a single value at a JSON-Pointer location in a surface's data
     * model. Used by the dynamic-surface renderer to push user input back
     * into the data model so components bound via `{ path }` stay in sync
     * with what the user typed (and so the surface JSON sent to the agent
     * reflects the current UI state).
     *
     * Intermediate objects are created as needed. A root pointer (`''` or
     * `'/'`) is a no-op because a leaf value can't replace the root map.
     */
    setDataAtPath(surfaceId: string, pointer: string, value: unknown) {
        const surface = this.getOrCreateSurface(surfaceId);
        const segments = parseJsonPointer(pointer);
        if (segments.length === 0) return;
        const last = segments.pop()!;
        let target: any = surface.data;
        for (const seg of segments) {
            if (target[seg] == null || typeof target[seg] !== 'object') {
                target[seg] = {};
            }
            target = target[seg];
        }
        target[last] = value;
    }
}

export const a2uiState = new A2UIStateManager();
