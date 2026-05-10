/**
 * Shared reactive store for GeminiLive session configuration.
 * Pages set surfaces and contextInstructions here; the layout reads them
 * and passes them to the single GeminiLive instance.
 *
 * TODO(phase-2): decouple from app store — this is a temporary copy that
 * lives in the library until Phase 2 removes the coupling in StaticSurface.
 */
function createGeminiSession() {
	let surfaces = $state<any[]>([]);
	let contextInstructions = $state('');

	return {
		get surfaces() { return surfaces; },
		set surfaces(v: any[]) { surfaces = v; },
		get contextInstructions() { return contextInstructions; },
		set contextInstructions(v: string) { contextInstructions = v; },
	};
}

export const geminiSession = createGeminiSession();
