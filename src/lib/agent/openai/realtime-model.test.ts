import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAIRealtimeModel } from './realtime-model';
import { FakeWebSocket, installFakeWebSocket } from '../__fixtures__/fake-websocket';
import { base64ToInt16, int16ToBase64 } from '../pcm';

installFakeWebSocket();

beforeEach(() => {
	FakeWebSocket.reset();
	vi.clearAllMocks();
});

function listen(model: OpenAIRealtimeModel) {
	const ev = {
		textOut: [] as string[],
		textIn: [] as string[],
		audioOut: [] as string[],
		toolCall: [] as Array<Array<{ id: string; name: string; args: Record<string, unknown> }>>,
		turnComplete: 0,
		interrupted: 0,
		usage: [] as unknown[],
		error: [] as string[],
		close: [] as unknown[]
	};
	model.on('text-out', (p) => ev.textOut.push(p.text));
	model.on('text-in', (p) => ev.textIn.push(p.text));
	model.on('audio-out', (p) => ev.audioOut.push(p.base64Pcm24k));
	model.on('tool-call', (p) => ev.toolCall.push(p.calls));
	model.on('turn-complete', () => (ev.turnComplete += 1));
	model.on('interrupted', () => (ev.interrupted += 1));
	model.on('usage', (u) => ev.usage.push(u));
	model.on('error', (e) => ev.error.push(e.message));
	model.on('close', (c) => ev.close.push(c));
	return ev;
}

const TOOLS = [
	{
		name: 'click_button',
		description: 'Click a button',
		parameters: { type: 'object', properties: { element_id: { type: 'string' } } }
	}
];

const settle = () => new Promise((r) => setTimeout(r, 0));

/** Connect a model against the fake socket and settle the handshake. */
async function connected(model: OpenAIRealtimeModel, tools = TOOLS) {
	const connectPromise = model.connect({ systemInstruction: 'sys', tools });
	// Token resolution is async — wait a tick for the socket to be constructed.
	await settle();
	FakeWebSocket.last.open();
	await connectPromise;
	return FakeWebSocket.last;
}

