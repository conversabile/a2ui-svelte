export interface BeginRendering {
    beginRendering: {
        surfaceId: string;
        root: string;
        catalogId?: string;
        styles?: object;
    };
}

export interface SurfaceUpdate {
    surfaceUpdate: {
        surfaceId: string;
        components: Array<{
            id: string;
            component: Record<string, any>; // Component definitions (e.g., { Text: { ... } })
        }>;
    };
}

export interface DataModelUpdate {
    dataModelUpdate: {
        surfaceId: string;
        path?: string;
        contents: Array<{
            key: string;
            valueString?: string;
            valueNumber?: number;
            valueBoolean?: boolean;
            valueMap?: Array<any>;
        }>;
    };
}

export interface DeleteSurface {
    deleteSurface: {
        surfaceId: string;
    };
}

export type ClientMessage = BeginRendering | SurfaceUpdate | DataModelUpdate | DeleteSurface;

export interface ComponentDefinition {
    type: string;
    properties: Record<string, any>;
}

export interface SurfaceState {
    id: string;
    rootId: string | null;
    components: Record<string, ComponentDefinition>;
    data: Record<string, any>;
    isRendering: boolean;
}
