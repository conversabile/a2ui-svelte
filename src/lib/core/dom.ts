/**
 * A2UI DOM Compatibility
 *
 * Small guards for the browser APIs the highlight / reveal helpers need but
 * that non-browser DOMs (jsdom, happy-dom, SSR shims) don't always provide.
 * Without them a component test crashes the moment the agent points at or
 * updates an element — so these run everywhere, not just in tests.
 */

/**
 * Escape `value` for interpolation into a `[attr="…"]` selector.
 *
 * Uses `CSS.escape` when the environment has it; jsdom doesn't. The fallback
 * escapes `\` and `"` — the two characters that would otherwise terminate or
 * corrupt the quoted attribute value — so we never emit a malformed selector.
 * Don't "simplify" this back to a bare `CSS.escape`.
 */
export function escapeAttrValue(value: string): string {
	const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
	if (typeof css?.escape === 'function') return css.escape(value);
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
