import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushSync } from 'svelte';
import { Agent, type AgentSurface } from './agent.svelte';
import { ScriptedTransport } from './scripted-transport';
import { toolRegistry } from '../core/registries/tool-registry';
import { actionRegistry } from '../core/registries/action-registry';
import { ALL_EXTRAS } from '../core/extensions';

// Drain the microtask queue (ScriptedTransport defers its emits to a microtask;
// tool dispatch is async). A macrotask hop lets all of it settle.
const flush = () => new Promise((r) => setTimeout(r, 0));

// A `click_button` tool that mirrors the one `<StaticSurface>` registers: it
// routes through the action registry, exactly like the real surface.
function registerClickButton(): void {
	toolRegistry.register({
		name: 'click_button',
		description: 'Click a single button in the UI.',
		parameters: {
			type: 'object',
			properties: { element_id: { type: 'string' } },
			required: ['element_id']
		},
		execute: async (args: Record<string, unknown>) => {
			actionRegistry.execute(args.element_id as string, 'click');
			return { status: 'success' };
		}
	});
}

describe('Agent with a ScriptedTransport (deterministic, no model)', () => {
	beforeEach(() => {
		for (const t of toolRegistry.getDeclarations()) toolRegistry.unregister(t.name);
		actionRegistry.unregisterBySurface('main');
	});
	afterEach(() => {
		actionRegistry.unregisterBySurface('main');
	});

	it('drives a click_button on a test surface and the surface state changes (no network)', async () => {
		// Guard: a deterministic transport must never touch the network.
		const fetchSpy =
			typeof globalThis.fetch === 'function'
				? vi.spyOn(globalThis, 'fetch').mockImplementation((() => {
						throw new Error('ScriptedTransport must not hit the network');
					}) as never)
				: null;

		// The button's action mutates the surface's value when clicked.
		const surface = { value: 'before' };
		actionRegistry.register(
			'save-btn',
			'click',
			() => {
				surface.value = 'after';
			},
			'main'
		);
		registerClickButton();

		const transport = new ScriptedTransport([
			{
				on: 'save it',
				calls: [{ name: 'click_button', args: { element_id: 'save-btn' } }],
				text: 'Saved.'
			}
		]);
		const surfaces: AgentSurface[] = [
			{
				id: 'main',
				type: 'static',
				getJson: () => ({ surfaceId: 'main', saved: surface.value }),
				extensions: ALL_EXTRAS
			}
		];
		const agent = new Agent(
			{
				instructions: 'persona',
				surfaces: () => surfaces
			},
			transport
		);

		await agent.start();
		flushSync();
		// The neutral text profile: no poll timer started.
		expect(agent.connected).toBe(true);

		agent.sendTextMessage('please save it');
		await flush();
		flushSync();
		await flush();
		flushSync();

		// The action ran → the surface changed.
		expect(surface.value).toBe('after');
		// The tool result the agent echoed back to the transport.
		expect(transport.toolResults).toEqual([
			{ id: expect.any(String), name: 'click_button', result: { status: 'success' } }
		]);
		// The scripted follow-up reply landed as a model transcript turn.
		expect(agent.transcript.at(-1)).toEqual({ role: 'model', text: 'Saved.' });
		expect(transport.textsSent).toContain('please save it');
		expect(agent.status).toBe('idle');
		expect(fetchSpy?.mock.calls.length ?? 0).toBe(0);

		await agent.stop();
		fetchSpy?.mockRestore();
	});

	it('replies with scripted text and returns to idle on turn-complete', async () => {
		const transport = new ScriptedTransport([{ text: 'Hi there.' }]);
		const agent = new Agent(
			{
				instructions: 'persona',
				surfaces: () => []
			},
			transport
		);

		await agent.start();
		flushSync();
		agent.sendTextMessage('hello');
		await flush();
		flushSync();

		expect(agent.transcript).toEqual([
			{ role: 'user', text: 'hello' },
			{ role: 'model', text: 'Hi there.' }
		]);
		expect(agent.status).toBe('idle');

		await agent.stop();
	});

	it('emits parallel tool calls as one batch and replies only after every result', async () => {
		const order: string[] = [];
		for (const id of ['a', 'b']) {
			actionRegistry.register(
				id,
				'click',
				() => {
					order.push(id);
				},
				'main'
			);
		}
		registerClickButton();

		const transport = new ScriptedTransport([
			{
				on: 'both',
				calls: [
					{ name: 'click_button', args: { element_id: 'a' } },
					{ name: 'click_button', args: { element_id: 'b' } }
				],
				text: 'Done.'
			}
		]);
		const agent = new Agent(
			{
				instructions: 'persona',
				surfaces: () => []
			},
			transport
		);

		await agent.start();
		flushSync();
		agent.sendTextMessage('click both');
		await flush();
		flushSync();
		await flush();
		flushSync();

		// Both actions ran in batch order; both results echoed; one final reply.
		expect(order).toEqual(['a', 'b']);
		expect(transport.toolResults.map((t) => t.name)).toEqual(['click_button', 'click_button']);
		expect(agent.transcript.at(-1)).toEqual({ role: 'model', text: 'Done.' });

		await agent.stop();
	});

	it('closes out an unscripted (forwarded) turn without consuming the queued reaction', async () => {
		// The head reaction is gated on the user message; a non-matching turn (as a
		// forwarded surface-sync turn would be) must not consume it.
		const transport = new ScriptedTransport([{ on: 'real question', text: 'The answer.' }]);
		const agent = new Agent(
			{
				instructions: 'persona',
				surfaces: () => []
			},
			transport
		);

		await agent.start();
		flushSync();

		// A turn the script doesn't match: gets a bare turn-complete, queue intact.
		transport.sendText('<event>SURFACE_UPDATED</event> ...');
		await flush();
		flushSync();
		expect(agent.transcript.filter((m) => m.role === 'model')).toEqual([]);

		// The real question now consumes the still-queued reaction.
		agent.sendTextMessage('here is the real question');
		await flush();
		flushSync();
		expect(agent.transcript.at(-1)).toEqual({ role: 'model', text: 'The answer.' });

		await agent.stop();
	});
});
