import { render } from '@testing-library/svelte';
import { describe, it, expect, beforeAll } from 'vitest';
import { flushSync, tick } from 'svelte';
import A2ASurface from './A2ASurface.svelte';
import type {
	A2ATransport,
	A2UIClientEvent,
	A2UIServerMessage
} from '../transport/a2a';
import { userActionBus } from '../core/registries/event-bus';
import { a2uiState } from '../core/state.svelte';

beforeAll(() => {
	if (typeof (globalThis as any).CSS === 'undefined') {
		(globalThis as any).CSS = { escape: (s: string) => s };
	}
});

class MockA2ATransport implements A2ATransport {
	connectedTimes = 0;
	sent: A2UIClientEvent[] = [];
	closed = false;
	#handlers = new Set<(m: A2UIServerMessage) => void>();

	async connect() {
		this.connectedTimes++;
	}
	onMessage(h: (m: A2UIServerMessage) => void) {
		this.#handlers.add(h);
		return () => this.#handlers.delete(h);
	}
	sendEvent(e: A2UIClientEvent) {
		this.sent.push(e);
	}
	close() {
		this.closed = true;
	}
	push(m: A2UIServerMessage) {
		for (const h of this.#handlers) h(m);
	}
}

describe('A2ASurface — server→client dispatch', () => {
	it('connects the transport on mount', async () => {
		const transport = new MockA2ATransport();
		render(A2ASurface, { surfaceId: 'm1', transport });
		await tick();
		expect(transport.connectedTimes).toBe(1);
	});

	it('routes surfaceUpdate + beginRendering through processMessage and renders the result', async () => {
		const transport = new MockA2ATransport();
		const { getByText } = render(A2ASurface, { surfaceId: 'render-flow', transport });
		await tick();

		transport.push({
			surfaceUpdate: {
				surfaceId: 'render-flow',
				components: [
					{ id: 'root', component: { Text: { text: { literalString: 'hello a2a' } } } }
				]
			}
		});
		transport.push({
			beginRendering: { surfaceId: 'render-flow', root: 'root' }
		});
		flushSync();
		await tick();

		expect(getByText('hello a2a')).toBeTruthy();
	});

	it('honours dataModelUpdate so path-bound components reflect the new value', async () => {
		const transport = new MockA2ATransport();
		const { getByText } = render(A2ASurface, { surfaceId: 'data-flow', transport });
		await tick();

		transport.push({
			surfaceUpdate: {
				surfaceId: 'data-flow',
				components: [
					{ id: 'root', component: { Text: { text: { path: '/greeting' } } } }
				]
			}
		});
		transport.push({ beginRendering: { surfaceId: 'data-flow', root: 'root' } });
		transport.push({
			dataModelUpdate: {
				surfaceId: 'data-flow',
				path: '/',
				contents: [{ key: 'greeting', valueString: 'data-bound hi' }]
			}
		});
		flushSync();
		await tick();

		expect(getByText('data-bound hi')).toBeTruthy();
	});

	it('handles deleteSurface — the surface drops out of a2uiState', async () => {
		const transport = new MockA2ATransport();
		render(A2ASurface, { surfaceId: 'doomed', transport });
		await tick();

		transport.push({
			surfaceUpdate: {
				surfaceId: 'doomed',
				components: [
					{ id: 'root', component: { Text: { text: { literalString: 'bye' } } } }
				]
			}
		});
		transport.push({ beginRendering: { surfaceId: 'doomed', root: 'root' } });
		flushSync();
		expect(a2uiState.getSurface('doomed')).toBeDefined();

		transport.push({ deleteSurface: { surfaceId: 'doomed' } });
		flushSync();
		expect(a2uiState.getSurface('doomed')).toBeUndefined();
	});
});

describe('A2ASurface — client→server forwarding', () => {
	it('forwards userActions raised on its own surfaceId through transport.sendEvent', async () => {
		const transport = new MockA2ATransport();
		render(A2ASurface, { surfaceId: 'fwd', transport });
		await tick();

		userActionBus.emit({
			name: 'submit',
			surfaceId: 'fwd',
			sourceComponentId: 'save-btn',
			timestamp: '2026-05-27T00:00:00.000Z',
			context: { x: 1 }
		});

		expect(transport.sent).toHaveLength(1);
		expect(transport.sent[0]).toEqual({
			userAction: {
				name: 'submit',
				surfaceId: 'fwd',
				sourceComponentId: 'save-btn',
				timestamp: '2026-05-27T00:00:00.000Z',
				context: { x: 1 }
			}
		});
	});

	it('ignores userActions raised on a different surface', async () => {
		const transport = new MockA2ATransport();
		render(A2ASurface, { surfaceId: 'self', transport });
		await tick();

		userActionBus.emit({
			name: 'submit',
			surfaceId: 'other',
			sourceComponentId: 'save-btn',
			timestamp: '2026-05-27T00:00:00.000Z',
			context: {}
		});

		expect(transport.sent).toEqual([]);
	});
});
