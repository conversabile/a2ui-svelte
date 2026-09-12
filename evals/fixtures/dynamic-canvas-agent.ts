import type { AgentDefinition } from '../../src/lib/agent/agent.svelte';
import { mountedSurfaces } from '../../src/lib/core/registries/surface-index';

/**
 * The dynamic canvas's agent: an empty surface the model fills at runtime, so
 * there is no page context to publish — the tree it builds is the context.
 */
export const dynamicCanvas: AgentDefinition = {
	instructions:
		'You are a UI-building assistant. Render what the user asks for on the dynamic surface ' +
		'using the A2UI tools. Be concise in your replies.',
	surfaces: mountedSurfaces,
	mode: 'dynamic'
};
