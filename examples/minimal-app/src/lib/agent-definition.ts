import type { AgentDefinition } from 'a2ui-svelte/agent';
import { session } from './session.svelte';

/**
 * What the agent IS — persona, surfaces, page context — declared once,
 * independent of any model or channel. Every model in the layout's picker
 * runs this same definition unchanged.
 *
 * `surfaces` is left at its default (every mounted surface), so a page just
 * mounts a `<StaticSurface>` / `<DynamicSurface>` and the agent sees it; only
 * the page's prose context has to be published by hand.
 */
export const assistant: AgentDefinition = {
	instructions: 'You are a helpful assistant demonstrating the a2ui-svelte library. Be concise.',
	contextInstructions: () => session.contextInstructions,
	mode: 'both'
};
