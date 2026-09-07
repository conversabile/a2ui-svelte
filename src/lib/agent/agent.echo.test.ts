import { render } from '@testing-library/svelte';
import { describe, it, expect, afterEach } from 'vitest';
import { Agent } from './agent.svelte';
import type {
	AgentTransport,
	AgentTransportConnectOptions,
	AgentTransportEventMap,
	TransportCapabilities
} from './transport';
import { toolRegistry } from '../core/registries/tool-registry';
import { mountedSurfaces } from '../core/registries/surface-index';
import { A2UI_EXTENSION_NAMESPACE, STRICT, configureExtensions } from '../core/extensions';
import FieldSurface from '../renderer/__fixtures__/FieldSurface.svelte';

afterEach(() => configureExtensions({}));

/** Minimal request/response transport: enough to connect and collect results. */
class EchoTestTransport implements AgentTransport {
	connectOpts: AgentTransportConnectOptions | null = null;
	toolResults: Array<{ id: string; name: string; result: unknown }> = [];
	#listeners: { [E in keyof AgentTransportEventMap]?: Set<(p: never) => void> } = {};

	get capabilities(): TransportCapabilities {
		return {
			streaming: false,
			interruptible: false,
			silentContext: false,
			historyOwnership: 'client',
			canInitiateTurn: false,
			input: ['text'],
			output: ['text']
		};
	}

	async connect(opts: AgentTransportConnectOptions) {
		this.connectOpts = opts;
	}
	sendText() {}
	sendToolResult(id: string, name: string, result: unknown) {
		this.toolResults.push({ id, name, result });
	}
	on<E extends keyof AgentTransportEventMap>(
		event: E,
		handler: (p: AgentTransportEventMap[E]) => void
	): () => void {
		let set = this.#listeners[event];
		if (!set) {
			set = new Set();
			this.#listeners[event] = set;
		}
		set.add(handler as (p: never) => void);
		return () => set!.delete(handler as (p: never) => void);
	}
	close() {}

