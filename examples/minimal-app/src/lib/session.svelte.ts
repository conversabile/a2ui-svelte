/**
 * Tiny page-context store. The surfaces themselves need no store — the library
 * tracks them (`mountedSurfaces()` from `a2ui-svelte/core`) — so this holds
 * only the prose each page wants the agent to know while it is open.
 */
function createSession() {
	let contextInstructions = $state('');

	return {
		get contextInstructions() {
			return contextInstructions;
		},
		set contextInstructions(v: string) {
			contextInstructions = v;
		}
	};
}

export const session = createSession();
