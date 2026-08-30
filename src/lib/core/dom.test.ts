import { describe, it, expect, afterEach, vi } from 'vitest';
import { escapeAttrValue } from './dom';
import { highlightElements } from './highlight';
import { revealElements } from './reveal';

// jsdom provides neither `CSS.escape` nor `Element.prototype.scrollIntoView`
// (asserted below) — so this file's default state *is* the non-browser DOM
// the guards exist for. Nothing is stubbed on purpose.

function mount(id: string): HTMLElement {
	const el = document.createElement('div');
	el.setAttribute('data-a2ui-id', id);
	document.body.appendChild(el);
	return el;
}

afterEach(() => {
	document.body.innerHTML = '';
	delete (globalThis as Record<string, unknown>).CSS;
	vi.useRealTimers();
});

describe('escapeAttrValue', () => {
	it('confirms the environment really lacks the browser APIs', () => {
		expect((globalThis as Record<string, unknown>).CSS).toBeUndefined();
		expect((Element.prototype as { scrollIntoView?: unknown }).scrollIntoView).toBeUndefined();
	});

	it('escapes the characters that would break out of a quoted attribute value', () => {
		expect(escapeAttrValue('a"b')).toBe('a\\"b');
		expect(escapeAttrValue('a\\b')).toBe('a\\\\b');
		expect(escapeAttrValue('a\\"b')).toBe('a\\\\\\"b');
		expect(escapeAttrValue('plain-id')).toBe('plain-id');
	});

	it('delegates to CSS.escape when the environment has it', () => {
		const escape = vi.fn((s: string) => `<${s}>`);
		(globalThis as Record<string, unknown>).CSS = { escape };
		expect(escapeAttrValue('x')).toBe('<x>');
		expect(escape).toHaveBeenCalledWith('x');
	});
});

describe('highlightElements without CSS.escape', () => {
	it('resolves ids and does not throw', () => {
		mount('plain-id');
		expect(highlightElements(['plain-id', 'missing-id'])).toEqual(['plain-id']);
	});

	it('resolves an id containing a quote and a backslash', () => {
		mount('odd"id\\x');
		expect(highlightElements(['odd"id\\x'])).toEqual(['odd"id\\x']);
	});
});

describe('revealElements without CSS.escape', () => {
	it('does not throw for present, absent or oddly-named ids', () => {
		mount('plain-id');
		mount('odd"id\\x');
		expect(() => revealElements(['plain-id', 'odd"id\\x', 'missing-id'])).not.toThrow();
	});
});

describe('highlightElements without scrollIntoView', () => {
	it('completes the off-screen scroll phase and still glows the element', async () => {
		vi.useFakeTimers();
		const el = mount('off-screen');

		// jsdom reports an all-zero rect, which reads as "in viewport" — force the
		// off-screen branch for the first check, then let the element come into view
		// as a real scroll would.
		let offScreen = true;
		el.getBoundingClientRect = () =>
			({
				top: offScreen ? -500 : 0,
				left: 0,
				bottom: offScreen ? -400 : 10,
				right: 10
			}) as DOMRect;

		highlightElements(['off-screen']);
		offScreen = false;

		// Past `scrollIntoView` and its settle delay: a throw here would have
		// stopped the glow.
		await vi.advanceTimersByTimeAsync(500);
		expect(el.hasAttribute('data-a2ui-glow')).toBe(true);
	});
});
