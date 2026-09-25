import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GeminiLiveModel } from './live-model';

// Mock the SDK: `new GoogleGenAI(...)` yields a client whose `live.connect`
// resolves a fake session and hands us back the callbacks, so a test can push
// arbitrary server messages through `#onMessage`. `vi.hoisted` makes the
// captured state reachable from the hoisted `vi.mock` factory.
const { captured } = vi.hoisted(() => ({
	captured: {
		callbacks: null as null | { onopen: () => void; onmessage: (m: unknown) => void },
		connectArgs: null as null | { model: string; config: any },
		toolResponses: [] as unknown[]
	}
}));
vi.mock('@google/genai', () => ({
	Modality: { AUDIO: 'AUDIO' },
	GoogleGenAI: class {
		live = {
			connect: async (args: { model: string; config: any; callbacks: any }) => {
				const { callbacks } = args;
				captured.connectArgs = args;
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
	captured.connectArgs = null;
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

	it('keeps the turn open while the continuation is still streaming', async () => {
		vi.useFakeTimers();
		const { model, ev, send } = await connected();

		send(toolCall('point_to_elements'));
		send(turnComplete);
		model.sendToolResult('c0', 'point_to_elements', {});

		// The model resumes speaking mid-sentence and keeps going past the
		// window: each chunk restarts it, so the answer is never split.
		for (let i = 0; i < 5; i++) {
			vi.advanceTimersByTime(1000);
			send(say(`chunk${i} `));
		}
		expect(ev.turnComplete).toBe(0);

		send(turnComplete);
		expect(ev.turnComplete).toBe(1);
		expect(ev.textOut).toHaveLength(5);
	});

	it('still synthesises a turn-complete once the continuation goes silent', async () => {
		vi.useFakeTimers();
		const { model, ev, send } = await connected();

		send(toolCall('click_button'));
		model.sendToolResult('c0', 'click_button', {});
		vi.advanceTimersByTime(1000);
		send(say('done'));

		vi.advanceTimersByTime(1499);
		expect(ev.turnComplete).toBe(0);
		vi.advanceTimersByTime(1);
		expect(ev.turnComplete).toBe(1);
	});

	it('does not arm the fallback on content outside a tool loop', async () => {
		vi.useFakeTimers();
		const { ev, send } = await connected();

		send(say('hello'));
		vi.advanceTimersByTime(5000);
		expect(ev.turnComplete).toBe(0);
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

	it('drops the server\'s late copy of a turn the fallback already reported', async () => {
		vi.useFakeTimers();
		const { model, ev, send } = await connected();

		send(toolCall('click_button'));
		model.sendToolResult('c0', 'click_button', {});
		vi.advanceTimersByTime(1500);
		expect(ev.turnComplete).toBe(1);

		// The real one finally turns up. Forwarding it would tell the Agent a
		// second turn had ended and settle the next awaited `send()` early.
		send(turnComplete);
		expect(ev.turnComplete).toBe(1);

		// A genuinely new turn still ends normally.
		send(say('anything else?'));
		send(turnComplete);
		expect(ev.turnComplete).toBe(2);
	});

	it('forwards the turn-complete of a typed turn the model answered with nothing', async () => {
		const { model, ev, send } = await connected();

		model.sendText('hi');
		send(turnComplete);
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

describe('GeminiLiveModel thinking configuration', () => {
	const EXTENDED = 'gemini-3.8-live-extended-thinking';
	const tools = [{ name: 'click_button', description: 'Clicks', parameters: { type: 'object' } }];

	async function setup(opts: Partial<ConstructorParameters<typeof GeminiLiveModel>[0]> = {}) {
		const model = new GeminiLiveModel({ token: 'k', ...opts });
		await model.connect({ systemInstruction: 'sys', tools });
		return captured.connectArgs!;
	}

	it('sends no thinking config on a non-thinking model', async () => {
		const { config } = await setup();
		expect(config.thinkingConfig).toBeUndefined();
		expect(config.tools[0].functionDeclarations[0].behavior).toBeUndefined();
	});

	it('defaults the extended-thinking model to the low level', async () => {
		const { model, config } = await setup({ model: EXTENDED });
		expect(model).toBe(EXTENDED);
		expect(config.thinkingConfig).toEqual({ thinkingLevel: 'low' });
	});

	it('uses the level the caller asked for', async () => {
		const { config } = await setup({ model: EXTENDED, thinkingLevel: 'high' });
		expect(config.thinkingConfig).toEqual({ thinkingLevel: 'high' });
	});

	it('sends an explicit level on any model id', async () => {
		const { config } = await setup({ thinkingLevel: 'medium' });
		expect(config.thinkingConfig).toEqual({ thinkingLevel: 'medium' });
	});

	it('declares every tool NON_BLOCKING when thinking is on, without mutating the input', async () => {
		const { config } = await setup({ model: EXTENDED });
		expect(config.tools[0].functionDeclarations).toEqual([
			{ ...tools[0], behavior: 'NON_BLOCKING' }
		]);
		expect(tools[0]).not.toHaveProperty('behavior');
	});

	it('omits the tools config entirely when there are no tools', async () => {
		const model = new GeminiLiveModel({ token: 'k', model: EXTENDED });
		await model.connect({ systemInstruction: 'sys', tools: [] });
		expect(captured.connectArgs!.config.tools).toBeUndefined();
		expect(captured.connectArgs!.config.thinkingConfig).toEqual({ thinkingLevel: 'low' });
	});

	it('sends a thinking model its tool result without a scheduling field', async () => {
		const model = new GeminiLiveModel({ token: 'k', model: EXTENDED });
		await model.connect({ systemInstruction: 'sys', tools });
		captured.callbacks!.onmessage(toolCall('click_button'));
		model.sendToolResult('c0', 'click_button', { status: 'success' });
		expect(captured.toolResponses).toEqual([
			{ functionResponses: [{ id: 'c0', name: 'click_button', response: { status: 'success' } }] }
		]);
	});
});
