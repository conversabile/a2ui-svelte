<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { processMessage } from '../core/processor';
	import { userActionBus, type UserAction } from '../core/registries/event-bus';
	import { a2uiState } from '../core/state.svelte';
	import { serializeSurface } from '../core/serializer';
	import { setCatalog, type Catalog } from '../authoring/catalog';
	import { DEFAULT_CATALOG } from '../components/default-catalog';
	import {
		STANDARD_CATALOG_ID,
		STANDARD_CATALOG_ALIAS
	} from '../core/catalog-selection';
	import type { A2ATransport, A2UIServerMessage } from '../transport/a2a';
	import Component from './Component.svelte';
	import './styles.css';

	/**
	 * Spec-aligned A2UI surface adapter. Subscribes an `A2ATransport` to the
	 * library's `processMessage()` (so all four server→client messages —
	 * `surfaceUpdate`, `beginRendering`, `dataModelUpdate`, `deleteSurface` —
	 * arrive at `a2uiState`), and forwards client→server `userAction` events
	 * raised by interactive components through `transport.sendEvent()`.
	 *
	 * Sibling of `<StaticSurface>` (host-driven UI) and `<DynamicSurface>`
	 * (voice / dynamic mode). Use this when integrating with an A2UI-driving
	 * agent over the network, per the v0.8 spec's "typically transported over
	 * SSE" pattern.
	 */
	interface Props {
		surfaceId: string;
		transport: A2ATransport;
		/** Fallback catalog when no `catalogs` registry entry matches. */
		catalog?: Catalog;
		/**
		 * Catalogs registry keyed by URI. The standard-catalog URI
		 * (`STANDARD_CATALOG_ID`) is the recommended key for the built-in
		 * catalog; `'standard'` is also accepted.
		 */
		catalogs?: Record<string, Catalog>;
	}

	let { surfaceId, transport, catalog = DEFAULT_CATALOG, catalogs }: Props = $props();

	let surface = $derived(a2uiState.getSurface(surfaceId));

	const resolvedCatalog = $derived.by<Catalog>(() => {
		const id = surface?.catalogId;
		if (id && catalogs?.[id]) return catalogs[id];
		return (
			catalogs?.[STANDARD_CATALOG_ID] ??
			catalogs?.[STANDARD_CATALOG_ALIAS] ??
			catalog
		);
	});

	setCatalog(() => resolvedCatalog);

	let unsubMessages: (() => void) | null = null;
	let unsubActions: (() => void) | null = null;

	// Forward EVERY userAction raised on this surface back through the
	// transport. (Other surfaces in the same app — e.g. a static surface
	// running alongside — keep going through their own channel.)
	function forwardUserAction(action: UserAction) {
		if (action.surfaceId !== surfaceId) return;
		try {
			transport.sendEvent({ userAction: action });
		} catch (e) {
			console.warn('[A2ASurface] Failed to forward userAction:', e);
		}
	}

	// Route server→client messages through the standard processor.
	// `processMessage` already dispatches all four kinds (surfaceUpdate,
	// beginRendering, dataModelUpdate, deleteSurface).
	function handleServerMessage(message: A2UIServerMessage) {
		processMessage(message as never);
	}

	onMount(() => {
		unsubMessages = transport.onMessage(handleServerMessage);
		unsubActions = userActionBus.subscribe(forwardUserAction);

		// Best-effort `connect()` — implementations are free to no-op if the
		// host already connected the transport before mount.
		void transport.connect().catch((e) => {
			console.error('[A2ASurface] Transport connect failed:', e);
		});
	});

	onDestroy(() => {
		try {
			unsubMessages?.();
		} catch {
			// best-effort
		}
		try {
			unsubActions?.();
		} catch {
			// best-effort
		}
		unsubMessages = null;
		unsubActions = null;
	});

	export const id = surfaceId;
	export const type = 'dynamic';
	export const getJson = () => serializeSurface(surfaceId);
</script>

<div class="a2ui-surface a2ui-a2a-surface" data-surface-id={surfaceId}>
	{#if surface && surface.isRendering && surface.rootId}
		<Component id={surface.rootId} {surfaceId} />
	{:else}
		<!-- Waiting for beginRendering... -->
	{/if}
</div>
