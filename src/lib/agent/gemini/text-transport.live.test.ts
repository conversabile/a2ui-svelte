import { describe, it, expect, vi } from 'vitest';
import { GeminiTextTransport } from './text-transport';

/**
 * Live smoke test against a real Gemini text model. Hermetic by default —
 * it only runs when explicitly opted in:
 *
 *   A2UI_LIVE_GEMINI=1 GEMINI_API_KEY=… pnpm test transport.live
 *
 * Without both env vars it is skipped, so CI never hits the network.
 */
const RUN = process.env.A2UI_LIVE_GEMINI === '1' && !!process.env.GEMINI_API_KEY;

(RUN ? describe : describe.skip)('GeminiTextTransport (live)', () => {
	it('streams a short reply and completes a turn against a real model', async () => {
		const transport = new GeminiTextTransport({
			apiKey: process.env.GEMINI_API_KEY as string,
			model: process.env.A2UI_LIVE_GEMINI_MODEL
		});
		const out: string[] = [];
		let done = false;
		const errors: string[] = [];
		transport.on('text-out', (p) => out.push(p.text));
		transport.on('turn-complete', () => (done = true));
		transport.on('error', (e) => errors.push(e.message));

		await transport.connect({
			systemInstruction: 'You are a terse assistant. Answer with a single word.',
			tools: []
		});
		transport.sendText('Reply with the single word: ready');

		await vi.waitFor(() => expect(done).toBe(true), { timeout: 30_000, interval: 200 });
		expect(errors).toEqual([]);
		expect(out.join('').toLowerCase()).toContain('ready');

		transport.close();
	}, 35_000);
});
