import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AnthropicTextTransport } from './text-transport';

// Mock the SDK: `new Anthropic(...)` yields a client whose `messages.stream`
// is our programmable stub. `vi.hoisted` makes the stub (and a record of
// constructor args) available to the hoisted `vi.mock` factory.
const { streamMock, ctorArgs } = vi.hoisted(() => ({
	streamMock: vi.fn(),
	ctorArgs: [] as unknown[]
}));
vi.mock('@anthropic-ai/sdk', () => ({
	default: class {
		messages = { stream: streamMock };
		constructor(opts: unknown) {
			ctorArgs.push(opts);
		}
	}
}));

const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * Fake `MessageStream`: replays `deltas` synchronously into the `text`
 * handler, then resolves `finalMessage()` with the given message.
 */
function fakeStream(final: Record<string, unknown>, deltas: string[] = []) {
	return {
		on(event: string, cb: (delta: string) => void) {
			if (event === 'text') for (const d of deltas) cb(d);
			return this;
		},
		async finalMessage() {
			return final;
		}
	};
}

// Per-test programming + a curated snapshot of each call's params (the
// request options carry an AbortSignal, so we clone only what we assert on).
let programs: Array<{ final: Record<string, unknown>; deltas?: string[] }> = [];
let recorded: Array<Record<string, unknown>> = [];

beforeEach(() => {
	streamMock.mockReset();
	programs = [];
	recorded = [];
	ctorArgs.length = 0;
	streamMock.mockImplementation((params: Record<string, unknown>) => {
		recorded.push(JSON.parse(JSON.stringify(params)));
		const program = programs.shift() ?? { final: { content: [], stop_reason: 'end_turn' } };
		return fakeStream(program.final, program.deltas);
	});
});

// Capture every neutral event the transport emits.
function listen(transport: AnthropicTextTransport) {
	const ev = {
		textOut: [] as string[],
		toolCall: [] as Array<Array<{ id: string; name: string; args: Record<string, unknown> }>>,
		turnComplete: 0,
		usage: [] as unknown[],
		error: [] as string[]
	};
	transport.on('text-out', (p) => ev.textOut.push(p.text));
	transport.on('tool-call', (p) => ev.toolCall.push(p.calls));
	transport.on('turn-complete', () => (ev.turnComplete += 1));
	transport.on('usage', (u) => ev.usage.push(u));
	transport.on('error', (e) => ev.error.push(e.message));
	return ev;
}

const TOOLS = [
	{
		name: 'click_button',
		description: 'Click a button',
		parameters: { type: 'object', properties: { element_id: { type: 'string' } } }
	}
];

