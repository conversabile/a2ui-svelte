import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import TurnTimeline from './TurnTimeline.svelte';
import { AgentTrace } from './trace.svelte';

/** A finished turn: one wait, one tool call with a big echo, one reply. */
function turnWithTool(echoBlob = 'y'.repeat(9000)) {
	const t = new AgentTrace();
	t.startTurn(1);
	const span = t.toolStart('update_text_fields', {
		updates: [{ element_id: 'staff-department-giulia-bianchi', value: 'bar' }]
	});
	t.toolEnd(
		span,
		{ results: [{ element_id: 'staff-department-giulia-bianchi', status: 'success' }] },
		32100,
		{ updatedSurface: [{ blob: echoBlob }], updatedContext: 'page context' }
	);
	t.modelOutput();
	t.endTurn();
	return t.turns[0];
}

describe('TurnTimeline', () => {
	let written: string[];

	beforeEach(() => {
		written = [];
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: {
				writeText: vi.fn(async (text: string) => {
					written.push(text);
				})
			}
		});
	});

	it('reports the echo by key and size next to the tool result', () => {
		const { container } = render(TurnTimeline, { turn: turnWithTool() });
		const labels = [...container.querySelectorAll('.kv')].map((el) => el.textContent);

		expect(labels.some((l) => l?.includes('output · success'))).toBe(true);
		// The key that dominates the payload leads, with its own size.
		expect(labels.some((l) => l?.startsWith('surface echo · updatedSurface'))).toBe(true);
		expect(labels.some((l) => l?.includes('updatedContext'))).toBe(true);
		expect(labels.some((l) => l?.includes('31.3 KB sent to the model'))).toBe(true);
	});

	it('copies the full payload — not the visible, scrolled-off part', async () => {
		const blob = 'y'.repeat(9000);
		const { container } = render(TurnTimeline, { turn: turnWithTool(blob) });
		const buttons = container.querySelectorAll('.copy');
		// input, output, echo.
		expect(buttons).toHaveLength(3);

		await fireEvent.click(buttons[2]);
		expect(written).toHaveLength(1);
		expect(written[0]).toContain(blob);
		expect(written[0]).not.toContain('truncated');
		expect(JSON.parse(written[0]).updatedSurface[0].blob).toBe(blob);
	});

	it('confirms the copy on the button that was pressed', async () => {
		const { container } = render(TurnTimeline, { turn: turnWithTool() });
		const button = container.querySelectorAll('.copy')[0] as HTMLButtonElement;
		expect(button.getAttribute('aria-label')).toBe('Copy to clipboard');

		await fireEvent.click(button);
		expect(button.getAttribute('aria-label')).toBe('Copied');
		expect(container.querySelectorAll('.copy.done')).toHaveLength(1);
	});
});
