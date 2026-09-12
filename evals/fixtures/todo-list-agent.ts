import type { AgentDefinition } from '../../src/lib/agent/agent.svelte';
import { mountedSurfaces } from '../../src/lib/core/registries/surface-index';

/**
 * The todo list's agent — persona, surfaces, page context — declared once and
 * imported by every eval, the shape a consumer app should use (a page mounts
 * the surface, the definition names the persona; nothing wires the two
 * together by hand).
 *
 * The evals only ever override `compactSurfaceJson`, which is the experiment's
 * variable, not the app's.
 */

/**
 * The page's live prose context. `<TodoListPage>` installs its reader while it
 * mounts; the definition calls it whenever the agent asks. A reader, not a
 * written value, so the context is never stale against the page state and
 * never depends on an effect having flushed.
 */
export const todoContext = { read: (): string => '' };

export const todoList: AgentDefinition = {
	instructions:
		'You are the assistant for a personal todo list. ' +
		'You operate the on-screen UI through the available tools. Be concise.',
	surfaces: mountedSurfaces,
	contextInstructions: () => todoContext.read(),
	mode: 'static'
};
