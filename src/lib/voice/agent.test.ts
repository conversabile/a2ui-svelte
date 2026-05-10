import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flushSync } from 'svelte';
import { VoiceAgent, type VoiceAgentSurface } from './agent.svelte';
import type {
	VoiceTransport,
	VoiceTransportConnectOptions,
	VoiceTransportEventMap
} from './transport';
import { toolRegistry } from '../core/registries/tool-registry';

// Stub AudioRecorder/AudioPlayer so the test never touches Web Audio.
vi.mock('./audio-recorder', () => ({
	AudioRecorder: class extends EventTarget {
		async start() {}
		stop() {}
	}
}));
vi.mock('./audio-player', () => ({
	AudioPlayer: class {
		constructor(_: number) {}
		addToQueue(_: string) {}
		stop() {}
	}
}));

class MockTransport implements VoiceTransport {
	connectOpts: VoiceTransportConnectOptions | null = null;
	textsSent: string[] = [];
	audioSent: string[] = [];
	toolResults: Array<{ id: string; name: string; result: unknown }> = [];
	closed = false;

	#listeners: { [E in keyof VoiceTransportEventMap]?: Set<(p: unknown) => void> } = {};

	async connect(opts: VoiceTransportConnectOptions) {
		this.connectOpts = opts;
	}
	sendAudioChunk(b64: string) {
		this.audioSent.push(b64);
	}
	sendText(text: string) {
		this.textsSent.push(text);
	}
	sendToolResult(id: string, name: string, result: unknown) {
		this.toolResults.push({ id, name, result });
	}
	on<E extends keyof VoiceTransportEventMap>(
		event: E,
		handler: (p: VoiceTransportEventMap[E]) => void
	): () => void {
		let set = this.#listeners[event];
		if (!set) {
			set = new Set();
			this.#listeners[event] = set;
		}
		set.add(handler as (p: unknown) => void);
		return () => set!.delete(handler as (p: unknown) => void);
	}
	close() {
		this.closed = true;
	}

	emit<E extends keyof VoiceTransportEventMap>(event: E, payload: VoiceTransportEventMap[E]) {
		const set = this.#listeners[event];
		if (!set) return;
		for (const h of set) (h as (p: unknown) => void)(payload);
	}
}

describe('VoiceAgent with a mock transport', () => {
	beforeEach(() => {
		// Tests share toolRegistry; clear between cases.
		for (const t of toolRegistry.getDeclarations()) toolRegistry.unregister(t.name);
	});

	it('connects, dispatches a tool call, and replies with the result', async () => {
		toolRegistry.register({
			name: 'add_one',
			description: 'add 1',
			parameters: { type: 'object', properties: {} },
			execute: async (args: Record<string, unknown>) => ({ result: (args.x as number) + 1 })
		});

		const surfaces: VoiceAgentSurface[] = [];
		const transport = new MockTransport();
		const agent = new VoiceAgent({
			transport,
			surfaces: () => surfaces,
			contextInstructions: () => '',
			systemInstruction: 'You are a test agent.',
			mintToken: async () => 'fake-token'
		});

		await agent.start();
		flushSync();
		expect(agent.connected).toBe(true);
		expect(transport.connectOpts?.token).toBe('fake-token');
		expect(transport.connectOpts?.systemInstruction).toContain('You are a test agent.');
		expect(transport.connectOpts?.tools.map((t) => t.name)).toContain('add_one');

		transport.emit('tool-call', { calls: [{ id: 'c1', name: 'add_one', args: { x: 2 } }] });
		// Tool dispatch is async (await toolRegistry.execute) — drain the microtask queue.
		await new Promise((r) => setTimeout(r, 0));
		flushSync();

		expect(transport.toolResults).toEqual([
			{ id: 'c1', name: 'add_one', result: { result: 3 } }
		]);
		expect(agent.status).toBe('thinking');

		await agent.stop();
		expect(transport.closed).toBe(true);
		expect(agent.connected).toBe(false);
	});

	it('captures transcript-in / transcript-out and clears thinking on turn-complete', async () => {
		const transport = new MockTransport();
		const agent = new VoiceAgent({
			transport,
			surfaces: () => [],
			contextInstructions: () => '',
			systemInstruction: 'persona',
			mintToken: async () => 'fake'
		});

		await agent.start();
		flushSync();

		transport.emit('transcript-in', { text: 'hello' });
		flushSync();
		transport.emit('transcript-out', { text: 'hi back' });
		transport.emit('turn-complete', {} as never);
		flushSync();

		expect(agent.transcript[0]).toEqual({ role: 'user', text: 'hello' });
		expect(agent.transcript[1]).toEqual({ role: 'model', text: 'hi back' });
		expect(agent.status).toBe('idle');

		await agent.stop();
	});
});
