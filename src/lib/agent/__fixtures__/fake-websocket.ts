import { vi } from 'vitest';

/**
 * Programmable stand-in for the browser `WebSocket`, shared by the
 * WebSocket-based transport specs (OpenAI Realtime, Deepgram, Hume). Records
 * constructor args and sent frames; exposes `open()` / `message()` /
 * `serverClose()` helpers to drive the server side of the conversation.
 */
export class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	readyState = FakeWebSocket.CONNECTING;
	binaryType = 'blob';
	sent: unknown[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;

	constructor(
		public url: string,
		public protocols?: string | string[]
	) {
		FakeWebSocket.instances.push(this);
	}

	send(data: unknown): void {
		this.sent.push(data);
	}

	close(): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.({ code: 1000, reason: '' });
	}

	// ── Test drivers ──

	/** Simulate the handshake completing. */
	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
	}

	/** Deliver a server JSON message (objects are stringified). */
	message(payload: unknown): void {
		this.onmessage?.({
			data: typeof payload === 'string' ? payload : JSON.stringify(payload)
		});
	}

	/** Deliver a server binary frame. */
	binary(buffer: ArrayBuffer): void {
		this.onmessage?.({ data: buffer });
	}

	/** Simulate a server-initiated close. */
	serverClose(code = 1006, reason = ''): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.({ code, reason });
	}

	/** The JSON frames sent so far, parsed. */
	get sentJson(): Array<Record<string, unknown>> {
		return this.sent
			.filter((d): d is string => typeof d === 'string')
			.map((d) => JSON.parse(d));
	}

	static reset(): void {
		FakeWebSocket.instances = [];
	}

	static get last(): FakeWebSocket {
		const ws = FakeWebSocket.instances.at(-1);
		if (!ws) throw new Error('No FakeWebSocket was constructed');
		return ws;
	}
}

/** Install the fake as the global `WebSocket` for the current test file. */
export function installFakeWebSocket(): void {
	vi.stubGlobal('WebSocket', FakeWebSocket);
}
