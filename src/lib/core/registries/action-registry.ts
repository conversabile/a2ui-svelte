/**
 * Global Action Registry for the A2UI generic tools framework.
 *
 * Components register their interaction callbacks here, keyed by (elementId, type).
 * A component may register more than one action verb on the same element — e.g. a
 * Checkbox registers both 'click' (toggle) and 'update' (set boolean). Generic
 * tools dispatch by type:
 *   - click_button       → execute(elementId, 'click')
 *   - update_text_field  → execute(elementId, 'update', value)
 */

export type ActionType = 'click' | 'update';

interface ActionEntry {
	callback: (...args: any[]) => any;
	surfaceId: string;
}

class ActionRegistry {
	private actions: Map<string, Map<ActionType, ActionEntry>> = new Map();

	/**
	 * Register a component action callback for a specific verb.
	 * Re-registering the same (elementId, type) replaces the previous callback.
	 */
	register(elementId: string, type: ActionType, callback: (...args: any[]) => any, surfaceId: string) {
		let byType = this.actions.get(elementId);
		if (!byType) {
			byType = new Map();
			this.actions.set(elementId, byType);
		}
		byType.set(type, { callback, surfaceId });
	}

	/** Remove every action registered for this element ID. */
	unregister(elementId: string) {
		this.actions.delete(elementId);
	}

	/** Remove all actions belonging to a surface (for cleanup on navigation). */
	unregisterBySurface(surfaceId: string) {
		for (const [id, byType] of this.actions) {
			for (const [type, entry] of byType) {
				if (entry.surfaceId === surfaceId) byType.delete(type);
			}
			if (byType.size === 0) this.actions.delete(id);
		}
	}

	/**
	 * Execute an action by element ID and verb. Throws if no matching entry.
	 */
	async execute(elementId: string, type: ActionType, ...args: any[]): Promise<any> {
		const byType = this.actions.get(elementId);
		const entry = byType?.get(type);
		if (!entry) {
			const available = this.listActions();
			throw new Error(
				`No "${type}" action registered for element "${elementId}". Available IDs: ${available.join(', ') || '(none)'}`
			);
		}
		return entry.callback(...args);
	}

	/** Check if any action — or a specific verb — exists for an element. */
	has(elementId: string, type?: ActionType): boolean {
		const byType = this.actions.get(elementId);
		if (!byType) return false;
		return type ? byType.has(type) : byType.size > 0;
	}

	/** List all registered element IDs, optionally filtered by surface. */
	listActions(surfaceId?: string): string[] {
		if (!surfaceId) return Array.from(this.actions.keys());
		const ids: string[] = [];
		for (const [id, byType] of this.actions) {
			for (const entry of byType.values()) {
				if (entry.surfaceId === surfaceId) {
					ids.push(id);
					break;
				}
			}
		}
		return ids;
	}
}

export const actionRegistry = new ActionRegistry();
