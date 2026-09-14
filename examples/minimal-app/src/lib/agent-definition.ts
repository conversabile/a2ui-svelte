import type { AgentDefinition } from 'a2ui-svelte/agent';
import { mountedSurfaces } from 'a2ui-svelte/core';
import { session } from './session.svelte';

/**
 * What the agent IS — persona, surfaces, page context — declared once,
 * independent of any model or channel. Every model in the layout's picker
 * runs this same definition unchanged.
 *
 * `surfaces` is the library's own index of mounted surfaces, so a page just
 * mounts a `<StaticSurface>` / `<DynamicSurface>` and the agent sees it; only
 * the page's prose context has to be published by hand.
 */
export const assistant: AgentDefinition = {
	instructions: 'You are a helpful assistant demonstrating the a2ui-svelte library. Be concise.',
	surfaces: mountedSurfaces,
	contextInstructions: () => session.contextInstructions,
	mode: 'both'
};