describe('OpenAIRealtimeModel', () => {
	it('connects with the model in the URL and the token in the subprotocol, then configures the session', async () => {
		const model = new OpenAIRealtimeModel({ token: async () => 'ek_minted' });
		listen(model);
		const ws = await connected(model);

		expect(ws.url).toBe('wss://api.openai.com/v1/realtime?model=gpt-realtime-2');
		expect(ws.protocols).toEqual(['realtime', 'openai-insecure-api-key.ek_minted']);

		const update = ws.sentJson[0];
		expect(update.type).toBe('session.update');
		const session = update.session as Record<string, any>;
		expect(session.type).toBe('realtime');
		expect(session.instructions).toBe('sys');
		expect(session.tools).toEqual([
			{
				type: 'function',
				name: 'click_button',
				description: 'Click a button',
				parameters: TOOLS[0].parameters
			}
		]);
		// 24 kHz PCM both ways; mic transcription enabled for the text-in channel.
		expect(session.audio.input.format).toEqual({ type: 'audio/pcm', rate: 24000 });
		expect(session.audio.input.transcription).toEqual({ model: 'gpt-4o-mini-transcribe' });
		expect(session.audio.output.format).toEqual({ type: 'audio/pcm', rate: 24000 });
		expect(session.audio.output.voice).toBe('marin');
	});

	it('rejects connect() when the socket closes before opening', async () => {
		const model = new OpenAIRealtimeModel({ token: 'bad' });
		const connectPromise = model.connect({ systemInstruction: 'sys', tools: [] });
		FakeWebSocket.last.serverClose(4001, 'unauthorized');
		await expect(connectPromise).rejects.toThrow(/unauthorized/);
	});

	it('sendText creates a user item AND a response; sendContextUpdate only the item', async () => {
		const model = new OpenAIRealtimeModel({ token: 'tok' });
		listen(model);
		const ws = await connected(model);
		const before = ws.sentJson.length;

		model.sendText('hello');
		let sent = ws.sentJson.slice(before);
		expect(sent.map((m) => m.type)).toEqual(['conversation.item.create', 'response.create']);
		expect((sent[0].item as any).content).toEqual([{ type: 'input_text', text: 'hello' }]);

		const mid = ws.sentJson.length;
		model.sendContextUpdate('<event>SURFACE_UPDATED</event>');
		sent = ws.sentJson.slice(mid);
		// Silent channel: the item is appended without provoking a turn.
		expect(sent.map((m) => m.type)).toEqual(['conversation.item.create']);
	});

	it('upsamples mic audio from 16 kHz to 24 kHz before appending', async () => {
		const model = new OpenAIRealtimeModel({ token: 'tok' });
		listen(model);
		const ws = await connected(model);
		const before = ws.sentJson.length;

		model.sendAudioChunk(int16ToBase64(new Int16Array([0, 1000, 2000, 3000])));
		const sent = ws.sentJson.slice(before);
		expect(sent[0].type).toBe('input_audio_buffer.append');
		// 4 samples at 16 kHz → 6 samples at 24 kHz.
		expect(base64ToInt16(sent[0].audio as string).length).toBe(6);
	});

	it('maps audio/transcript deltas, barge-in, and user transcription to neutral events', async () => {
		const model = new OpenAIRealtimeModel({ token: 'tok' });
		const ev = listen(model);
		const ws = await connected(model);

		ws.message({ type: 'response.output_audio.delta', delta: 'QUJD' });
		ws.message({ type: 'response.output_audio_transcript.delta', delta: 'Hel' });
		ws.message({ type: 'response.output_text.delta', delta: 'lo' });
		ws.message({
			type: 'conversation.item.input_audio_transcription.completed',
			transcript: 'hi there'
		});
		ws.message({ type: 'input_audio_buffer.speech_started' });

		expect(ev.audioOut).toEqual(['QUJD']);
		expect(ev.textOut).toEqual(['Hel', 'lo']);
		expect(ev.textIn).toEqual(['hi there']);
		expect(ev.interrupted).toBe(1);
	});

	it('batches function calls per response and continues only after all results', async () => {
		const model = new OpenAIRealtimeModel({ token: 'tok' });
		const ev = listen(model);
		const ws = await connected(model);

		ws.message({
			type: 'response.output_item.done',
			item: { type: 'function_call', call_id: 'c1', name: 'a', arguments: '{"x":1}' }
		});
		ws.message({
			type: 'response.output_item.done',
			item: { type: 'function_call', call_id: 'c2', name: 'b', arguments: '{"y":2}' }
		});
		// Calls only surface once the response is done — as ONE batch.
		expect(ev.toolCall).toHaveLength(0);
		ws.message({ type: 'response.done', response: {} });

		expect(ev.toolCall).toEqual([
			[
				{ id: 'c1', name: 'a', args: { x: 1 } },
				{ id: 'c2', name: 'b', args: { y: 2 } }
			]
		]);
		// A tool turn is not a completed turn.
		expect(ev.turnComplete).toBe(0);

		const before = ws.sentJson.length;
		model.sendToolResult('c1', 'a', { status: 'success' });
		let sent = ws.sentJson.slice(before);
		expect(sent.map((m) => m.type)).toEqual(['conversation.item.create']);
		expect((sent[0].item as any).output).toBe('{"status":"success"}');

		model.sendToolResult('c2', 'b', { result: 5 });
		sent = ws.sentJson.slice(before);
		// The second (final) result triggers exactly one response.create.
		expect(sent.map((m) => m.type)).toEqual([
			'conversation.item.create',
			'conversation.item.create',
			'response.create'
		]);
	});

	it('emits turn-complete and usage from response.done', async () => {
		const model = new OpenAIRealtimeModel({ token: 'tok' });
		const ev = listen(model);
		const ws = await connected(model);

		ws.message({
			type: 'response.done',
			response: {
				usage: {
					total_tokens: 100,
					input_tokens: 80,
					output_tokens: 20,
					input_token_details: { text_tokens: 50, audio_tokens: 30, cached_tokens: 10 },
					output_token_details: { text_tokens: 5, audio_tokens: 15 }
				}
			}
		});

		expect(ev.turnComplete).toBe(1);
		expect(ev.usage).toEqual([
			{
				promptTokenCount: 80,
				responseTokenCount: 20,
				totalTokenCount: 100,
				cachedContentTokenCount: 10,
				details: [
					{ modality: 'TEXT', tokenCount: 55 },
					{ modality: 'AUDIO', tokenCount: 45 }
				]
			}
		]);
	});

	it('surfaces server error events and close', async () => {
		const model = new OpenAIRealtimeModel({ token: 'tok' });
		const ev = listen(model);
		const ws = await connected(model);

		ws.message({ type: 'error', error: { message: 'bad event' } });
		expect(ev.error).toEqual(['bad event']);

		ws.serverClose(1001, 'going away');
		expect(ev.close).toEqual([{ reason: 'going away' }]);
	});

	it('close() is idempotent and gates sends', async () => {
		const model = new OpenAIRealtimeModel({ token: 'tok' });
		listen(model);
		const ws = await connected(model);
		const before = ws.sentJson.length;

		model.close();
		model.close(); // idempotent — must not throw
		model.sendText('hi');
		model.sendAudioChunk(int16ToBase64(new Int16Array([1, 2])));

		expect(ws.sentJson.length).toBe(before);
	});
});