describe('AnthropicTextTransport', () => {
	it('maps tools to input_schema, seeds history, and streams a final text turn', async () => {
		const transport = new AnthropicTextTransport({ apiKey: 'key' });
		const ev = listen(transport);
		await transport.connect({
			systemInstruction: 'sys',
			tools: TOOLS,
			history: [
				{ role: 'user', text: 'earlier' },
				{ role: 'model', text: 'noted' }
			]
		});

		programs = [
			{
				final: {
					content: [{ type: 'text', text: 'ok' }],
					stop_reason: 'end_turn'
				},
				deltas: ['o', 'k']
			}
		];
		transport.sendText('do it');
		await flush();

		expect(ev.turnComplete).toBe(1);
		expect(ev.textOut).toEqual(['o', 'k']);
		// Universal {name,description,parameters} → Anthropic input_schema.
		expect(recorded[0].tools).toEqual([
			{
				name: 'click_button',
				description: 'Click a button',
				input_schema: TOOLS[0].parameters
			}
		]);
		expect(recorded[0].system).toBe('sys');
		expect(recorded[0].model).toBe('claude-opus-4-8');
		// Adaptive thinking rides along by default.
		expect(recorded[0].thinking).toEqual({ type: 'adaptive' });
		// Seeded history precedes the new user turn; 'model' becomes 'assistant'.
		expect(recorded[0].messages).toEqual([
			{ role: 'user', content: 'earlier' },
			{ role: 'assistant', content: 'noted' },
			{ role: 'user', content: 'do it' }
		]);
	});

	it('omits thinking when disabled and tools when empty', async () => {
		const transport = new AnthropicTextTransport({ apiKey: 'key', thinking: false });
		listen(transport);
		await transport.connect({ systemInstruction: 'sys', tools: [] });

		programs = [{ final: { content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' } }];
		transport.sendText('hi');
		await flush();

		expect(recorded[0].thinking).toBeUndefined();
		expect(recorded[0].tools).toBeUndefined();
	});

	it('emits one tool-call for two tool_use blocks and re-calls only after both results', async () => {
		const transport = new AnthropicTextTransport({ apiKey: 'key' });
		const ev = listen(transport);
		await transport.connect({ systemInstruction: 'sys', tools: TOOLS });

		const assistantContent = [
			{ type: 'thinking', thinking: 'hmm', signature: 'sig-1' },
			{ type: 'tool_use', id: 'tu_1', name: 'a', input: { x: 1 } },
			{ type: 'tool_use', id: 'tu_2', name: 'b', input: { y: 2 } }
		];
		programs = [
			{ final: { content: assistantContent, stop_reason: 'tool_use' } },
			{ final: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } }
		];

		transport.sendText('go');
		await flush();

		// One tool-call event carrying both calls.
		expect(ev.toolCall).toHaveLength(1);
		const calls = ev.toolCall[0];
		expect(calls).toEqual([
			{ id: 'tu_1', name: 'a', args: { x: 1 } },
			{ id: 'tu_2', name: 'b', args: { y: 2 } }
		]);
		expect(ev.turnComplete).toBe(0);
		expect(streamMock).toHaveBeenCalledTimes(1);

		// First result in: still must NOT re-call (batch incomplete).
		transport.sendToolResult('tu_1', 'a', { status: 'success' });
		await flush();
		expect(streamMock).toHaveBeenCalledTimes(1);

		// Second result in: now it re-calls.
		transport.sendToolResult('tu_2', 'b', { result: 5 });
		await flush();
		expect(streamMock).toHaveBeenCalledTimes(2);
		expect(ev.turnComplete).toBe(1);

		// The re-call's history: the assistant turn VERBATIM (thinking block and
		// signature preserved), then ONE user turn batching both tool_results.
		const messages = recorded[1].messages as Array<{ role: string; content: unknown }>;
		expect(messages.at(-2)).toEqual({ role: 'assistant', content: assistantContent });
		expect(messages.at(-1)).toEqual({
			role: 'user',
			content: [
				{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"status":"success"}' },
				{ type: 'tool_result', tool_use_id: 'tu_2', content: '{"result":5}' }
			]
		});
	});

	it('maps usage to the neutral AgentUsage shape (cache counts folded into prompt)', async () => {
		const transport = new AnthropicTextTransport({ apiKey: 'key' });
		const ev = listen(transport);
		await transport.connect({ systemInstruction: 'sys', tools: [] });

		programs = [
			{
				final: {
					content: [{ type: 'text', text: 'hi' }],
					stop_reason: 'end_turn',
					usage: {
						input_tokens: 10,
						output_tokens: 3,
						cache_read_input_tokens: 40,
						cache_creation_input_tokens: 5
					}
				}
			}
		];
		transport.sendText('hi');
		await flush();

		expect(ev.usage).toEqual([
			{
				promptTokenCount: 55,
				responseTokenCount: 3,
				totalTokenCount: 58,
				cachedContentTokenCount: 40
			}
		]);
	});

	it('reports an SDK failure as a normalised error event', async () => {
		const transport = new AnthropicTextTransport({ apiKey: 'key' });
		const ev = listen(transport);
		await transport.connect({ systemInstruction: 'sys', tools: [] });

		streamMock.mockImplementationOnce(() => ({
			on() {
				return this;
			},
			async finalMessage() {
				throw new Error('boom');
			}
		}));
		transport.sendText('hi');
		await flush();

		expect(ev.error).toEqual(['boom']);
		expect(ev.turnComplete).toBe(0);
	});

	it('constructs a browser-enabled client pointing at Anthropic by default', async () => {
		const transport = new AnthropicTextTransport({ apiKey: 'real-key' });
		await transport.connect({ systemInstruction: 'sys', tools: [] });
		expect(ctorArgs.at(-1)).toEqual({ apiKey: 'real-key', dangerouslyAllowBrowser: true });
	});

	it('resolves a function-valued apiKey once per connect', async () => {
		const transport = new AnthropicTextTransport({ apiKey: async () => 'minted-key' });
		await transport.connect({ systemInstruction: 'sys', tools: [] });
		expect(ctorArgs.at(-1)).toEqual({ apiKey: 'minted-key', dangerouslyAllowBrowser: true });
	});

	it('points the SDK at a proxy baseUrl with a placeholder key when apiKey is omitted', async () => {
		const transport = new AnthropicTextTransport({ baseUrl: 'https://example.test/api/claude' });
		await transport.connect({ systemInstruction: 'sys', tools: [] });
		expect(ctorArgs.at(-1)).toEqual({
			apiKey: 'proxied-server-side',
			dangerouslyAllowBrowser: true,
			baseURL: 'https://example.test/api/claude'
		});
	});

	it('rejects connect() when neither apiKey nor baseUrl is configured', async () => {
		const transport = new AnthropicTextTransport();
		await expect(transport.connect({ systemInstruction: 'sys', tools: [] })).rejects.toThrow(
			/apiKey/
		);
	});

	it('close() guards the loop and is idempotent', async () => {
		const transport = new AnthropicTextTransport({ apiKey: 'key' });
		const ev = listen(transport);
		await transport.connect({ systemInstruction: 'sys', tools: [] });

		transport.close();
		transport.close(); // idempotent — must not throw

		transport.sendText('hi');
		await flush();

		expect(streamMock).not.toHaveBeenCalled();
		expect(ev.turnComplete).toBe(0);
		expect(ev.error).toEqual([]);
	});
});
