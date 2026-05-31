import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flushSync } from 'svelte';
import { VoiceAgent, type VoiceAgentSurface } from './agent.svelte';
import type {
	VoiceTransport,
	VoiceTransportConnectOptions,
	VoiceTransportEventMap
} from './transport';
import { toolRegistry } from '../core/registries/tool-registry';
import { userActionBus, type UserAction } from '../core/registries/event-bus';
import { ALL_EXTRAS, STRICT } from '../core/extensions';

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

	it('skips surface-watch polling for surfaces opted out via extensions.surfaceWatch=false', async () => {
		vi.useFakeTimers();
		try {
			let json: unknown = { root: 'v1' };
			const transport = new MockTransport();
			const agent = new VoiceAgent({
				transport,
				surfaces: () => [
					{ id: 'main', type: 'static', getJson: () => json, extensions: STRICT }
				],
				contextInstructions: () => '',
				systemInstruction: 'persona',
				mintToken: async () => 'fake',
				surfaceWatchTuning: { intervalMs: 1000, cooldownMs: 0 }
			});

			await agent.start();
			flushSync();

			// Mutate the surface and advance well past the polling interval.
			json = { root: 'v2' };
			vi.advanceTimersByTime(5000);
			flushSync();

			expect(
				transport.textsSent.some((t) => t.includes('SURFACE_UPDATED'))
			).toBe(false);

			await agent.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it('emits an extension-wrapped SURFACE_UPDATED payload for surfaces with ALL_EXTRAS (the default)', async () => {
		vi.useFakeTimers();
		try {
			let json: unknown = { root: 'v1' };
			const transport = new MockTransport();
			const agent = new VoiceAgent({
				transport,
				surfaces: () => [
					{ id: 'main', type: 'static', getJson: () => json, extensions: ALL_EXTRAS }
				],
				contextInstructions: () => 'ctx',
				systemInstruction: 'persona',
				mintToken: async () => 'fake',
				surfaceWatchTuning: { intervalMs: 1000, cooldownMs: 0 }
			});

			await agent.start();
			flushSync();

			json = { root: 'v2' };
			vi.advanceTimersByTime(1500);
			flushSync();

			const event = transport.textsSent.find((t) => t.includes('SURFACE_UPDATED'));
			expect(event).toBeDefined();
			const match = event!.match(/<payload>\n([\s\S]*?)\n<\/payload>/);
			expect(match).toBeTruthy();
			const parsed = JSON.parse(match![1]);
			expect(parsed.extensions['a2ui-svelte']).toMatchObject({
				kind: 'surfaceUpdated',
				updatedSurfaces: [{ root: 'v2' }],
				updatedContext: 'ctx'
			});
			expect(Array.isArray(parsed.extensions['a2ui-svelte'].availableElementIds)).toBe(true);

			await agent.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it('polls dynamic surfaces too, so user input into a path-bound field reaches the agent', async () => {
		vi.useFakeTimers();
		try {
			// Mirrors a dynamic surface the agent rendered (a TextField bound to
			// /draft) that the user then typed into: serializeSurface includes
			// the data model, so the JSON changes when the user writes.
			let json: unknown = { surfaceId: 'canvas', data: { draft: '' } };
			const transport = new MockTransport();
			const agent = new VoiceAgent({
				transport,
				mode: 'dynamic',
				surfaces: () => [
					{ id: 'canvas', type: 'dynamic', getJson: () => json, extensions: ALL_EXTRAS }
				],
				contextInstructions: () => '',
				systemInstruction: 'persona',
				mintToken: async () => 'fake',
				surfaceWatchTuning: { intervalMs: 1000, cooldownMs: 0 }
			});

			await agent.start();
			flushSync();

			// User types into the field — the data model now reflects it.
			json = { surfaceId: 'canvas', data: { draft: 'hello' } };
			vi.advanceTimersByTime(1500);
			flushSync();

			const event = transport.textsSent.find((t) => t.includes('SURFACE_UPDATED'));
			expect(event).toBeDefined();
			const match = event!.match(/<payload>\n([\s\S]*?)\n<\/payload>/);
			const parsed = JSON.parse(match![1]);
			expect(parsed.extensions['a2ui-svelte'].updatedSurfaces).toEqual([
				{ surfaceId: 'canvas', data: { draft: 'hello' } }
			]);

			await agent.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not poll a STRICT dynamic surface', async () => {
		vi.useFakeTimers();
		try {
			let json: unknown = { surfaceId: 'canvas', data: { draft: '' } };
			const transport = new MockTransport();
			const agent = new VoiceAgent({
				transport,
				mode: 'dynamic',
				surfaces: () => [
					{ id: 'canvas', type: 'dynamic', getJson: () => json, extensions: STRICT }
				],
				contextInstructions: () => '',
				systemInstruction: 'persona',
				mintToken: async () => 'fake',
				surfaceWatchTuning: { intervalMs: 1000, cooldownMs: 0 }
			});

			await agent.start();
			flushSync();

			json = { surfaceId: 'canvas', data: { draft: 'hello' } };
			vi.advanceTimersByTime(5000);
			flushSync();

			expect(
				transport.textsSent.some((t) => t.includes('SURFACE_UPDATED'))
			).toBe(false);

			await agent.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it('treats a surface with no extensions field as opted-in (back-compat default)', async () => {
		vi.useFakeTimers();
		try {
			let json: unknown = { root: 'v1' };
			const transport = new MockTransport();
			const agent = new VoiceAgent({
				transport,
				// Note: no `extensions` field — represents a pre-extension-era
				// hand-rolled surface handle. Must still get polled.
				surfaces: () => [{ id: 'main', type: 'static', getJson: () => json }],
				contextInstructions: () => '',
				systemInstruction: 'persona',
				mintToken: async () => 'fake',
				surfaceWatchTuning: { intervalMs: 1000, cooldownMs: 0 }
			});

			await agent.start();
			flushSync();

			json = { root: 'v2' };
			vi.advanceTimersByTime(1500);
			flushSync();

			expect(
				transport.textsSent.some((t) => t.includes('SURFACE_UPDATED'))
			).toBe(true);

			await agent.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it('B5: falls back to wrapped text turn for userAction when transport has no sendUserAction', async () => {
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

		const action: UserAction = {
			name: 'submit',
			surfaceId: 'main',
			sourceComponentId: 'save-btn',
			timestamp: '2026-05-27T00:00:00.000Z',
			context: {}
		};
		userActionBus.emit(action);

		const ev = transport.textsSent.find((t) => t.includes('USER_ACTION'));
		expect(ev).toBeDefined();
		const match = ev!.match(/<payload>\n([\s\S]*?)\n<\/payload>/);
		expect(match).toBeTruthy();
		const parsed = JSON.parse(match![1]);
		expect(parsed).toEqual({
			userAction: {
				name: 'submit',
				surfaceId: 'main',
				sourceComponentId: 'save-btn',
				timestamp: '2026-05-27T00:00:00.000Z',
				context: {}
			}
		});

		await agent.stop();
	});

	it('B5: forwards userAction via sendUserAction when the transport implements it', async () => {
		const received: UserAction[] = [];
		const transport = new MockTransport();
		(transport as VoiceTransport).sendUserAction = (a: UserAction) => received.push(a);

		const agent = new VoiceAgent({
			transport,
			surfaces: () => [],
			contextInstructions: () => '',
			systemInstruction: 'persona',
			mintToken: async () => 'fake'
		});

		await agent.start();
		flushSync();

		const action: UserAction = {
			name: 'submit',
			surfaceId: 'main',
			sourceComponentId: 'save-btn',
			timestamp: '2026-05-27T00:00:00.000Z',
			context: { who: 'dario' }
		};
		userActionBus.emit(action);

		expect(received).toEqual([action]);
		// Crucially: it must NOT also send a wrapped text turn.
		expect(transport.textsSent.some((t) => t.includes('USER_ACTION'))).toBe(false);

		await agent.stop();
	});

	it('B5: defaults a missing context to {} so the emitted action is spec-conformant', async () => {
		const received: UserAction[] = [];
		const transport = new MockTransport();
		(transport as VoiceTransport).sendUserAction = (a: UserAction) => received.push(a);

		const agent = new VoiceAgent({
			transport,
			surfaces: () => [],
			contextInstructions: () => '',
			systemInstruction: 'persona',
			mintToken: async () => 'fake'
		});

		await agent.start();
		flushSync();

		// Simulate a hand-rolled emitter that forgot the context field.
		userActionBus.emit({
			name: 'submit',
			surfaceId: 'main',
			sourceComponentId: 'save-btn',
			timestamp: '2026-05-27T00:00:00.000Z',
			context: undefined as unknown as Record<string, unknown>
		});

		expect(received[0].context).toEqual({});

		await agent.stop();
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
