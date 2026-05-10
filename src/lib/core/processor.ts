import { a2uiState } from './state.svelte';
import type { ClientMessage } from './types';

export function processMessage(message: ClientMessage) {
    if ('surfaceUpdate' in message) {
        console.log('[A2UI] Processing surfaceUpdate', message.surfaceUpdate);
        const { surfaceId, components } = message.surfaceUpdate;
        for (const comp of components) {
            // Extract the single key (component type) from 'component' wrapper
            const keys = Object.keys(comp.component);
            if (keys.length !== 1) {
                console.warn('Invalid component definition: must have exactly one type key', comp);
                continue;
            }
            const type = keys[0];
            const properties = comp.component[type];
            a2uiState.updateComponent(surfaceId, comp.id, { type, properties });
        }
    } else if ('dataModelUpdate' in message) {
        console.log('[A2UI] Processing dataModelUpdate', message.dataModelUpdate);
        const { surfaceId, path, contents } = message.dataModelUpdate;
        a2uiState.updateData(surfaceId, path, contents);
    } else if ('beginRendering' in message) {
        console.log('[A2UI] Processing beginRendering', message.beginRendering);
        const { surfaceId, root } = message.beginRendering;
        a2uiState.setRoot(surfaceId, root);
    } else if ('deleteSurface' in message) {
        console.log('[A2UI] Processing deleteSurface', message.deleteSurface);
        const { surfaceId } = message.deleteSurface;
        a2uiState.deleteSurface(surfaceId);
    }
}
