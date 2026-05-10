import { setContext, getContext } from 'svelte';
import { toolRegistry, type ToolDefinition } from './registries/tool-registry';

const SURFACE_KEY = Symbol('a2ui-surface');
const PARENT_KEY = Symbol('a2ui-parent');

/**
 * Registry that collects A2UI component definitions from Svelte components
 * that self-register via context. Used by static Surfaces to produce
 * the A2UI JSON representation of natively-rendered components.
 */
export class SurfaceRegistry {
    surfaceId: string;
    private components: Array<{ id: string; component: Record<string, any> }> = [];
    private childrenByParent: Map<string, string[]> = new Map();
    private counter = 0;
    /** Tool names registered by components in this surface */
    private registeredToolNames: string[] = [];
    private dataSources: Map<string, () => any> = new Map();

    constructor(surfaceId: string) {
        this.surfaceId = surfaceId;
    }

    registerData(key: string, accessor: () => any) {
        this.dataSources.set(key, accessor);
    }

    unregisterData(key: string) {
        this.dataSources.delete(key);
    }

    /**
     * Unregister a component by ID.
     * Removes from component list, parent-child mappings, and data sources.
     */
    unregister(id: string) {
        this.components = this.components.filter(c => c.id !== id);
        // Remove as child from any parent
        for (const children of this.childrenByParent.values()) {
            const idx = children.indexOf(id);
            if (idx !== -1) {
                children.splice(idx, 1);
                break;
            }
        }
        // Remove own children mapping
        this.childrenByParent.delete(id);
    }

    generateId(type: string): string {
        return `${type.toLowerCase()}-${++this.counter}`;
    }

    /**
     * Register a component definition.
     * @param parentId - The parent component ID, or null for referenced components
     *   (e.g. a Button's label Text, which is referenced via `child` but not in a Column's explicitList)
     */
    register(id: string, parentId: string | null, definition: Record<string, any>) {
        // Upsert: update if existing, append if new
        const existingIdx = this.components.findIndex(c => c.id === id);
        if (existingIdx !== -1) {
            this.components[existingIdx].component = definition;
        } else {
            this.components.push({ id, component: definition });
        }
        if (parentId !== null) {
            if (!this.childrenByParent.has(parentId)) {
                this.childrenByParent.set(parentId, []);
            }
            const children = this.childrenByParent.get(parentId)!;
            if (!children.includes(id)) {
                children.push(id);
            }
        }
    }

    /**
     * Register a tool provided by a component in this surface.
     * Delegates to the global ToolRegistry.
     */
    registerTool(tool: ToolDefinition) {
        toolRegistry.register(tool);
        this.registeredToolNames.push(tool.name);
    }

    /**
     * Returns the Gemini-format function declarations for tools
     * registered by components in this surface.
     */
    getTools(): Array<{ name: string; description: string; parameters: Record<string, any> }> {
        return toolRegistry.getDeclarations().filter((d) => this.registeredToolNames.includes(d.name));
    }

    toJSON(): object {
        const result: Array<{ id: string; component: Record<string, any> }> = [];

        // Synthetic root Column wrapping top-level children
        const rootChildren = this.childrenByParent.get('root') || [];
        result.push({
            id: 'root',
            component: { Column: { children: { explicitList: rootChildren } } }
        });

        for (const comp of this.components) {
            const clone = JSON.parse(JSON.stringify(comp));
            const type = Object.keys(clone.component)[0];
            if (type === 'Column' || type === 'Row' || type === 'List') {
                const children = this.childrenByParent.get(comp.id) || [];
                clone.component[type].children = { explicitList: children };
            } else if (type === 'Card') {
                // Per A2UI spec, Card has a single `child` slot.
                const children = this.childrenByParent.get(comp.id) || [];
                if (children.length === 1) {
                    clone.component.Card.child = children[0];
                } else {
                    delete clone.component.Card.child;
                }
            } else if (type === 'Tabs') {
                // Per A2UI spec, Tabs.tabItems is an array of { title, child }.
                // Tabs.svelte registers tabItems with titles only; pair them here with
                // the children registered under this Tabs (order = tab order).
                const children = this.childrenByParent.get(comp.id) || [];
                const items: Array<{ title: any; child?: string }> = clone.component.Tabs.tabItems ?? [];
                clone.component.Tabs.tabItems = items
                    .map((item, i) => ({ title: item.title, child: children[i] }))
                    .filter((it) => typeof it.child === 'string');
            }
            result.push(clone);
        }

        const dataModel: Array<{ key: string; valueString: string }> = [];
        for (const [key, accessor] of this.dataSources.entries()) {
            const val = accessor();
            if (val !== undefined && val !== null) {
                dataModel.push({ key, valueString: String(val) });
            }
        }

        return {
            surfaceId: this.surfaceId,
            rootId: 'root',
            components: result,
            ...(dataModel.length > 0 ? { dataModel } : {})
        };
    }
}

export function setSurfaceContext(registry: SurfaceRegistry) {
    setContext(SURFACE_KEY, registry);
}

export function getSurfaceContext(): SurfaceRegistry | undefined {
    return getContext<SurfaceRegistry | undefined>(SURFACE_KEY);
}

export function setParentId(parentId: string) {
    setContext(PARENT_KEY, parentId);
}

export function getParentId(): string {
    return getContext<string | undefined>(PARENT_KEY) ?? 'root';
}