	emit<E extends keyof AgentTransportEventMap>(event: E, payload: AgentTransportEventMap[E]) {
		for (const h of this.#listeners[event] ?? []) (h as (p: unknown) => void)(payload);
	}
}

/** A connected agent whose surfaces are whatever is mounted right now. */
async function connectedAgent() {
	const transport = new EchoTestTransport();
	const agent = new Agent(
		{
			instructions: 'You are a test agent.',
			surfaces: mountedSurfaces,
			contextInstructions: () => 'page context'
		},
		transport
	);
	await agent.start();
	return { agent, transport };
}

/** Run one tool call through the agent and return the result it sent back. */
async function call(
	transport: EchoTestTransport,
	name: string,
	args: Record<string, unknown>
): Promise<any> {
	const before = transport.toolResults.length;
	transport.emit('tool-call', { calls: [{ id: `c${before}`, name, args }] });
	// The built-in tools settle for 150 ms before returning.
	await new Promise((r) => setTimeout(r, 250));
	return transport.toolResults[before]?.result;
}

const extras = (result: any) => result?.extensions?.[A2UI_EXTENSION_NAMESPACE];

describe("Agent — the tool-result echo ('full')", () => {
	it('carries ONE echo built from every surface the definition declares', async () => {
		render(FieldSurface, { surfaceId: 'a', prefix: 'a' });
		render(FieldSurface, { surfaceId: 'b', prefix: 'b' });
		const { transport } = await connectedAgent();

		const result = await call(transport, 'click_button', { element_id: 'a-btn' });
		expect(result.results).toEqual([{ element_id: 'a-btn', status: 'success' }]);

		const e = extras(result);
		expect(e.updatedContext).toBe('page context');
		expect(e.availableElementIds).toEqual(expect.arrayContaining(['a-btn', 'b-btn']));
		// Both surfaces, once each — not "whichever surface owns the element".
		expect((e.updatedSurface as Array<{ surfaceId: string }>).map((s) => s.surfaceId)).toEqual([
			'a',
			'b'
		]);
		// The spec fields stay clean at the top level.
		expect(result).not.toHaveProperty('updatedSurface');
		expect(result).not.toHaveProperty('availableElementIds');
	});

	it('follows the mounted set: unmounting one surface shrinks the echo, not the reply', async () => {
		const a = render(FieldSurface, { surfaceId: 'a', prefix: 'a' });
		render(FieldSurface, { surfaceId: 'b', prefix: 'b' });
		const { transport } = await connectedAgent();

		a.unmount();
		const result = await call(transport, 'click_button', { element_id: 'b-btn' });
		expect(result.results).toEqual([{ element_id: 'b-btn', status: 'success' }]);
		expect((extras(result).updatedSurface as Array<{ surfaceId: string }>).map((s) => s.surfaceId)).toEqual(['b']);
	});

	it('gives point_to_elements no echo — it changes nothing', async () => {
		render(FieldSurface, { surfaceId: 'a', prefix: 'a' });
		const { transport } = await connectedAgent();

		const result = await call(transport, 'point_to_elements', { element_ids: ['a-btn'] });
		expect(result).toEqual({ results: [{ element_id: 'a-btn', status: 'pointed' }] });
		expect(result).not.toHaveProperty('extensions');
	});

	it('STRICT: the reply is exactly { results }, with no echo', async () => {
		configureExtensions(STRICT);
		render(FieldSurface, { surfaceId: 'a', prefix: 'a' });
		const { transport } = await connectedAgent();

		const result = await call(transport, 'click_button', { element_id: 'a-btn' });
		expect(result).toEqual({ results: [{ element_id: 'a-btn', status: 'success' }] });
	});
});

describe("Agent — the tool-result echo ('changed')", () => {
	it('reports a change in each surface exactly once, against ONE shared baseline', async () => {
		configureExtensions({ toolResultSurfaceEcho: 'changed' });
		render(FieldSurface, { surfaceId: 'a', prefix: 'a' });
		render(FieldSurface, { surfaceId: 'b', prefix: 'b' });
		const { transport } = await connectedAgent();

		const first = await call(transport, 'update_text_field', {
			element_id: 'a-name',
			value: 'John'
		});
		expect(extras(first).updatedDataModel).toEqual({ a: { name: 'John' } });

		// A per-surface baseline would re-report a's write here, because b's
		// snapshot was taken before it. One agent-wide baseline reports only b.
		const second = await call(transport, 'update_text_field', {
			element_id: 'b-name',
			value: 'Jane'
		});
		expect(extras(second).updatedDataModel).toEqual({ b: { name: 'Jane' } });
	});

	it('a no-op action returns bare { results } with no extensions at all', async () => {
		configureExtensions({ toolResultSurfaceEcho: 'changed' });
		render(FieldSurface, { surfaceId: 'a', prefix: 'a' });
		const { transport } = await connectedAgent();

		await call(transport, 'update_text_field', { element_id: 'a-name', value: 'John' });
		const again = await call(transport, 'update_text_field', {
			element_id: 'a-name',
			value: 'John'
		});
		expect(again).not.toHaveProperty('extensions');
		expect(again.results[0].status).toBe('success');
	});

	it('a structural change (a surface unmounting) echoes the full tree', async () => {
		configureExtensions({ toolResultSurfaceEcho: 'changed' });
		const a = render(FieldSurface, { surfaceId: 'a', prefix: 'a' });
		render(FieldSurface, { surfaceId: 'b', prefix: 'b' });
		const { transport } = await connectedAgent();

		a.unmount();
		const result = await call(transport, 'click_button', { element_id: 'b-btn' });
		const e = extras(result);
		expect((e.updatedSurface as Array<{ surfaceId: string }>).map((s) => s.surfaceId)).toEqual([
			'b'
		]);
		expect(e).not.toHaveProperty('updatedDataModel');
	});
});

describe('Agent — which tools the model is told about', () => {
	it('batchTools swaps the batched pair in for the single-element pair, in the PROMPT only', async () => {
		render(FieldSurface, { surfaceId: 'a', prefix: 'a' });
		const { transport } = await connectedAgent();

		const declared = transport.connectOpts!.tools!.map((t) => t.name);
		expect(declared).toContain('click_buttons');
		expect(declared).toContain('update_text_fields');
		expect(declared).not.toContain('click_button');
		expect(declared).not.toContain('update_text_field');

		// The single-element tools are still registered — that is the entry
		// point an external agent comes through.
		expect(await toolRegistry.execute('click_button', { element_id: 'a-btn' })).toEqual({
			results: [{ element_id: 'a-btn', status: 'success' }]
		});
	});

	it('with batchTools off the single-element pair is what the model sees', async () => {
		configureExtensions({ batchTools: false });
		render(FieldSurface, { surfaceId: 'a', prefix: 'a' });
		const { transport } = await connectedAgent();

		const declared = transport.connectOpts!.tools!.map((t) => t.name);
		expect(declared).toContain('click_button');
		expect(declared).toContain('update_text_field');
		expect(declared).not.toContain('click_buttons');
	});
});
