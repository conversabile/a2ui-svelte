import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAITextModel } from './text-model';

// Mock the SDK: `new OpenAI(...)` yields a client whose
// `chat.completions.create` is our programmable stub.
const { createMock, ctorArgs } = vi.hoisted(() => ({
	createMock: vi.fn(),
	ctorArgs: [] as unknown[]
}));
vi.mock('openai', () => ({
	default: class {
		chat = { completions: { create: createMock } };
		constructor(opts: unknown) {
			ctorArgs.push(opts);
		}
	}
}));

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Build an async stream of ChatCompletionChunk-shaped objects. */
function streamOf(chunks: unknown[]) {
	return (async function* () {
		for (const c of chunks) yield c;
	})();
}

let programs: unknown[][] = [];
let recorded: Array<Record<string, unknown>> = [];

beforeEach(() => {
	createMock.mockReset();
	programs = [];
	recorded = [];
	ctorArgs.length = 0;
	createMock.mockImplementation(async (params: Record<string, unknown>) => {
		recorded.push(JSON.parse(JSON.stringify(params)));
		return streamOf(programs.shift() ?? []);
	});
});

function listen(model: OpenAITextModel) {
	const ev = {
		textOut: [] as string[],
		toolCall: [] as Array<Array<{ id: string; name: string; args: Record<string, unknown> }>>,
		turnComplete: 0,
		usage: [] as unknown[],
		error: [] as string[]
	};
	model.on('text-out', (p) => ev.textOut.push(p.text));
	model.on('tool-call', (p) => ev.toolCall.push(p.calls));
	model.on('turn-complete', () => (ev.turnComplete += 1));
	model.on('usage', (u) => ev.usage.push(u));
	model.on('error', (e) => ev.error.push(e.message));
	return ev;
}

const TOOLS = [
	{
		name: 'click_button',
		description: 'Click a button',
		parameters: { type: 'object', properties: { element_id: { type: 'string' } } }
	}
];

/** A text-delta chunk. */
const text = (t: string) => ({ choices: [{ delta: { content: t } }] });

