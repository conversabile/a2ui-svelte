import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentTrace, formatDuration, spanDuration, toolResultStatus } from './trace.svelte';

describe('AgentTrace', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
	});
	afterEach(() => vi.useRealTimers());

	it('opens a turn with a thinking span and measures it up to the first output', () => {
		const t = new AgentTrace();
		t.startTurn(1);
		vi.advanceTimersByTime(800);
		t.modelOutput();
		vi.advanceTimersByTime(200);
		t.endTurn();

		expect(t.turns).toHaveLength(1);
		const turn = t.turns[0];
		expect(turn.index).toBe(1);
		expect(turn.spans.map((s) => s.kind)).toEqual(['thinking', 'generating']);
		expect(spanDuration(turn.spans[0])).toBe(800);
		expect(spanDuration(turn.spans[1])).toBe(200);
		expect(turn.endedAt).not.toBeNull();
	});

	it('further output chunks extend the generating span instead of opening new ones', () => {
		const t = new AgentTrace();
		t.startTurn(0);
		t.modelOutput();
		vi.advanceTimersByTime(50);
		t.modelOutput();
		vi.advanceTimersByTime(50);
		t.endTurn();

		expect(t.turns[0].spans.map((s) => s.kind)).toEqual(['thinking', 'generating']);
		expect(spanDuration(t.turns[0].spans[1])).toBe(100);
	});

	it('records a tool call: name, args, output, status, duration, bytes sent', () => {
		const t = new AgentTrace();
		t.startTurn(1);
		const span = t.toolStart('click_buttons', { element_ids: ['save-button'] });
		vi.advanceTimersByTime(300);
		t.toolEnd(span, { results: [{ element_id: 'save-button', status: 'success' }] }, 7200);
		t.modelThinking();
		vi.advanceTimersByTime(100);
		t.modelOutput();
		vi.advanceTimersByTime(100);
		t.endTurn();

		const spans = t.turns[0].spans;
		expect(spans.map((s) => s.kind)).toEqual(['thinking', 'tool', 'thinking', 'generating']);
		const tool = spans[1];
		expect(tool.name).toBe('click_buttons');
		expect(spanDuration(tool)).toBe(300);
		expect(tool.tool?.status).toBe('success');
		expect(tool.tool?.sentBytes).toBe(7200);
		expect(tool.tool?.args).toContain('save-button');
		expect(tool.tool?.output).toContain('"status": "success"');
	});

	it('marks a call failed when any element result failed', () => {
		const t = new AgentTrace();
		t.startTurn(0);
		const span = t.toolStart('click_buttons', {});
		t.toolEnd(span, {
			results: [
				{ element_id: 'a', status: 'success' },
				{ element_id: 'b', status: 'error', error: 'no such element' }
			]
		});
		expect(span?.tool?.status).toBe('error');
	});

	it('stores payloads whole by default, so the panel can copy the exact bytes', () => {
		const t = new AgentTrace();
		t.startTurn(0);
		const big = 'x'.repeat(40000);
		const span = t.toolStart('update_text_fields', { blob: big });
		t.toolEnd(span, { results: [] }, 42000, { updatedSurface: [{ blob: big }] });
		expect(span?.tool?.args).toContain(big);
		expect(span?.tool?.args).not.toContain('truncated');
		expect(span?.tool?.echo).toContain(big);
		expect(span?.tool?.echoParts[0].key).toBe('updatedSurface');
	});

	it('truncates a large payload when maxDetailChars asks it to', () => {
		const t = new AgentTrace({ maxDetailChars: 100 });
		t.startTurn(0);
		const span = t.toolStart('update_text_fields', { blob: 'x'.repeat(5000) });
		expect(span?.tool?.args.length).toBeLessThan(200);
		expect(span?.tool?.args).toContain('truncated');
	});

	it('caps the turn ring', () => {
		const t = new AgentTrace({ maxTurns: 3 });
		for (let i = 0; i < 6; i++) {
			t.startTurn(i);
			t.endTurn();
		}
		expect(t.turns).toHaveLength(3);
		expect(t.turns.map((x) => x.index)).toEqual([3, 4, 5]);
	});

	it('a still-open turn is closed when the next one starts', () => {
		const t = new AgentTrace();
		t.startTurn(0);
		vi.advanceTimersByTime(100);
		t.startTurn(2);
		expect(t.turns[0].endedAt).not.toBeNull();
		expect(t.openTurn?.index).toBe(2);
	});

	it('ensureTurn opens one only when none is running, and never moves it', () => {
		const t = new AgentTrace();
		t.ensureTurn(2);
		expect(t.turns).toHaveLength(1);
		t.ensureTurn(5);
		expect(t.turns).toHaveLength(1);
		expect(t.turns[0].index).toBe(2);
	});

	it('a user message moves the running turn below it (voice: audio beats transcription)', () => {
		const t = new AgentTrace();
		// Model audio arrives first, with an empty transcript.
		t.ensureTurn(0);
		t.modelOutput();
		// The transcription lands afterwards as transcript entry 0.
		t.noteUserMessage(1);
		expect(t.turns[0].index).toBe(1);
		// It never moves back up.
		t.noteUserMessage(0);
		expect(t.turns[0].index).toBe(1);
	});

	it('turnsAt selects the turns charted at a transcript position', () => {
		const t = new AgentTrace();
		t.startTurn(1);
		t.endTurn();
		t.startTurn(3);
		t.endTurn();
		expect(t.turnsAt(1).map((x) => x.id)).toEqual([1]);
		expect(t.turnsAt(3).map((x) => x.id)).toEqual([2]);
		expect(t.turnsAt(2)).toEqual([]);
	});

	it('records nothing when disabled', () => {
		const t = new AgentTrace({ enabled: false });
		t.startTurn(0);
		const span = t.toolStart('click_buttons', {});
		t.toolEnd(span, { status: 'error', error: 'x' });
		t.endTurn();
		expect(t.enabled).toBe(false);
		expect(t.turns).toEqual([]);
		expect(span).toBeNull();
	});

	it('reset clears the turns and the id counter', () => {
		const t = new AgentTrace();
		t.startTurn(0);
		t.endTurn();
		t.reset();
		expect(t.turns).toEqual([]);
		t.startTurn(0);
		expect(t.turns[0].id).toBe(1);
	});
});

describe('toolResultStatus', () => {
	it('reads a thrown-tool error envelope', () => {
		expect(toolResultStatus({ status: 'error', error: 'boom' })).toBe('error');
	});
	it('defaults to success for a result with no status', () => {
		expect(toolResultStatus({ ok: true })).toBe('success');
		expect(toolResultStatus(undefined)).toBe('success');
	});
});

describe('formatDuration', () => {
	it('uses ms below a second and seconds above', () => {
		expect(formatDuration(840)).toBe('840 ms');
		expect(formatDuration(2412)).toBe('2.41 s');
	});
});
