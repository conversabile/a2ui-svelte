/**
 * A2UI Auto-Reveal
 *
 * Ensures agent-targeted elements are visible before the glow animation plays.
 * Walks up the DOM from each element; for every enclosing Tabs ancestor
 * (tagged with `data-a2ui-tabs-root`) we dispatch `a2ui:reveal` so the Tabs
 * component switches to the tab panel containing the target.
 *
 * Paired panels must carry `data-a2ui-tab-panel-index="{i}"` on the panel element
 * and `data-a2ui-id="{id}"` on the target component's root.
 */

export function revealElements(elementIds: string[]): void {
	for (const id of elementIds) {
		const el = document.querySelector<HTMLElement>(`[data-a2ui-id="${CSS.escape(id)}"]`);
		if (!el) continue;

		let cursor: HTMLElement | null = el;
		while (cursor) {
			const panel: HTMLElement | null = cursor.closest('[data-a2ui-tab-panel-index]');
			if (!panel) break;
			const parent: HTMLElement | null = panel.parentElement;
			const tabsRoot: HTMLElement | null = parent ? parent.closest('[data-a2ui-tabs-root]') : null;
			if (!tabsRoot) break;
			const idx = Number(panel.getAttribute('data-a2ui-tab-panel-index'));
			tabsRoot.dispatchEvent(new CustomEvent('a2ui:reveal', { detail: { index: idx } }));
			cursor = tabsRoot.parentElement;
		}
	}
}
