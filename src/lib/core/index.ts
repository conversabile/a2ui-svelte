export * from './types';
export { a2uiState } from './state.svelte';
export { processMessage } from './processor';
export { serializeSurface } from './serializer';
export {
    SurfaceRegistry,
    setSurfaceContext,
    getSurfaceContext,
    setParentId,
    getParentId
} from './surface-registry';
export { toolRegistry, type ToolDefinition } from './registries/tool-registry';
export { actionRegistry, type ActionType } from './registries/action-registry';
export { userActionBus, type UserAction, type UserActionListener } from './registries/event-bus';
export { highlightElements, setHighlightEnabled, isHighlightEnabled } from './highlight';
export { revealElements } from './reveal';
export { createApiTool, type ApiToolConfig } from './api-bridge';
export { resolveBoundValue, resolvePath, unwrapProperties } from './bound-value';
