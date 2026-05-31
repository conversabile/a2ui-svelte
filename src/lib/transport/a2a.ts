/**
 * A2UI v0.8 — A2A message-driven transport.
 *
 * Voice mode (`a2ui-svelte/voice`) integrates A2UI with live voice APIs that
 * have no native event channel back into the model context — there the agent
 * generates UI via LLM function tools (`surfaceUpdate`, `beginRendering`,
 * `dataModelUpdate`). The A2UI v0.8 spec describes a different integration:
 * a unidirectional server-to-client stream of A2A `DataPart`s (typically over
 * SSE) carrying surface mutations, with a paired client-to-server channel for
 * `userAction` / `error` events.
 *
 * This module provides the spec-aligned mode alongside `VoiceTransport`. The
 * interface deals in *unwrapped* A2UI JSON for ergonomics, but every wire
 * implementation MUST honour the A2A envelope:
 *
 *  - Each A2UI message rides inside an A2A `Message` whose `DataPart` has
 *    `mimeType: "application/json+a2ui"` and `data: <A2UI JSON>`.
 *  - The HTTP request carries `X-A2A-Extensions:
 *    https://a2ui.org/a2a-extension/a2ui/v0.8` (or the equivalent gRPC
 *    metadata) to signal extension activation.
 *  - Every outbound client→server `Message`'s `metadata` includes the
 *    `a2uiClientCapabilities` blob produced by
 *    `getClientCapabilities` from `a2ui-svelte/core`.
 *  - For surfaces that enabled v0.9 `sendDataModel`, that same `metadata`
 *    also carries the `a2uiClientDataModel` blob produced by
 *    `getClientDataModel` from `a2ui-svelte/core` (the full current data
 *    model, per spec — no deltas on this out-of-band channel).
 *
 * Reference SSE / WebSocket implementations are intentionally deferred to a
 * follow-up — the interface and envelope contract are defined here so the
 * adapter component and downstream consumers can be built and tested first.
 */
import type { UserAction } from '../core/registries/event-bus';
import type {
	BeginRendering,
	SurfaceUpdate,
	DataModelUpdate,
	DeleteSurface
} from '../core/types';
import type { A2UIClientCapabilities } from '../core/catalog-selection';
import type { A2UIClientDataModel } from '../core/client-data-model';

/**
 * The four server→client message kinds (per
 * `server_to_client.json`). The legacy umbrella name `ClientMessage` is
 * deliberately not re-used here — it reads backwards from the client's
 * perspective and `A2UIServerMessage` is what the spec actually calls these.
 */
export type A2UIServerMessage =
	| SurfaceUpdate
	| DataModelUpdate
	| BeginRendering
	| DeleteSurface;

/** Spec-canonical error event the client may send back to the server. */
export interface A2UIError {
	error: {
		code?: string;
		message: string;
		details?: Record<string, unknown>;
	};
}

/** Spec-canonical user-action event the client sends back to the server. */
export interface A2UIUserActionEvent {
	userAction: UserAction;
}

/** The two client→server event kinds (per `client_to_server.json`). */
export type A2UIClientEvent = A2UIUserActionEvent | A2UIError;

/**
 * MIME type the spec mandates for the A2A `DataPart` that carries an A2UI
 * payload. Both directions use the same type.
 */
export const A2UI_DATA_PART_MIME = 'application/json+a2ui';

/**
 * HTTP request header (or gRPC metadata key) that the A2A protocol uses to
 * signal extension activation. The value is the v0.8 extension URI.
 */
export const A2A_EXTENSIONS_HEADER = 'X-A2A-Extensions';

/** Header value for the A2UI v0.8 extension. */
export const A2UI_V0_8_EXTENSION_URI = 'https://a2ui.org/a2a-extension/a2ui/v0.8';

/**
 * Minimal shape of an A2A `DataPart` — the only `Part` kind the A2UI
 * extension uses. Other A2A part kinds (TextPart, FilePart) are not part of
 * the A2UI surface, so the library deliberately does not model them.
 */
export interface A2ADataPart {
	kind: 'data';
	mimeType: string;
	data: unknown;
}

/**
 * Minimal shape of an A2A `Message` carrying A2UI traffic. The full A2A
 * spec defines many more fields (role, taskId, contextId, …); this is the
 * subset every A2UI implementation must produce / consume.
 */
