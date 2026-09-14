import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GeminiLiveModel } from './live-model';

// Mock the SDK: `new GoogleGenAI(...)` yields a client whose `live.connect`
// resolves a fake session and hands us back the callbacks, so a test can push
// arbitrary server messages through `#onMessage`. `vi.hoisted` makes the
// captured state reachable from the hoisted `vi.mock` factory.
const { captured } = vi.hoisted(() => ({
	captured: {
		callbacks: null as null | { onopen: () => void; onmessage: (m: unknown) => void },
		toolResponses: [] as unknown[]
	}
}));
vi.mock('@google/genai', () => ({
	Modality: { AUDIO: 'AUDIO' },
	GoogleGenAI: class {
		live = {
			connect: async ({ callbacks }: { callbacks: any }) => {
				captured.callbacks = callbacks;
				callbacks.onopen();
				return {
					sendToolResponse: (r: unknown) => captured.toolResponses.push(r),
					sendRealtimeInput: () => {},
					sendClientContent: () => {},
					close: () => {}
				};
			}
		};
	}
}));

beforeEach(() => {
	captured.callbacks = null;
	captured.toolResponses.length = 0;
});
afterEach(() => {
	vi.useRealTimers();
});

function listen(model: GeminiLiveModel) {
	const ev = {
		order: [] as string[],
		textOut: [] as string[],
		toolCall: [] as Array<Array<{ id: string; name: string; args: Record<string, unknown> }>>,
		turnComplete: 0,
		interrupted: 0
	};
	model.on('text-out', (p) => {
		ev.textOut.push(p.text);
		ev.order.push('text-out');
	});
	model.on('tool-call', (p) => {
		ev.toolCall.push(p.calls);
		ev.order.push('tool-call');
	});
	model.on('turn-complete', () => {
		ev.turnComplete += 1;
		ev.order.push('turn-complete');
	});
	model.on('interrupted', () => {
		ev.interrupted += 1;
		ev.order.push('interrupted');
	});
	return ev;
}

async function connected() {
	const model = new GeminiLiveModel({ token: 'k' });
	const ev = listen(model);
	await model.connect({ systemInstruction: 'sys', tools: [] });
	const send = (m: unknown) => captured.callbacks!.onmessage(m);
	return { model, ev, send };
}

const toolCall = (...names: string[]) => ({
	toolCall: { functionCalls: names.map((name, i) => ({ id: `c${i}`, name, args: {} })) }
});
const turnComplete = { serverContent: { turnComplete: true } };
const say = (text: string) => ({ serverContent: { outputTranscription: { text } } });

describe('GeminiLiveModel turn-complete normalisation', () => {
	it('forwards turn-complete for a plain turn', async () => {
		const { ev, send } = await connected();
		send(say('hi'));
		send(turnComplete);
		expect(ev.turnComplete).toBe(1);
	});

	it('suppresses the turn-complete that trails a toolCall and emits the real one after the continuation', async () => {
		const { model, ev, send } = await connected();

		send(toolCall('click_button'));
		send(turnComplete); // mid-loop — the model has not seen the result yet
		expect(ev.turnComplete).toBe(0);

		model.sendToolResult('c0', 'click_button', { status: 'success' });
		expect(ev.turnComplete).toBe(0);

		send(say('done'));
		send(turnComplete);
		expect(ev.turnComplete).toBe(1);
		expect(ev.order).toEqual(['tool-call', 'text-out', 'turn-complete']);
	});

	it('waits for every result of a batch, including calls split across messages', async () => {
		const { model, ev, send } = await connected();

		send(toolCall('click_button', 'update_text_field'));
		send(toolCall('click_button'));
		send(turnComplete);

		model.sendToolResult('c0', 'click_button', {});
		model.sendToolResult('c1', 'update_text_field', {});
		send(turnComplete);
		expect(ev.turnComplete).toBe(0);

		model.sendToolResult('c0', 'click_button', {});
		send(turnComplete);
		expect(ev.turnComplete).toBe(1);
		expect(captured.toolResponses).toHaveLength(3);
	});

	it('synthesises a turn-complete if no continuation arrives after the last result', async () => {
		vi.useFakeTimers();
		const { model, ev, send } = await connected();

		send(toolCall('click_button'));
		send(turnComplete);
		model.sendToolResult('c0', 'click_button', {});

		vi.advanceTimersByTime(1499);
		expect(ev.turnComplete).toBe(0);
		vi.advanceTimersByTime(1);
		expect(ev.turnComplete).toBe(1);
	});

	it('does not double-emit when the continuation beats the fallback', async () => {
		vi.useFakeTimers();
		const { model, ev, send } = await connected();

		send(toolCall('click_button'));
		model.sendToolResult('c0', 'click_button', {});
		send(turnComplete);
		vi.advanceTimersByTime(5000);
		expect(ev.turnComplete).toBe(1);
	});

	it('does not fire the fallback after close()', async () => {
		vi.useFakeTimers();
		const { model, ev, send } = await connected();

		send(toolCall('click_button'));
		model.sendToolResult('c0', 'click_button', {});
		model.close();
		vi.advanceTimersByTime(5000);
		expect(ev.turnComplete).toBe(0);
	});

	it('drops the outstanding loop on barge-in', async () => {
		vi.useFakeTimers();
		const { ev, send } = await connected();

		send(toolCall('click_button'));
		send({ serverContent: { interrupted: true } });
		expect(ev.interrupted).toBe(1);

		// The counter is clear, so the next end-of-turn is forwarded normally.
		send(turnComplete);
		expect(ev.turnComplete).toBe(1);
		vi.advanceTimersByTime(5000);
		expect(ev.turnComplete).toBe(1);
	});
});
