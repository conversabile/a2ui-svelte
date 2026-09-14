import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GeminiTextModel } from './text-model';

// Mock the SDK: `new GoogleGenAI(...)` yields a client whose
// `models.generateContentStream` is our programmable stub. `vi.hoisted` makes
// the stub (and a record of constructor args) available to the hoisted
// `vi.mock` factory.
const { generateContentStream, ctorArgs } = vi.hoisted(() => ({
	generateContentStream: vi.fn(),
	ctorArgs: [] as unknown[]
}));
vi.mock('@google/genai', () => ({
	// A class so `new GoogleGenAI(...)` works; every instance exposes the stub
	// and records the options it was constructed with.
	GoogleGenAI: class {
		models = { generateContentStream };
		constructor(opts: unknown) {
			ctorArgs.push(opts);
		}
	}
}));

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Build an async stream of `GenerateContentResponse`-shaped chunks. */
function streamOf(chunks: unknown[]) {
	return (async function* () {
		for (const c of chunks) yield c;
	})();
}

// Per-test programming + a curated snapshot of each call's params (we can't
// structuredClone the whole params — `config.abortSignal` isn't cloneable).
let programs: unknown[][] = [];
let recorded: Array<{
	model: string;
	contents: unknown;
	tools: unknown;
	systemInstruction: unknown;
}> = [];

beforeEach(() => {
	generateContentStream.mockReset();
	programs = [];
	recorded = [];
	ctorArgs.length = 0;
	generateContentStream.mockImplementation(async (params: Record<string, any>) => {
		recorded.push({
			model: params.model,
			contents: JSON.parse(JSON.stringify(params.contents)),
			tools: params.config?.tools ? JSON.parse(JSON.stringify(params.config.tools)) : undefined,
			systemInstruction: params.config?.systemInstruction
		});
		return streamOf(programs.shift() ?? []);
	});
});