export interface A2AMessage {
	parts: A2ADataPart[];
	metadata?: Record<string, unknown>;
}

/**
 * Wrap an A2UI payload in the A2A `Message` envelope the spec mandates.
 *
 * Pass `clientCapabilities` ONLY when wrapping an outbound client→server
 * message — every such message MUST carry it in metadata (per A2UI v0.8
 * §2.1.2). Server→client messages do not need the field.
 *
 * Pass `clientDataModel` (also client→server only) to attach the v0.9
 * `a2uiClientDataModel` blob alongside the capabilities — required on every
 * message for surfaces that enabled `sendDataModel` (per A2UI v0.9). Build it
 * with `getClientDataModel` from `a2ui-svelte/core`.
 */
export function wrapA2A(
	payload: A2UIServerMessage | A2UIClientEvent,
	opts?: {
		clientCapabilities?: A2UIClientCapabilities;
		clientDataModel?: A2UIClientDataModel;
	}
): A2AMessage {
	const message: A2AMessage = {
		parts: [{ kind: 'data', mimeType: A2UI_DATA_PART_MIME, data: payload }]
	};
	const metadata: Record<string, unknown> = {};
	if (opts?.clientCapabilities) metadata.a2uiClientCapabilities = opts.clientCapabilities;
	if (opts?.clientDataModel) metadata.a2uiClientDataModel = opts.clientDataModel;
	if (Object.keys(metadata).length > 0) message.metadata = metadata;
	return message;
}

/**
 * Unwrap an A2A `Message`, returning the first A2UI `DataPart` payload it
 * carries (or `undefined` if the message has no A2UI part).
 */
export function unwrapA2A<T = A2UIServerMessage | A2UIClientEvent>(
	message: A2AMessage
): T | undefined {
	if (!message || !Array.isArray(message.parts)) return undefined;
	for (const part of message.parts) {
		if (part?.kind === 'data' && part.mimeType === A2UI_DATA_PART_MIME) {
			return part.data as T;
		}
	}
	return undefined;
}

/**
 * Provider-agnostic A2A transport for A2UI.
 *
 * Implementations adapt a concrete A2A channel (SSE, WebSocket, …) to the
 * same shape; the `<A2ASurface>` adapter subscribes one of them and routes
 * messages through `processMessage()` / the `userActionBus`.
 *
 * Lifetime: caller calls `connect()` once; the transport emits messages until
 * `close()` is called.
 */
export interface A2ATransport {
	/** Establish the A2A session. Resolves once the session is open. */
	connect(): Promise<void>;

	/**
	 * Subscribe to inbound server→client A2UI messages. The transport is
	 * responsible for unwrapping the A2A `DataPart` envelope before invoking
	 * the handler. Returns an unsubscribe function.
	 */
	onMessage(handler: (message: A2UIServerMessage) => void): () => void;

	/**
	 * Send a client→server A2UI event. The transport is responsible for
	 * wrapping the payload in an A2A `Message` whose `DataPart` carries
	 * `mimeType: "application/json+a2ui"` and whose `metadata` includes
	 * `a2uiClientCapabilities` (per spec §2.1.2 — required on EVERY outbound
	 * message, not just the first). When `getClientDataModel` is supplied,
	 * the transport additionally attaches its `a2uiClientDataModel` result to
	 * that metadata (v0.9 `sendDataModel`). Both are wired via `wrapA2A`.
	 */
	sendEvent(event: A2UIClientEvent): void;

	/** Close the session. Idempotent. */
	close(): void;
}

/**
 * Construction-time options shared by every A2A transport implementation.
 * Implementations may take additional channel-specific options on top.
 */
export interface A2ATransportOptions {
	/**
	 * Returns the current client capabilities. Called on **every** outbound
	 * send, so capabilities can evolve over the session lifetime (e.g. as
	 * dynamically-loaded catalogs come online).
	 */
	getClientCapabilities: () => A2UIClientCapabilities;

	/**
	 * Optional — returns the v0.9 `a2uiClientDataModel` to attach to outbound
	 * client→server message metadata (the full data model of every surface
	 * that enabled `sendDataModel`). Called on **every** outbound send so the
	 * model is always current; return `undefined` (or omit) when no surface
	 * opted in. Build it with `getClientDataModel(surfaceIds)` from
	 * `a2ui-svelte/core`.
	 */
	getClientDataModel?: () => A2UIClientDataModel | undefined;
}
