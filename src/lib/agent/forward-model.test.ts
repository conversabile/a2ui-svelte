import { describe, it, expect, vi, type Mock } from 'vitest';
import type {
	AgentModel,
	AgentModelConnectOptions,
	AgentModelEventMap,
	AgentModelCapabilities
} from './model';
import { Agent } from './agent.svelte';
import { forwardModel, withoutAudio } from './forward-model';

type EventName = keyof AgentModelEventMap;

const VOICE_CAPS: AgentModelCapabilities = {
	streaming: true,
	interruptible: true,
	silentContext: true,
	historyOwnership: 'server',
	canInitiateTurn: true,
	input: ['audio', 'text'],
	output: ['audio', 'text']
};

const TEXT_CAPS: AgentModelCapabilities = {
	streaming: false,
	interruptible: false,
	silentContext: false,
	historyOwnership: 'client',
	canInitiateTurn: false,
	input: ['text'],
	output: ['text']
};

/**
 * Class-based (not an object literal) on purpose: private fields make an
 * unbound `this` throw, so a wrapper that forwards methods without binding
 * fails here instead of in production.
 */
class FakeModel implements AgentModel {
	calls: string[] = [];
	listeners: Array<{ event: EventName; off: Mock<() => void> }> = [];
	#caps: AgentModelCapabilities;

	constructor(caps: AgentModelCapabilities) {
		this.#caps = caps;
	}

	get capabilities(): AgentModelCapabilities {
		return this.#caps;
	}
	/** Live capability change — the wrapper must read through, not snapshot. */
	setCapabilities(caps: AgentModelCapabilities) {
		this.#caps = caps;
	}
	async connect(opts: AgentModelConnectOptions) {
		this.calls.push(`connect:${opts.systemInstruction}`);
	}
	sendText(text: string) {
		this.calls.push(`sendText:${text}`);
	}
	sendToolResult(callId: string, name: string, result: unknown) {
		this.calls.push(`sendToolResult:${callId}:${name}:${JSON.stringify(result)}`);
	}
	on<E extends EventName>(event: E, handler: (p: AgentModelEventMap[E]) => void) {
		this.calls.push(`on:${event}:${typeof handler}`);
		const off = vi.fn(() => {});
		this.listeners.push({ event, off });
		return off;
	}
	close() {
		this.calls.push('close');
	}
}

/** The optional members, added only when a test wants them present. */
class FullFakeModel extends FakeModel {
	sendContextUpdate(text: string) {
		this.calls.push(`sendContextUpdate:${text}`);
	}
	sendUserAction(action: { name: string }) {
		this.calls.push(`sendUserAction:${action.name}`);
	}
	sendAudioChunk(base64Pcm16k: string) {
		this.calls.push(`sendAudioChunk:${base64Pcm16k}`);
	}
}

const OPTIONAL_MEMBERS = ['sendContextUpdate', 'sendUserAction', 'sendAudioChunk'] as const;

