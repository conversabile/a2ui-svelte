/**
 * Tiny session store. The library doesn't dictate the store shape —
 * this is the minimal version that satisfies the `surfaces()` /
 * `contextInstructions()` callbacks the layout passes to VoiceAgent.
 */
export interface SurfaceEntry {
	id: string;
	type: 'static' | 'dynamic';
	getJson: () => unknown;
}

function createSession() {
	let surfaces = $state<SurfaceEntry[]>([]);
	let contextInstructions = $state('');

	return {
		get surfaces() {
			return surfaces;
		},
		set surfaces(v: SurfaceEntry[]) {
			surfaces = v;
		},
		get contextInstructions() {
			return contextInstructions;
		},
		set contextInstructions(v: string) {
			contextInstructions = v;
		}
	};
}

export const session = createSession();
