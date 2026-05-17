/**
 * A2UI v0.8 client → agent event bus.
 *
 * When a user interacts with a dynamic-surface component that carries an
 * `action` definition (e.g. a Button click), the renderer must construct a
 * `userAction` payload — resolving any data bindings inside `action.context`
 * against the surface data model — and forward it to the agent as an event.
 *
 * This module provides a tiny pub/sub so Svelte components can emit these
 * events without knowing anything about the transport layer (GeminiLive
 * subscribes and forwards them into the live session).
 *
 * Spec refs:
 * - docs/a2ui/concepts/data-flow.md (§ "User clicks …")
 * - docs/a2ui/guides/renderer-development.md (§ "Client-to-Server Communication")
 */

export interface UserAction {
    /** The action name declared on the component (e.g. "submit_form"). */
    name: string;
    /** The surface that originated the interaction. */
    surfaceId: string;
    /**
     * The ID of the component that triggered the action. Named
     * `sourceComponentId` to match the A2UI v0.8 `userAction` event schema.
     */
    sourceComponentId: string;
    /** ISO-8601 timestamp of when the interaction occurred (spec-mandated). */
    timestamp: string;
    /**
     * Resolved context payload — map of key → value, where every BoundValue
     * in the original `action.context` has already been resolved against the
     * surface's data model.
     */
    context: Record<string, unknown>;
}

export type UserActionListener = (action: UserAction) => void;

class UserActionBus {
    private listeners = new Set<UserActionListener>();

    /** Register a listener; returns an unsubscribe function. */
    subscribe(listener: UserActionListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Dispatch a userAction to all subscribers. */
    emit(action: UserAction): void {
        console.log('[A2UI] userAction emitted:', action);
        for (const l of this.listeners) {
            try {
                l(action);
            } catch (err) {
                console.error('[A2UI] userAction listener threw:', err);
            }
        }
    }
}

export const userActionBus = new UserActionBus();