describe('forwardModel', () => {
	it('forwards every required member to the inner model', async () => {
		const inner = new FakeModel(TEXT_CAPS);
		const wrapped = forwardModel(inner);

		await wrapped.connect({ systemInstruction: 'sys', tools: [] });
		wrapped.sendText('hi');
		wrapped.sendToolResult('c1', 'click_button', { ok: true });
		wrapped.close();

		expect(inner.calls).toEqual([
			'connect:sys',
			'sendText:hi',
			'sendToolResult:c1:click_button:{"ok":true}',
			'close'
		]);
		expect(wrapped.capabilities).toEqual(TEXT_CAPS);
	});

	it('keeps an absent optional member absent', () => {
		const wrapped = forwardModel(new FakeModel(TEXT_CAPS));
		for (const member of OPTIONAL_MEMBERS) {
			expect(member in wrapped, member).toBe(false);
			expect(wrapped[member]).toBeUndefined();
		}
	});

	it('keeps a present optional member present, and forwards it', () => {
		const inner = new FullFakeModel(VOICE_CAPS);
		const wrapped = forwardModel(inner);

		for (const member of OPTIONAL_MEMBERS) expect(member in wrapped, member).toBe(true);

		wrapped.sendContextUpdate!('ctx');
		wrapped.sendUserAction!({ name: 'save-btn' } as never);
		wrapped.sendAudioChunk!('pcm');
		expect(inner.calls).toEqual(['sendContextUpdate:ctx', 'sendUserAction:save-btn', 'sendAudioChunk:pcm']);
	});

	it('forwards a member the contract does not know about yet', () => {
		const inner = new FakeModel(TEXT_CAPS) as FakeModel & { future(): void };
		inner.future = () => inner.calls.push('future');
		const wrapped = forwardModel(inner) as unknown as { future(): void };

		wrapped.future();
		expect(inner.calls).toEqual(['future']);
	});

	it('reads capabilities through live, never a snapshot', () => {
		const inner = new FakeModel(TEXT_CAPS);
		const wrapped = forwardModel(inner);
		expect(wrapped.capabilities.streaming).toBe(false);

		inner.setCapabilities(VOICE_CAPS);
		expect(wrapped.capabilities.streaming).toBe(true);
	});

	it('lets an override win, and hides a member overridden with undefined', () => {
		const inner = new FullFakeModel(VOICE_CAPS);
		const sendText = vi.fn();
		const wrapped = forwardModel(inner, { sendText, sendContextUpdate: undefined });

		wrapped.sendText('hi');
		expect(sendText).toHaveBeenCalledWith('hi');
		expect(inner.calls).toEqual([]);
		expect('sendContextUpdate' in wrapped).toBe(false);
		expect('sendUserAction' in wrapped).toBe(true);
	});

	it('dispose() unsubscribes everything subscribed through the wrapper', () => {
		const inner = new FakeModel(TEXT_CAPS);
		const wrapped = forwardModel(inner);
		wrapped.on('text-out', () => {});
		wrapped.on('turn-complete', () => {});

		expect(inner.listeners.map((l) => l.event)).toEqual(['text-out', 'turn-complete']);
		expect(inner.listeners.every((l) => l.off.mock.calls.length === 0)).toBe(true);

		wrapped.dispose();
		expect(inner.listeners.every((l) => l.off.mock.calls.length === 1)).toBe(true);

		wrapped.dispose();
		expect(inner.listeners.every((l) => l.off.mock.calls.length === 1)).toBe(true);
	});

	it('returns a working, idempotent unsubscribe from on()', () => {
		const inner = new FakeModel(TEXT_CAPS);
		const wrapped = forwardModel(inner);
		const off = wrapped.on('text-out', () => {});

		off();
		off();
		expect(inner.listeners[0].off).toHaveBeenCalledTimes(1);

		// Already dropped — dispose() must not call it a second time.
		wrapped.dispose();
		expect(inner.listeners[0].off).toHaveBeenCalledTimes(1);
	});
});

describe('withoutAudio', () => {
	it('strips the audio modality and hides sendAudioChunk', () => {
		const inner = new FullFakeModel(VOICE_CAPS);
		const wrapped = withoutAudio(inner);

		expect(wrapped.capabilities.input).toEqual(['text']);
		expect(wrapped.capabilities.output).toEqual(['text']);
		expect('sendAudioChunk' in wrapped).toBe(false);
		expect(wrapped.sendAudioChunk).toBeUndefined();
	});

	it('leaves every other capability and member alone', () => {
		const inner = new FullFakeModel(VOICE_CAPS);
		const wrapped = withoutAudio(inner);

		expect(wrapped.capabilities).toMatchObject({
			streaming: true,
			interruptible: true,
			silentContext: true,
			historyOwnership: 'server',
			canInitiateTurn: true
		});
		expect('sendContextUpdate' in wrapped).toBe(true);
		wrapped.sendContextUpdate!('ctx');
		wrapped.sendText('hi');
		expect(inner.calls).toEqual(['sendContextUpdate:ctx', 'sendText:hi']);
	});

	it('reads capabilities through live', () => {
		const inner = new FullFakeModel(VOICE_CAPS);
		const wrapped = withoutAudio(inner);

		inner.setCapabilities({ ...VOICE_CAPS, interruptible: false, output: ['audio'] });
		expect(wrapped.capabilities.interruptible).toBe(false);
		expect(wrapped.capabilities.output).toEqual([]);
	});

	it('is a no-op on a text-only model', () => {
		const wrapped = withoutAudio(new FakeModel(TEXT_CAPS));
		expect(wrapped.capabilities).toEqual(TEXT_CAPS);
		expect('sendAudioChunk' in wrapped).toBe(false);
	});
});

/**
 * The mask's real job: the `Agent` adapts to capabilities, never to identity.
 * No Web Audio mocks here on purpose — jsdom has no mic, so a mask that leaked
 * the audio modality would make `#startAudio` fail and land in `configIssue`.
 */
describe('withoutAudio + Agent', () => {
	it('runs a voice model text-in/text-out, with no mic', async () => {
		const inner = new FullFakeModel(VOICE_CAPS);
		const agent = new Agent({ instructions: 'be brief', surfaces: () => [] }, withoutAudio(inner));

		await agent.start();

		expect(agent.configIssue).toBeNull();
		expect(agent.capabilities.input).toEqual(['text']);
		expect(agent.capabilities.output).toEqual(['text']);
		expect(agent.recording).toBe(false);
		expect(inner.calls.some((c) => c.startsWith('connect:'))).toBe(true);

		agent.stop();
	});
});
