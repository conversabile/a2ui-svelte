import { a2uiState } from './state.svelte';
import type { ClientMessage } from './types';
import {
    validateSurface,
    formatSurfaceIssues,
    type SurfaceValidationIssue
} from './validate-surface';

/**
 * What a processed message did. The three A2UI messages an agent can call as
 * tools (`surfaceUpdate`, `beginRendering`, `dataModelUpdate`) return this
 * straight to the model, so a rejected update tells it what to fix instead of
 * reporting a success that never happened.
 */
export interface ProcessResult {
    status: 'success' | 'error';
    error?: string;
    issues?: SurfaceValidationIssue[];
}

const OK: ProcessResult = { status: 'success' };

/**
 * The tree a message would produce if committed: what the surface holds now,
 * minus anything this message replaces, plus what it carries. Validating this
 * (rather than the committed state) is what lets a bad update be rejected with
 * the previous tree left standing.
 *
 * `incoming` is passed through unchecked so a malformed payload reaches the
 * validator and is reported, not thrown.
 */
function prospectiveJson(surfaceId: string, incoming: unknown, rootId?: string): unknown {
    const surface = a2uiState.getSurface(surfaceId);
    const list = Array.isArray(incoming) ? (incoming as Array<{ id?: unknown }>) : null;
    const replaced = new Set(list?.map((c) => c?.id));
    const kept = Object.entries(surface?.components ?? {})
        .filter(([id]) => !replaced.has(id))
        .map(([id, def]) => ({ id, component: { [def.type]: def.properties } }));
    return {
        surfaceId,
        rootId: rootId ?? surface?.rootId ?? undefined,
        components: list ? [...kept, ...list] : incoming
    };
}

/**
 * Check a candidate tree and report what applies.
 *
 * `complete` says whether the tree claims to be finished. A dynamic surface is
 * built in two steps — `surfaceUpdate` carries the components, `beginRendering`
 * names the root — so until the root is in, only `shape` issues mean anything:
 * a half-sent tree has no root and dangling children by construction, and
 * failing it would reject every legitimate render.
 */
function check(surfaceId: string, candidate: unknown, complete: boolean): ProcessResult {
    const catalog = a2uiState.getSurface(surfaceId)?.catalogTypes;
    const issues = validateSurface(candidate, catalog ? { catalog } : {}).filter(
        (i) => complete || i.scope === 'shape'
    );
    const errors = issues.filter((i) => i.severity === 'error');
    const warnings = issues.filter((i) => i.severity === 'warning');
    if (warnings.length > 0) {
        console.warn(
            `[A2UI] Surface "${surfaceId}" — ${warnings.length} validation warning(s):\n${formatSurfaceIssues(warnings)}`
        );
    }
    if (errors.length === 0) return OK;
    return {
        status: 'error',
        error: `rejected: ${errors.length} validation error(s) — the surface is unchanged`,
        issues: errors
    };
}

export function processMessage(message: ClientMessage): ProcessResult {
    if ('surfaceUpdate' in message) {
        console.log('[A2UI] Processing surfaceUpdate', message.surfaceUpdate);
        const { surfaceId, components } = message.surfaceUpdate;
        const surface = a2uiState.getSurface(surfaceId);
        const result = check(
            surfaceId,
            prospectiveJson(surfaceId, components),
            surface?.rootId != null
        );
        if (result.status === 'error') {
            console.error(`[A2UI] surfaceUpdate ${result.error}\n${formatSurfaceIssues(result.issues!)}`);
            return result;
        }
        for (const comp of components) {
            const type = Object.keys(comp.component)[0];
            a2uiState.updateComponent(surfaceId, comp.id, { type, properties: comp.component[type] });
        }
        return OK;
    } else if ('dataModelUpdate' in message) {
        console.log('[A2UI] Processing dataModelUpdate', message.dataModelUpdate);
        const { surfaceId, path, contents } = message.dataModelUpdate;
        a2uiState.updateData(surfaceId, path, contents);
        return OK;
    } else if ('beginRendering' in message) {
        console.log('[A2UI] Processing beginRendering', message.beginRendering);
        const { surfaceId, root, catalogId } = message.beginRendering;
        // The root arriving is the tree claiming to be complete, so this is
        // where the wiring checks first bite.
        const result = check(surfaceId, prospectiveJson(surfaceId, [], root), true);
        if (result.status === 'error') {
            console.error(
                `[A2UI] beginRendering ${result.error}\n${formatSurfaceIssues(result.issues!)}`
            );
            return result;
        }
        if (catalogId) a2uiState.setCatalogId(surfaceId, catalogId);
        a2uiState.setRoot(surfaceId, root);
        return OK;
    } else if ('deleteSurface' in message) {
        console.log('[A2UI] Processing deleteSurface', message.deleteSurface);
        const { surfaceId } = message.deleteSurface;
        a2uiState.deleteSurface(surfaceId);
        return OK;
    }
    return { status: 'error', error: 'unrecognized A2UI message' };
}
