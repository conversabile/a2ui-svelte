import { a2uiState } from './state.svelte';
import { reachableComponents } from './validate-surface';

/**
 * Serializes a surface's current state back into the A2UI JSON format
 * that was used to create it (surfaceUpdate message shape).
 *
 * This is useful for including the current UI definition in an LLM system prompt
 * so the model knows what the surface currently looks like.
 */
export function serializeSurface(surfaceId: string): object | null {
    const surface = a2uiState.getSurface(surfaceId);
    if (!surface) return null;

    // Re-wrap each stored ComponentDefinition back into { [type]: properties }
    const buffered = Object.entries(surface.components).map(([id, def]) => ({
        id,
        component: { [def.type]: def.properties }
    }));
    // Once rendering, emit only what is on screen: components the agent
    // detached stay in the buffer (v0.8 has no per-component delete) but are
    // not rendered, so the agent must not see them either (screen/tree parity).
    const components = reachableComponents(buffered, surface.rootId);

    return {
        surfaceId,
        rootId: surface.rootId,
        components,
        data: { ...surface.data }
    };
}
