import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HumeEviModel } from './evi-model';
import { FakeWebSocket, installFakeWebSocket } from '../__fixtures__/fake-websocket';
import { base64ToInt16, bytesToBase64, int16ToBase64 } from '../pcm';

installFakeWebSocket();

beforeEach(() => {
	FakeWebSocket.reset();
	vi.clearAllMocks();
});

function listen(model: HumeEviModel) {
	const ev = {
		textOut: [] as string[],
		textIn: [] as string[],
		audioOut: [] as string[],
		toolCall: [] as Array<Array<{ id: string; name: string; args: Record<string, unknown> }>>,
		turnComplete: 0,
		interrupted: 0,
		notice: [] as string[],
		error: [] as string[],
		close: [] as unknown[]
	};
	model.on('text-out', (p) => ev.textOut.push(p.text));
	model.on('text-in', (p) => ev.textIn.push(p.text));
	model.on('audio-out', (p) => ev.audioOut.push(p.base64Pcm24k));
	model.on('tool-call', (p) => ev.toolCall.push(p.calls));
	model.on('turn-complete', () => (ev.turnComplete += 1));
	model.on('interrupted', () => (ev.interrupted += 1));
	model.on('notice', (n) => ev.notice.push(n.message));
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

/** Connect against the fake socket: open + chat_metadata ack. */
async function connected(model: HumeEviModel, tools = TOOLS) {
	const connectPromise = model.connect({ systemInstruction: 'sys', tools });
	// Credential resolution is async — wait a tick for the socket to be constructed.
	await settle();
	const ws = FakeWebSocket.last;
	ws.open();
	ws.message({ type: 'chat_metadata', chat_id: 'c1', chat_group_id: 'g1' });
	await connectPromise;
	return ws;
}

/** Build a base64 WAV (16-bit PCM) around the given samples. */
function wavBase64(samples: Int16Array, sampleRate: number, channels: number): string {
	const dataBytes = samples.length * 2;
	const bytes = new Uint8Array(44 + dataBytes);
	const view = new DataView(bytes.buffer);
	const tag = (offset: number, s: string) => {
		for (let i = 0; i < s.length; i++) bytes[offset + i] = s.charCodeAt(i);
	};
	tag(0, 'RIFF');
	view.setUint32(4, 36 + dataBytes, true);
	tag(8, 'WAVE');
	tag(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channels * 2, true);
	view.setUint16(32, channels * 2, true);
	view.setUint16(34, 16, true);
	tag(36, 'data');
	view.setUint32(40, dataBytes, true);
	for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
	return bytesToBase64(bytes);
}

describe('HumeEviModel', () => {
	it('connects with the access token in the URL and pushes the agent definition as session_settings', async () => {
		const model = new HumeEviModel({
			accessToken: async () => 'minted-token',
			configId: 'cfg-1'
		});
		listen(model);
		const ws = await connected(model);

		const url = new URL(ws.url);
		expect(`${url.protocol}//${url.host}${url.pathname}`).toBe('wss://api.hume.ai/v0/evi/chat');
		expect(url.searchParams.get('access_token')).toBe('minted-token');
		expect(url.searchParams.get('config_id')).toBe('cfg-1');

		const settings = ws.sentJson[0];
		expect(settings.type).toBe('session_settings');
		expect(settings.system_prompt).toBe('sys');
		// Contract mic format, declared so audio_input passes through unchanged.
		expect(settings.audio).toEqual({ encoding: 'linear16', sample_rate: 16000, channels: 1 });
		// EVI wants tool parameters as a stringified JSON schema.
		expect(settings.tools).toEqual([
			{
				type: 'function',
				name: 'click_button',
				description: 'Click a button',
				parameters: JSON.stringify(TOOLS[0].parameters)
			}
		]);
	});

	it('falls back to api_key auth and rejects when no credential is configured', async () => {
		const withKey = new HumeEviModel({ apiKey: 'dev-key' });
		const connectPromise = withKey.connect({ systemInstruction: 'sys', tools: [] });
		const ws = FakeWebSocket.last;
		expect(new URL(ws.url).searchParams.get('api_key')).toBe('dev-key');
		ws.open();
		ws.message({ type: 'chat_metadata' });
		await connectPromise;

		const bare = new HumeEviModel({});
		await expect(bare.connect({ systemInstruction: 'sys', tools: [] })).rejects.toThrow(
			/accessToken/
		);
	});

	it('rejects connect() when EVI errors before the session opens', async () => {
		const model = new HumeEviModel({ apiKey: 'k' });
		const connectPromise = model.connect({ systemInstruction: 'sys', tools: [] });
		const ws = FakeWebSocket.last;
		ws.open();
		ws.message({ type: 'error', code: 'I0100', message: 'invalid session settings' });
		await expect(connectPromise).rejects.toThrow(/invalid session settings/);
	});

	it('unpacks WAV audio output to raw 24 kHz PCM', async () => {
		const model = new HumeEviModel({ apiKey: 'k' });
		const ev = listen(model);
		const ws = await connected(model);

		// 96 stereo frames at 48 kHz → 48 mono samples → 24 samples at 24 kHz.
		const samples = new Int16Array(96 * 2).fill(1000);
		ws.message({ type: 'audio_output', id: 'a1', index: 0, data: wavBase64(samples, 48000, 2) });

		expect(ev.audioOut).toHaveLength(1);
		const pcm = base64ToInt16(ev.audioOut[0]);
		expect(pcm.length).toBe(48);
		expect(pcm[0]).toBe(1000);
	});

	it('drops an undecodable audio chunk with a notice instead of killing the session', async () => {
		const model = new HumeEviModel({ apiKey: 'k' });
		const ev = listen(model);
		const ws = await connected(model);

		ws.message({ type: 'audio_output', id: 'a1', index: 0, data: bytesToBase64(new Uint8Array([1, 2, 3])) });

		expect(ev.audioOut).toHaveLength(0);
		expect(ev.notice).toHaveLength(1);
		expect(ev.error).toEqual([]);
	});

	it('maps transcripts (skipping interim), barge-in, and assistant_end to neutral events', async () => {
		const model = new HumeEviModel({ apiKey: 'k' });
		const ev = listen(model);
		const ws = await connected(model);

		ws.message({ type: 'user_message', interim: true, message: { role: 'user', content: 'hel' } });
		ws.message({ type: 'user_message', interim: false, message: { role: 'user', content: 'hello' } });
		ws.message({ type: 'assistant_message', message: { role: 'assistant', content: 'hi!' } });
		ws.message({ type: 'user_interruption', time: 123 });
		ws.message({ type: 'assistant_end' });

		expect(ev.textIn).toEqual(['hello ']);
		expect(ev.textOut).toEqual(['hi! ']);
		expect(ev.interrupted).toBe(1);
		expect(ev.turnComplete).toBe(1);
	});

	it('surfaces function tool calls and answers with tool_response; builtins are ignored', async () => {
		const model = new HumeEviModel({ apiKey: 'k' });
		const ev = listen(model);
		const ws = await connected(model);

		ws.message({
			type: 'tool_call',
			tool_type: 'function',
			tool_call_id: 't1',
			name: 'click_button',
			parameters: '{"element_id":"save"}',
			response_required: true
		});
		ws.message({
			type: 'tool_call',
			tool_type: 'builtin',
			tool_call_id: 't2',
			name: 'web_search',
			parameters: '{}'
		});

		expect(ev.toolCall).toEqual([[{ id: 't1', name: 'click_button', args: { element_id: 'save' } }]]);

		const before = ws.sentJson.length;
		model.sendToolResult('t1', 'click_button', { status: 'success' });
		expect(ws.sentJson.slice(before)).toEqual([
			{
				type: 'tool_response',
				tool_call_id: 't1',
				tool_name: 'click_button',
				content: '{"status":"success"}'
			}
		]);
	});

	it('sends typed text as user_input and mic chunks as audio_input', async () => {
		const model = new HumeEviModel({ apiKey: 'k' });
		listen(model);
		const ws = await connected(model);

		model.sendText('do it');
		expect(ws.sentJson.at(-1)).toEqual({ type: 'user_input', text: 'do it' });

		const chunk = int16ToBase64(new Int16Array([1, 2, 3]));
		model.sendAudioChunk(chunk);
		expect(ws.sentJson.at(-1)).toEqual({ type: 'audio_input', data: chunk });
	});

	it('maps post-connect errors and close to their events', async () => {
		const model = new HumeEviModel({ apiKey: 'k' });
		const ev = listen(model);
		const ws = await connected(model);

		ws.message({ type: 'error', code: 'X', message: 'kaboom' });
		ws.serverClose(1011, 'server fault');

		expect(ev.error).toEqual(['kaboom']);
		expect(ev.close).toEqual([{ reason: 'server fault' }]);
	});

	it('close() is idempotent and gates sends', async () => {
		const model = new HumeEviModel({ apiKey: 'k' });
		listen(model);
		const ws = await connected(model);
		const before = ws.sent.length;

		model.close();
		model.close(); // idempotent — must not throw
		model.sendText('hi');
		model.sendAudioChunk(int16ToBase64(new Int16Array([1])));

		expect(ws.sent.length).toBe(before);
	});
});