// Capture every neutral event the model emits.
function listen(model: GeminiTextModel) {
	const ev = {
		textOut: [] as string[],
		toolCall: [] as Array<Array<{ id: string; name: string; args: Record<string, unknown> }>>,
		turnComplete: 0,
		usage: [] as unknown[],
		notice: [] as string[],
		error: [] as string[]
	};
	model.on('text-out', (p) => ev.textOut.push(p.text));
	model.on('tool-call', (p) => ev.toolCall.push(p.calls));
	model.on('turn-complete', () => (ev.turnComplete += 1));
	model.on('usage', (u) => ev.usage.push(u));
	model.on('notice', (n) => ev.notice.push(n.message));
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

describe('GeminiTextModel', () => {
	it('passes tools through as functionDeclarations, seeds history, and streams a final text turn', async () => {
		const model = new GeminiTextModel({ apiKey: 'key' });
		const ev = listen(model);
		await model.connect({
			systemInstruction: 'sys',
			tools: TOOLS,
			history: [{ role: 'user', text: 'earlier' }]
		});

		programs = [[{ text: 'ok' }]];
		model.sendText('do it');
		await flush();

		expect(ev.turnComplete).toBe(1);
		expect(ev.textOut).toEqual(['ok']);
		// Tool passthrough: our universal {name,description,parameters} shape goes
		// straight into functionDeclarations (no remapping).
		expect(recorded[0].tools).toEqual([{ functionDeclarations: TOOLS }]);
		expect(recorded[0].systemInstruction).toBe('sys');
		// Seeded history precedes the new user turn (client-owned history).
		expect(recorded[0].contents).toEqual([
			{ role: 'user', parts: [{ text: 'earlier' }] },
			{ role: 'user', parts: [{ text: 'do it' }] }
		]);
	});

	it('emits one tool-call for two functionCall parts and re-calls only after both results', async () => {
		const model = new GeminiTextModel({ apiKey: 'key' });
		const ev = listen(model);
		await model.connect({ systemInstruction: 'sys', tools: TOOLS });

		programs = [
			// Turn 1: two parallel function calls (no ids — the request/response API
			// often omits them; the model must synthesise).
			[{ functionCalls: [{ name: 'a', args: { x: 1 } }, { name: 'b', args: { y: 2 } }] }],
			// Turn 2: the final reply after results come back.
			[{ text: 'done' }]
		];

		model.sendText('go');
		await flush();

		// One tool-call event carrying both calls.
		expect(ev.toolCall).toHaveLength(1);
		const calls = ev.toolCall[0];
		expect(calls.map((c) => c.name)).toEqual(['a', 'b']);
		expect(calls.map((c) => c.args)).toEqual([{ x: 1 }, { y: 2 }]);
		expect(calls[0].id).toBeTruthy();
		expect(calls[1].id).toBeTruthy();
		expect(ev.turnComplete).toBe(0);
		expect(generateContentStream).toHaveBeenCalledTimes(1);

		// First result in: still must NOT re-call (batch incomplete).
		model.sendToolResult(calls[0].id, calls[0].name, { status: 'success' });
		await flush();
		expect(generateContentStream).toHaveBeenCalledTimes(1);

		// Second result in: now it re-calls.
		model.sendToolResult(calls[1].id, calls[1].name, { result: 5 });
		await flush();
		expect(generateContentStream).toHaveBeenCalledTimes(2);
		expect(ev.turnComplete).toBe(1);
		expect(ev.textOut).toEqual(['done']);

		// The re-call's history: the model's function-call turn, then ONE user turn
		// batching both function responses (in result-arrival order).
		const c = recorded[1].contents as Array<{ role: string; parts: unknown[] }>;
		expect(c.at(-2)).toEqual({
			role: 'model',
			parts: [{ functionCall: { name: 'a', args: { x: 1 } } }, { functionCall: { name: 'b', args: { y: 2 } } }]
		});
		expect(c.at(-1)).toEqual({
			role: 'user',
			parts: [
				{ functionResponse: { name: 'a', response: { status: 'success' } } },
				{ functionResponse: { name: 'b', response: { result: 5 } } }
			]
		});
	});

	it('echoes each functionCall part back in history WITH its thoughtSignature', async () => {
		// Gemini 3 / thinking models attach a `thoughtSignature` to the PART wrapping
		// a functionCall and 400 ("missing a thought_signature") if it isn't echoed
		// back verbatim. The real SDK exposes these via `candidates[0].content.parts`
		// (the `functionCalls` accessor drops them), so we drive the stream that way.
		const model = new GeminiTextModel({ apiKey: 'key' });
		const ev = listen(model);
		await model.connect({ systemInstruction: 'sys', tools: TOOLS });

		programs = [
			[
				{
					candidates: [
						{
							content: {
								role: 'model',
								parts: [
									{ functionCall: { name: 'a', args: { x: 1 } }, thoughtSignature: 'sig-a' },
									{ functionCall: { name: 'b', args: { y: 2 } }, thoughtSignature: 'sig-b' }
								]
							}
						}
					]
				}
			],
			[{ text: 'done' }]
		];

		model.sendText('go');
		await flush();

		const calls = ev.toolCall[0];
		expect(calls.map((c) => c.name)).toEqual(['a', 'b']);
		expect(calls.map((c) => c.args)).toEqual([{ x: 1 }, { y: 2 }]);

		model.sendToolResult(calls[0].id, calls[0].name, { status: 'success' });
		model.sendToolResult(calls[1].id, calls[1].name, { status: 'success' });
		await flush();

		// The re-call's history must carry the model turn with BOTH thoughtSignatures
		// preserved on their respective parts.
		const c = recorded[1].contents as Array<{ role: string; parts: unknown[] }>;
		expect(c.at(-2)).toEqual({
			role: 'model',
			parts: [
				{ functionCall: { name: 'a', args: { x: 1 } }, thoughtSignature: 'sig-a' },
				{ functionCall: { name: 'b', args: { y: 2 } }, thoughtSignature: 'sig-b' }
			]
		});
	});

	it('streams text deltas as separate text-out events', async () => {
		const model = new GeminiTextModel({ apiKey: 'key' });
		const ev = listen(model);
		await model.connect({ systemInstruction: 'sys', tools: [] });

		programs = [[{ text: 'Hel' }, { text: 'lo' }]];
		model.sendText('hi');
		await flush();

		expect(ev.textOut).toEqual(['Hel', 'lo']);
		expect(ev.turnComplete).toBe(1);
		// No tools → config.tools omitted entirely.
		expect(recorded[0].tools).toBeUndefined();
	});

	it('maps usageMetadata to the neutral AgentUsage shape', async () => {
		const model = new GeminiTextModel({ apiKey: 'key' });
		const ev = listen(model);
		await model.connect({ systemInstruction: 'sys', tools: [] });

		programs = [
			[
				{
					text: 'hi',
					usageMetadata: {
						promptTokenCount: 10,
						candidatesTokenCount: 3,
						totalTokenCount: 13,
						cachedContentTokenCount: 4,
						promptTokensDetails: [{ modality: 'TEXT', tokenCount: 10 }]
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
				cachedContentTokenCount: 4,
				details: [{ modality: 'TEXT', tokenCount: 10 }]
			}
		]);
	});

	it('reports an SDK failure as a normalised error event', async () => {
		const model = new GeminiTextModel({ apiKey: 'key' });
		const ev = listen(model);
		await model.connect({ systemInstruction: 'sys', tools: [] });

		generateContentStream.mockRejectedValueOnce(new Error('boom'));
		model.sendText('hi');
		await flush();

		expect(ev.error).toEqual(['boom']);
		expect(ev.turnComplete).toBe(0);
	});

	it('omits httpOptions when no baseUrl is configured (calls Google directly)', async () => {
		const model = new GeminiTextModel({ apiKey: 'real-key' });
		await model.connect({ systemInstruction: 'sys', tools: [] });
		expect(ctorArgs.at(-1)).toEqual({ apiKey: 'real-key' });
	});

	it('resolves a function-valued apiKey once per connect', async () => {
		const model = new GeminiTextModel({ apiKey: async () => 'minted-key' });
		await model.connect({ systemInstruction: 'sys', tools: [] });
		expect(ctorArgs.at(-1)).toEqual({ apiKey: 'minted-key' });
	});

	it('points the SDK at a proxy baseUrl with a placeholder key when apiKey is omitted', async () => {
		const model = new GeminiTextModel({ baseUrl: 'https://example.test/api/gemini' });
		await model.connect({ systemInstruction: 'sys', tools: [] });
		expect(ctorArgs.at(-1)).toEqual({
			apiKey: 'proxied-server-side',
			httpOptions: { baseUrl: 'https://example.test/api/gemini' }
		});
	});

	it('rejects connect() when neither apiKey nor baseUrl is configured', async () => {
		const model = new GeminiTextModel();
		await expect(model.connect({ systemInstruction: 'sys', tools: [] })).rejects.toThrow(
			/apiKey/
		);
	});

	// A 429 / quota error the model should retry (vs. a generic SDK failure).
	const rateLimit = () =>
		Object.assign(new Error('429 RESOURCE_EXHAUSTED: rate limit exceeded'), { status: 429 });

	it('retries a rate-limited (429) request with backoff, then recovers', async () => {
		// retryBaseMs 0 → backoff resolves immediately (no real waiting).
		const model = new GeminiTextModel({ apiKey: 'key', maxRetries: 3, retryBaseMs: 0 });
		const ev = listen(model);
		await model.connect({ systemInstruction: 'sys', tools: [] });

		// First two attempts 429; the third uses the persistent mock → succeeds.
		generateContentStream.mockRejectedValueOnce(rateLimit());
		generateContentStream.mockRejectedValueOnce(rateLimit());
		programs = [[{ text: 'recovered' }]];

		model.sendText('hi');
		await vi.waitFor(() => expect(ev.turnComplete).toBe(1));

		expect(generateContentStream).toHaveBeenCalledTimes(3);
		expect(ev.textOut).toEqual(['recovered']);
		expect(ev.error).toEqual([]);
		// Each retry is announced for the debug box.
		expect(ev.notice).toHaveLength(2);
		expect(ev.notice[0]).toMatch(/rate-limited.*retry 1\/3/);
	});

	it('defaults to a single retry', async () => {
		// Default maxRetries (1): attempt + one retry = two calls before erroring.
		const model = new GeminiTextModel({ apiKey: 'key', retryBaseMs: 0 });
		const ev = listen(model);
		await model.connect({ systemInstruction: 'sys', tools: [] });

		generateContentStream.mockRejectedValue(rateLimit());
		model.sendText('hi');
		await vi.waitFor(() => expect(ev.error.length).toBe(1));

		expect(generateContentStream).toHaveBeenCalledTimes(2);
		expect(ev.notice).toHaveLength(1);
	});

	it('surfaces a 429 as an error only after exhausting maxRetries', async () => {
		const model = new GeminiTextModel({ apiKey: 'key', maxRetries: 2, retryBaseMs: 0 });
		const ev = listen(model);
		await model.connect({ systemInstruction: 'sys', tools: [] });

		generateContentStream.mockRejectedValue(rateLimit());
		model.sendText('hi');
		await vi.waitFor(() => expect(ev.error.length).toBe(1));

		// Initial attempt + 2 retries = 3 calls before giving up.
		expect(generateContentStream).toHaveBeenCalledTimes(3);
		expect(ev.error[0]).toMatch(/429|RESOURCE_EXHAUSTED/);
		expect(ev.turnComplete).toBe(0);
	});

	it('does not retry a non-rate-limit error', async () => {
		const model = new GeminiTextModel({ apiKey: 'key', retryBaseMs: 0 });
		const ev = listen(model);
		await model.connect({ systemInstruction: 'sys', tools: [] });

		generateContentStream.mockRejectedValue(new Error('boom'));
		model.sendText('hi');
		await vi.waitFor(() => expect(ev.error).toEqual(['boom']));

		expect(generateContentStream).toHaveBeenCalledTimes(1);
		expect(ev.notice).toEqual([]);
		expect(ev.turnComplete).toBe(0);
	});

	it('honours the server retryDelay hint over the exponential base', async () => {
		const model = new GeminiTextModel({ apiKey: 'key', maxRetries: 1, retryBaseMs: 0 });
		const ev = listen(model);
		await model.connect({ systemInstruction: 'sys', tools: [] });

		// retryBaseMs 0 ⇒ exponential delay is 0; the 2s server hint must be used.
		generateContentStream.mockRejectedValueOnce(
			Object.assign(new Error('429 RESOURCE_EXHAUSTED {"retryDelay":"2s"}'), { status: 429 })
		);
		programs = [[{ text: 'ok' }]];

		// Capture the backoff duration while resolving it instantly (scoped spy:
		// leaves the SDK mock's call count untouched).
		const slept: number[] = [];
		const real = globalThis.setTimeout;
		const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, d?: number) => {
			slept.push(d ?? 0);
			return real(fn, 0);
		}) as typeof setTimeout);

		model.sendText('hi');
		await vi.waitFor(() => expect(ev.turnComplete).toBe(1));
		spy.mockRestore();

		expect(slept).toContain(2000);
		expect(ev.notice[0]).toMatch(/in 2s/);
		expect(ev.error).toEqual([]);
	});

	it('close() guards the loop, swallows the abort, and is idempotent', async () => {
		const model = new GeminiTextModel({ apiKey: 'key' });
		const ev = listen(model);
		await model.connect({ systemInstruction: 'sys', tools: [] });

		model.close();
		model.close(); // idempotent — must not throw

		model.sendText('hi');
		await flush();

		expect(generateContentStream).not.toHaveBeenCalled();
		expect(ev.turnComplete).toBe(0);
		expect(ev.error).toEqual([]);
	});
});
