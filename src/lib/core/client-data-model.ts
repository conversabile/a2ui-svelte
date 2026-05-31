/**
 * A2UI v0.9 client → server data-model synchronization.
 *
 * v0.9 adds `createSurface.sendDataModel`: when a surface opts in, the client
 * attaches that surface's **entire current data model** to the `metadata` of
 * every client→server message (a `userAction` or a user query), so the agent
 * that owns the surface sees the up-to-date UI state alongside the user's
 * input. The payload follows `client_data_model.json`:
 *
 *   a2uiClientDataModel = { version: "v0.9", surfaces: { [surfaceId]: <dataModel> } }
 *
 * This is the **A2A / true-compliance** path. It lives out-of-band in message
 * metadata and replaces the prior copy each time, so the full model is sent
 * (no deltas). The voice transport can't use metadata (a live audio API has no
 * such side-channel and attaching at speech time interrupts the answer), so it
 * synchronises the same `{ fieldId → value }` unit via in-band deltas instead —
 * see `VoiceAgent`'s `'sync'` mode and the surface-data-model-sync plan.
 *
 * @see ~/lavoro/A2UI/specification/v0_9/json/client_data_model.json
 * @see ~/lavoro/A2UI/specification/v0_9/docs/a2ui_protocol.md
 *      §"Data model updates: synchronization and convergence"
 */
import { a2uiState } from './state.svelte';

/**
 * The `a2uiClientDataModel` metadata blob (per `client_data_model.json`). On
 * A2A it is placed in the `metadata` field of every outbound client→server
 * `Message` for surfaces with `sendDataModel` enabled, next to
 * `a2uiClientCapabilities`.
 */
export interface A2UIClientDataModel {
	version: 'v0.9';
	/** Map of surface id → that surface's current data model (a plain object). */
	surfaces: Record<string, Record<string, unknown>>;
}

/**
 * Build the `a2uiClientDataModel` payload for an A2A handshake from the live
 * surface state. The result is suitable for direct injection into A2A message
 * metadata under the `a2uiClientDataModel` key (via `wrapA2A`'s
 * `clientDataModel` option).
 *
 * Per spec only surfaces that enabled `sendDataModel` send their model — our
 * v0.8-rooted renderer doesn't store that flag, so the **caller's list of
 * surface ids is the opt-in**: pass the ids of the surfaces that should sync.
 * Each existing surface contributes its full current data model (`{}` when it
 * has none yet); ids with no live surface are skipped.
 *
 * @param surfaceIds Surfaces that opted into `sendDataModel`.
 */
export function getClientDataModel(surfaceIds: string[]): A2UIClientDataModel {
	const surfaces: Record<string, Record<string, unknown>> = {};
	for (const id of surfaceIds) {
		const surface = a2uiState.getSurface(id);
		if (surface) surfaces[id] = surface.data ?? {};
	}
	return { version: 'v0.9', surfaces };
}
