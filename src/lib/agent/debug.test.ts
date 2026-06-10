import { describe, it, expect } from 'vitest';
import { AgentDebugStats, formatBytes, formatTokens } from './debug.svelte';
import type { AgentUsage } from './transport';

describe('AgentDebugStats', () => {
	it('records an outbound text payload: byte size, token estimate, and event', () => {
		const d = new AgentDebugStats();
		d.recordOutbound('system-prompt', 'x'.repeat(4000));

		const sp = d.outbound['system-prompt'];
		expect(sp.count).toBe(1);
		expect(sp.bytes).toBe(4000);
		expect(sp.lastBytes).toBe(4000);
		expect(sp.estTokens).toBe(1000); // 4000 / 4 (default charsPerToken)
		expect(d.events.at(-1)).toMatchObject({ dir: 'out', kind: 'system-prompt', bytes: 4000 });
	});

	it('stringifies a non-string payload (tool result object) before sizing', () => {
		const d = new AgentDebugStats();
		const result = { results: [{ element_id: 'a', status: 'success' }], extensions: {} };
		d.recordOutbound('tool-result', result, 'update_text_fields');

		const expectedBytes = JSON.stringify(result).length;
		expect(d.outbound['tool-result'].bytes).toBe(expectedBytes);
		expect(d.outbound['tool-result'].estTokens).toBe(Math.ceil(expectedBytes / 4));
		expect(d.events.at(-1)?.note).toBe('update_text_fields');
	});

	it('honours a custom charsPerToken', () => {
		const d = new AgentDebugStats({ charsPerToken: 3.2 });
		expect(d.estimateTokens(3200)).toBe(1000);
		expect(d.estimateTokens('abcd'.repeat(800))).toBe(1000);
	});

	it('sizes audio by decoded bytes, skips token estimate, and keeps it out of the log', () => {
		const d = new AgentDebugStats();
		// "AAAA" decodes to 3 bytes; "AAA=" to 2 bytes.
		d.recordOutbound('audio-out', 'AAAA');
		d.recordOutbound('audio-out', 'AAA=');

		expect(d.outbound['audio-out'].count).toBe(2);
		expect(d.outbound['audio-out'].bytes).toBe(5); // 3 + 2
		expect(d.outbound['audio-out'].estTokens).toBe(0); // never estimated for audio
		// Audio is high-volume: it must not flood the event log.
		expect(d.events.filter((e) => e.kind === 'audio-out')).toHaveLength(0);
	});

	it('records inbound audio bytes without logging each chunk', () => {
		const d = new AgentDebugStats();
		d.recordInboundAudio('AAAA');
		expect(d.inbound['audio-in'].bytes).toBe(3);
		expect(d.events).toHaveLength(0);
	});

	it('folds provider usage: last, peak total, report count, summed response tokens', () => {
		const d = new AgentDebugStats();
		const u1: AgentUsage = { promptTokenCount: 60000, responseTokenCount: 200, totalTokenCount: 60200 };
		const u2: AgentUsage = { promptTokenCount: 95000, responseTokenCount: 300, totalTokenCount: 95300 };
		d.recordUsage(u1);
		d.recordUsage(u2);

		expect(d.usage.last).toEqual(u2);
		expect(d.usage.peakTotal).toBe(95300);
		expect(d.usage.reports).toBe(2);
		expect(d.usage.sumResponseTokens).toBe(500);
		expect(d.inbound.usage.count).toBe(2);
		// Usage reports ARE logged (low-volume, high-signal).
		expect(d.events.at(-1)).toMatchObject({ dir: 'in', kind: 'usage' });
	});

	it('derives estOutboundTokens as the sum across text categories only', () => {
		const d = new AgentDebugStats();
		d.recordOutbound('system-prompt', 'a'.repeat(800)); // 200 tok
		d.recordOutbound('tool-result', 'b'.repeat(400)); // 100 tok
		d.recordOutbound('audio-out', 'AAAA'); // 0 tok (audio)

		expect(d.estOutboundTokens).toBe(300);
	});

	it('caps the event log at maxEvents (rolling)', () => {
		const d = new AgentDebugStats({ maxEvents: 5 });
		for (let i = 0; i < 20; i++) d.recordOutbound('text', `m${i}`);
		expect(d.events).toHaveLength(5);
		// Keeps the most recent ones.
		expect(d.events.at(-1)?.note).toBeUndefined();
		expect(d.events.map((e) => e.bytes)).toHaveLength(5);
	});

	it('reset() clears every counter, usage, and the log', () => {
		const d = new AgentDebugStats();
		d.recordOutbound('system-prompt', 'hello');
		d.recordUsage({ totalTokenCount: 100 });
		d.toolCount = 9;
		d.reset();

		expect(d.outbound['system-prompt']).toEqual({ count: 0, bytes: 0, lastBytes: 0, estTokens: 0 });
		expect(d.usage).toEqual({ last: null, peakTotal: 0, reports: 0, sumResponseTokens: 0 });
		expect(d.toolCount).toBe(0);
		expect(d.events).toHaveLength(0);
		expect(d.estOutboundTokens).toBe(0);
	});
});

describe('formatBytes / formatTokens', () => {
	it('formats byte sizes', () => {
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(2048)).toBe('2.0 KB');
		expect(formatBytes(206 * 1024)).toBe('206.0 KB');
		expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
	});

	it('formats token counts', () => {
		expect(formatTokens(640)).toBe('640');
		expect(formatTokens(52800)).toBe('52.8k');
	});
});
