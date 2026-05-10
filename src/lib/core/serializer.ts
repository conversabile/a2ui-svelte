import { a2uiState } from './state.svelte';

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
    const components = Object.entries(surface.components).map(([id, def]) => ({
        id,
        component: { [def.type]: def.properties }
    }));

    return {
        surfaceId,
        rootId: surface.rootId,
        components,
        data: { ...surface.data }
    };
}
