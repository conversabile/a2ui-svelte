/**
 * A2UI Agent Interaction Highlight
 *
 * Applies a brief glow effect to components the AI agent interacts with.
 * Handles scroll-into-view for off-screen elements, with batched visible
 * glows followed by sequential scroll-and-glow for off-screen ones.
 *
 * Components must set `data-a2ui-id={_componentId}` on their root DOM element.
 */

const GLOW_DURATION_MS = 1000;
const SCROLL_SETTLE_MS = 400;
const SCROLL_GAP_MS = 1000; // pause after glowing before scrolling to the next element

let enabled = true;

/** Enable or disable agent interaction highlighting. */
export function setHighlightEnabled(value: boolean): void {
	enabled = value;
}

/** Query whether highlighting is currently enabled. */
export function isHighlightEnabled(): boolean {
	return enabled;
}

function findElement(elementId: string): HTMLElement | null {
	return document.querySelector<HTMLElement>(`[data-a2ui-id="${CSS.escape(elementId)}"]`);
}

function isInViewport(el: HTMLElement): boolean {
	const rect = el.getBoundingClientRect();
	return (
		rect.top >= 0 &&
		rect.left >= 0 &&
		rect.bottom <= window.innerHeight &&
		rect.right <= window.innerWidth
	);
}

function applyGlow(el: HTMLElement): void {
	// Restart animation if already glowing
	el.removeAttribute('data-a2ui-glow');
	void el.offsetWidth;
	el.setAttribute('data-a2ui-glow', '');

	setTimeout(() => {
		el.removeAttribute('data-a2ui-glow');
	}, GLOW_DURATION_MS);
}

/**
 * Highlight one or more A2UI components by element ID.
 * Fire-and-forget: does not block the caller.
 *
 * 1. Glow all currently-visible elements simultaneously
 * 2. For each off-screen element, scroll into view then glow
 *    (also glows any other pending elements that became visible after the scroll)
 */
export function highlightElements(elementIds: string[]): void {
	if (!enabled) return;
	_highlightAsync(elementIds);
}

async function _highlightAsync(elementIds: string[]): Promise<void> {
	const entries: Array<{ id: string; el: HTMLElement }> = [];
	for (const id of elementIds) {
		const el = findElement(id);
		if (el) entries.push({ id, el });
	}

	if (entries.length === 0) return;

	const glowed = new Set<string>();

	// Phase 1: glow all currently-visible elements
	for (const entry of entries) {
		if (isInViewport(entry.el)) {
			applyGlow(entry.el);
			glowed.add(entry.id);
		}
	}

	// Phase 2: scroll to off-screen elements sequentially.
	// Always pause before each scroll so the user can see the previous glow
	// (whether it came from Phase 1 visible elements or a prior scroll).
	let pauseBeforeScroll = glowed.size > 0;
	for (const entry of entries) {
		if (glowed.has(entry.id)) continue;

		if (pauseBeforeScroll) {
			await new Promise((r) => setTimeout(r, SCROLL_GAP_MS));
		}
		pauseBeforeScroll = true; // always pause before subsequent scrolls

		entry.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
		await new Promise((r) => setTimeout(r, SCROLL_SETTLE_MS));

		// Glow all pending elements that are now in the viewport
		for (const e of entries) {
			if (!glowed.has(e.id) && isInViewport(e.el)) {
				applyGlow(e.el);
				glowed.add(e.id);
			}
		}
	}
}