describe('OpenAITextModel', () => {
	it('maps tools to function tools, prepends the system message, and seeds history', async () => {
		const model = new OpenAITextModel({ apiKey: 'key' });
		const ev = listen(model);
		await model.connect({
			systemInstruction: 'sys',
			tools: TOOLS,
			history: [
				{ role: 'user', text: 'earlier' },
				{ role: 'model', text: 'noted' }
			]
		});

		programs = [[text('ok')]];
		model.sendText('do it');
		await flush();

		expect(ev.turnComplete).toBe(1);
		expect(ev.textOut).toEqual(['ok']);
		expect(recorded[0].model).toBe('gpt-5.2');
		expect(recorded[0].tools).toEqual([
			{
				type: 'function',
				function: {
					name: 'click_button',
					description: 'Click a button',
					parameters: TOOLS[0].parameters
				}
			}
		]);
		expect(recorded[0].stream).toBe(true);
		expect(recorded[0].stream_options).toEqual({ include_usage: true });
		// System message first, then seeded history ('model' → 'assistant'), then the turn.
		expect(recorded[0].messages).toEqual([
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'earlier' },
			{ role: 'assistant', content: 'noted' },
			{ role: 'user', content: 'do it' }
		]);
	});

	it('accumulates split tool-call deltas and re-calls only after all results', async () => {
		const model = new OpenAITextModel({ apiKey: 'key' });
		const ev = listen(model);
		await model.connect({ systemInstruction: 'sys', tools: TOOLS });

		programs = [
			// Turn 1: two parallel calls, their names/arguments split across chunks.
			[
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{ index: 0, id: 'call_a', function: { name: 'a', arguments: '{"x"' } },
									{ index: 1, id: 'call_b', function: { name: 'b', arguments: '' } }
								]
							}
						}
					]
				},
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{ index: 0, function: { arguments: ':1}' } },
									{ index: 1, function: { arguments: '{"y":2}' } }
								]
							}
						}
					]
				}
			],
			// Turn 2: the final reply after results come back.
			[text('done')]
		];

		model.sendText('go');
		await flush();

		expect(ev.toolCall).toHaveLength(1);
		const calls = ev.toolCall[0];
		expect(calls).toEqual([
			{ id: 'call_a', name: 'a', args: { x: 1 } },
			{ id: 'call_b', name: 'b', args: { y: 2 } }
		]);
		expect(ev.turnComplete).toBe(0);
		expect(createMock).toHaveBeenCalledTimes(1);

		// First result in: still must NOT re-call (batch incomplete).
		model.sendToolResult('call_a', 'a', { status: 'success' });
		await flush();
		expect(createMock).toHaveBeenCalledTimes(1);

		// Second result in: now it re-calls.
		model.sendToolResult('call_b', 'b', { result: 5 });
		await flush();
		expect(createMock).toHaveBeenCalledTimes(2);
		expect(ev.turnComplete).toBe(1);
		expect(ev.textOut).toEqual(['done']);

		// The re-call's history: the assistant tool_calls turn, then one `tool`
		// message per call id (in result-arrival order).
		const messages = recorded[1].messages as Array<Record<string, unknown>>;
		expect(messages.at(-3)).toEqual({
			role: 'assistant',
			content: null,
			tool_calls: [
				{ id: 'call_a', type: 'function', function: { name: 'a', arguments: '{"x":1}' } },
				{ id: 'call_b', type: 'function', function: { name: 'b', arguments: '{"y":2}' } }
			]
		});
		expect(messages.at(-2)).toEqual({
			role: 'tool',
			tool_call_id: 'call_a',
			content: '{"status":"success"}'
		});
		expect(messages.at(-1)).toEqual({
			role: 'tool',
			tool_call_id: 'call_b',
			content: '{"result":5}'
		});
	});

	it('streams text deltas as separate text-out events', async () => {
		const model = new OpenAITextModel({ apiKey: 'key' });
		const ev = listen(model);
		await model.connect({ systemInstruction: 'sys', tools: [] });

		programs = [[text('Hel'), text('lo')]];
		model.sendText('hi');
		await flush();

		expect(ev.textOut).toEqual(['Hel', 'lo']);
		expect(ev.turnComplete).toBe(1);
		// No tools → tools omitted entirely.
		expect(recorded[0].tools).toBeUndefined();
	});

	it('maps the usage chunk to the neutral AgentUsage shape', async () => {
		const model = new OpenAITextModel({ apiKey: 'key' });
		const ev = listen(model);
		await model.connect({ systemInstruction: 'sys', tools: [] });

		programs = [
			[
				text('hi'),
				{
					choices: [],
					usage: {
						prompt_tokens: 10,
						completion_tokens: 3,
						total_tokens: 13,
						prompt_tokens_details: { cached_tokens: 4 }
					}
				}
			]
		];
		model.sendText('hi');
		await flush();

		expect(ev.usage).toEqual([
			{
				promptTokenCount: 10,
				responseTokenCount: 3,
				totalTokenCount: 13,
				cachedContentTokenCount: 4
			}
		]);
	});

	it('reports an SDK failure as a normalised error event', async () => {
		const model = new OpenAITextModel({ apiKey: 'key' });
		const ev = listen(model);
		await model.connect({ systemInstruction: 'sys', tools: [] });

		createMock.mockRejectedValueOnce(new Error('boom'));
		model.sendText('hi');
		await flush();

		expect(ev.error).toEqual(['boom']);
		expect(ev.turnComplete).toBe(0);
	});

	it('constructs a browser-enabled client pointing at OpenAI by default', async () => {
		const model = new OpenAITextModel({ apiKey: 'real-key' });
		await model.connect({ systemInstruction: 'sys', tools: [] });
		expect(ctorArgs.at(-1)).toEqual({ apiKey: 'real-key', dangerouslyAllowBrowser: true });
	});

	it('points the SDK at a proxy baseUrl with a placeholder key when apiKey is omitted', async () => {
		const model = new OpenAITextModel({ baseUrl: 'https://example.test/api/openai' });
		await model.connect({ systemInstruction: 'sys', tools: [] });
		expect(ctorArgs.at(-1)).toEqual({
			apiKey: 'proxied-server-side',
			dangerouslyAllowBrowser: true,
			baseURL: 'https://example.test/api/openai'
		});
	});

	it('rejects connect() when neither apiKey nor baseUrl is configured', async () => {
		const model = new OpenAITextModel();
		await expect(model.connect({ systemInstruction: 'sys', tools: [] })).rejects.toThrow(
			/apiKey/
		);
	});

	it('close() guards the loop and is idempotent', async () => {
		const model = new OpenAITextModel({ apiKey: 'key' });
		const ev = listen(model);
		await model.connect({ systemInstruction: 'sys', tools: [] });

		model.close();
		model.close(); // idempotent — must not throw

		model.sendText('hi');
		await flush();

		expect(createMock).not.toHaveBeenCalled();
		expect(ev.turnComplete).toBe(0);
		expect(ev.error).toEqual([]);
	});
});
