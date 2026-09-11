export * from './types';
export { a2uiState } from './state.svelte';
export { processMessage, type ProcessResult } from './processor';
export { serializeSurface } from './serializer';
export {
    validateSurface,
    formatSurfaceIssues,
    STANDARD_CATALOG_TYPES,
    type SurfaceValidationIssue,
    type SurfaceIssueSeverity,
    type SurfaceIssueScope,
    type ValidateSurfaceOptions
} from './validate-surface';
export {
    SurfaceRegistry,
    setSurfaceContext,
    getSurfaceContext,
    setParentId,
    getParentId
} from './surface-registry';
export { toolRegistry, type ToolDefinition } from './registries/tool-registry';
export { actionRegistry, type ActionType } from './registries/action-registry';
export {
    mountedSurfaces,
    surface,
    registerSurface,
    unregisterSurface,
    mountedStaticSurfaceCount,
    type AgentSurface
} from './registries/surface-index';
export { userActionBus, type UserAction, type UserActionListener } from './registries/event-bus';
export { highlightElements, setHighlightEnabled, isHighlightEnabled } from './highlight';
export { revealElements } from './reveal';
export { createApiTool, type ApiToolConfig } from './api-bridge';
export { resolveBoundValue, resolvePath, unwrapProperties } from './bound-value';
export {
    A2UI_EXTENSION_NAMESPACE,
    wrapExtension,
    readExtension,
    configureExtensions,
    getExtensions,
    STRICT,
    ALL_EXTRAS,
    type ExtensionEnvelope,
    type Extensions
} from './extensions';
export {
    STANDARD_CATALOG_ID,
    STANDARD_CATALOG_ALIAS,
    getClientCapabilities,
    getAgentCardExtensionParams,
    type A2UIClientCapabilities,
    type CatalogDescription,
    type AgentCardExtensionParams
} from './catalog-selection';
export {
    getClientDataModel,
    type A2UIClientDataModel
} from './client-data-model';
export {
    stripDataModel,
    structuralFingerprint,
    readDataModelFromJson,
    readDataModelsBySurface,
    diffDataModel,
    diffDataModelsBySurface
} from './surface-snapshot';
export { devGlobal, type A2uiDevGlobal } from './dev-global';
