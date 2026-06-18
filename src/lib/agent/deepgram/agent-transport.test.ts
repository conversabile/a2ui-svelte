import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DeepgramVoiceAgentTransport } from './agent-transport';
import { FakeWebSocket, installFakeWebSocket } from '../__fixtures__/fake-websocket';
import { base64ToBytes, bytesToBase64 } from '../pcm';

installFakeWebSocket();

beforeEach(() => {
	FakeWebSocket.reset();
	vi.clearAllMocks();
});

function listen(transport: DeepgramVoiceAgentTransport) {
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
	transport.on('text-out', (p) => ev.textOut.push(p.text));
	transport.on('text-in', (p) => ev.textIn.push(p.text));
	transport.on('audio-out', (p) => ev.audioOut.push(p.base64Pcm24k));
	transport.on('tool-call', (p) => ev.toolCall.push(p.calls));
	transport.on('turn-complete', () => (ev.turnComplete += 1));
	transport.on('interrupted', () => (ev.interrupted += 1));
	transport.on('notice', (n) => ev.notice.push(n.message));
	transport.on('error', (e) => ev.error.push(e.message));
	transport.on('close', (c) => ev.close.push(c));
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

/** Connect against the fake socket: open + Settings accepted. */
async function connected(transport: DeepgramVoiceAgentTransport, tools = TOOLS) {
	const connectPromise = transport.connect({ systemInstruction: 'sys', tools });
	// Token resolution is async — wait a tick for the socket to be constructed.
	await settle();
	const ws = FakeWebSocket.last;
	ws.open();
	ws.message({ type: 'Welcome', request_id: 'r1' });
	ws.message({ type: 'SettingsApplied' });
	await connectPromise;
	return ws;
}

describe('DeepgramVoiceAgentTransport', () => {
	it('authenticates via subprotocol and sends the full agent definition as Settings', async () => {
		const transport = new DeepgramVoiceAgentTransport({ token: 'dg-api-key' });
		listen(transport);
		const ws = await connected(transport);

		expect(ws.url).toBe('wss://agent.deepgram.com/v1/agent/converse');
		// A raw API key rides the `token` scheme.
		expect(ws.protocols).toEqual(['token', 'dg-api-key']);
		expect(ws.binaryType).toBe('arraybuffer');

		const settings = ws.sentJson[0];
		expect(settings.type).toBe('Settings');
		// Contract rates: 16 kHz mic in, raw 24 kHz out — no resampling needed.
		expect(settings.audio).toEqual({
			input: { encoding: 'linear16', sample_rate: 16000 },
			output: { encoding: 'linear16', sample_rate: 24000, container: 'none' }
		});
		const agent = settings.agent as Record<string, any>;
		expect(agent.listen.provider).toEqual({ type: 'deepgram', model: 'nova-3' });
		expect(agent.think.provider).toEqual({ type: 'open_ai', model: 'gpt-4o-mini' });
		expect(agent.think.prompt).toBe('sys');
		// Functions WITHOUT an endpoint ⇒ client-side execution.
		expect(agent.think.functions).toEqual([
			{
				name: 'click_button',
				description: 'Click a button',
				parameters: TOOLS[0].parameters
			}
		]);
		expect(agent.speak.provider).toEqual({ type: 'deepgram', model: 'aura-2-thalia-en' });
	});

	it('uses the bearer scheme for JWT-shaped tokens (minted grants)', async () => {
		const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln';
		const transport = new DeepgramVoiceAgentTransport({ token: async () => jwt });
		listen(transport);
		const ws = await connected(transport);
		expect(ws.protocols).toEqual(['bearer', jwt]);
	});

	it('rejects connect() when Deepgram refuses the settings', async () => {
		const transport = new DeepgramVoiceAgentTransport({ token: 'k' });
		const connectPromise = transport.connect({ systemInstruction: 'sys', tools: [] });
		const ws = FakeWebSocket.last;
		ws.open();
		ws.message({ type: 'Error', description: 'invalid think provider', code: 'BAD_SETTINGS' });
		await expect(connectPromise).rejects.toThrow(/invalid think provider/);
	});

	it('passes mic audio through as binary frames and agent audio back as base64', async () => {
		const transport = new DeepgramVoiceAgentTransport({ token: 'k' });
		const ev = listen(transport);
		const ws = await connected(transport);

		const chunk = bytesToBase64(new Uint8Array([1, 2, 3, 4]));
		transport.sendAudioChunk(chunk);
		const sentBinary = ws.sent.at(-1) as ArrayBuffer;
		expect(new Uint8Array(sentBinary)).toEqual(new Uint8Array([1, 2, 3, 4]));

		ws.binary(new Uint8Array([9, 8, 7, 6]).buffer);
		expect(ev.audioOut).toHaveLength(1);
		expect(base64ToBytes(ev.audioOut[0])).toEqual(new Uint8Array([9, 8, 7, 6]));
	});

	it('maps conversation text, barge-in, and end-of-audio to neutral events', async () => {
		const transport = new DeepgramVoiceAgentTransport({ token: 'k' });
		const ev = listen(transport);
		const ws = await connected(transport);

		ws.message({ type: 'ConversationText', role: 'user', content: 'hello' });
		ws.message({ type: 'ConversationText', role: 'assistant', content: 'hi!' });
		ws.message({ type: 'UserStartedSpeaking' });
		ws.message({ type: 'AgentAudioDone' });

		expect(ev.textIn).toEqual(['hello ']);
		expect(ev.textOut).toEqual(['hi! ']);
		expect(ev.interrupted).toBe(1);
		expect(ev.turnComplete).toBe(1);
	});

	it('surfaces client-side function calls and answers with FunctionCallResponse', async () => {
		const transport = new DeepgramVoiceAgentTransport({ token: 'k' });
		const ev = listen(transport);
		const ws = await connected(transport);

		ws.message({
			type: 'FunctionCallRequest',
			functions: [
				{ id: 'f1', name: 'click_button', arguments: '{"element_id":"save"}', client_side: true },
				{ id: 'f2', name: 'server_thing', arguments: '{}', client_side: false }
			]
		});

		// Only the client-side call is ours.
		expect(ev.toolCall).toEqual([[{ id: 'f1', name: 'click_button', args: { element_id: 'save' } }]]);

		const before = ws.sentJson.length;
		transport.sendToolResult('f1', 'click_button', { status: 'success' });
		const sent = ws.sentJson.slice(before);
		expect(sent).toEqual([
			{
				type: 'FunctionCallResponse',
				id: 'f1',
				name: 'click_button',
				content: '{"status":"success"}'
			}
		]);
	});

	it('injects typed text as a user message', async () => {
		const transport = new DeepgramVoiceAgentTransport({ token: 'k' });
		listen(transport);
		const ws = await connected(transport);

		transport.sendText('do it');
		expect(ws.sentJson.at(-1)).toEqual({ type: 'InjectUserMessage', content: 'do it' });
	});

	it('maps warnings to notices and errors/close to their events', async () => {
		const transport = new DeepgramVoiceAgentTransport({ token: 'k' });
		const ev = listen(transport);
		const ws = await connected(transport);

		ws.message({ type: 'Warning', description: 'think provider slow' });
		ws.message({ type: 'Error', description: 'kaboom', code: 'X' });
		ws.serverClose(1011, 'server fault');

		expect(ev.notice).toEqual(['think provider slow']);
		expect(ev.error).toEqual(['kaboom']);
		expect(ev.close).toEqual([{ reason: 'server fault' }]);
	});

	it('close() is idempotent and gates sends', async () => {
		const transport = new DeepgramVoiceAgentTransport({ token: 'k' });
		listen(transport);
		const ws = await connected(transport);
		const before = ws.sent.length;

		transport.close();
		transport.close(); // idempotent — must not throw
		transport.sendText('hi');
		transport.sendAudioChunk(bytesToBase64(new Uint8Array([1, 2])));

		expect(ws.sent.length).toBe(before);
	});
});
