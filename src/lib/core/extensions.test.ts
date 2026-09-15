import { describe, it, expect, afterEach } from 'vitest';
import {
	A2UI_EXTENSION_NAMESPACE,
	ALL_EXTRAS,
	STRICT,
	configureExtensions,
	getExtensions,
	readExtension,
	wrapExtension
} from './extensions';

describe('extensions envelope', () => {
	it('wraps a payload under the given namespace', () => {
		const wrapped = wrapExtension(A2UI_EXTENSION_NAMESPACE, { kind: 'x' });
		expect(wrapped).toEqual({
			extensions: { 'a2ui-svelte': { kind: 'x' } }
		});
	});

	it('reads a payload back out of an envelope', () => {
		const wrapped = wrapExtension(A2UI_EXTENSION_NAMESPACE, { kind: 'x', n: 1 });
		expect(readExtension<{ kind: string; n: number }>(wrapped, A2UI_EXTENSION_NAMESPACE)).toEqual(
			{ kind: 'x', n: 1 }
		);
	});

	it('returns undefined when the namespace is absent', () => {
		expect(readExtension({}, A2UI_EXTENSION_NAMESPACE)).toBeUndefined();
		expect(readExtension({ extensions: {} }, A2UI_EXTENSION_NAMESPACE)).toBeUndefined();
		expect(readExtension(null, A2UI_EXTENSION_NAMESPACE)).toBeUndefined();
	});
});

describe('extension presets', () => {
	it('STRICT disables every extension', () => {
		expect(STRICT).toEqual({
			surfaceWatch: false,
			batchTools: false,
			toolResultSurfaceEcho: 'none',
			pointerTool: false
		});
	});

	it('ALL_EXTRAS enables every extension, with the diff echo', () => {
		expect(ALL_EXTRAS).toEqual({
			surfaceWatch: true,
			batchTools: true,
			toolResultSurfaceEcho: 'delta',
			pointerTool: true
		});
	});
});

describe("toolResultSurfaceEcho: the 'changed' alias", () => {
	afterEach(() => configureExtensions({}));

	it("normalises the deprecated 'changed' to 'delta', so nothing downstream sees it", () => {
		configureExtensions({ toolResultSurfaceEcho: 'changed' });
		expect(getExtensions().toolResultSurfaceEcho).toBe('delta');
	});

	it('leaves the other two spellings alone', () => {
		configureExtensions({ toolResultSurfaceEcho: 'full' });
		expect(getExtensions().toolResultSurfaceEcho).toBe('full');
		configureExtensions({ toolResultSurfaceEcho: 'none' });
		expect(getExtensions().toolResultSurfaceEcho).toBe('none');
	});

	it('an app configured with the old spelling still gets the delta behaviour', () => {
		configureExtensions({ toolResultSurfaceEcho: 'changed' });
		expect(getExtensions()).toEqual(ALL_EXTRAS);
	});
});

describe('the app-wide extension record', () => {
	afterEach(() => configureExtensions({}));

	it('is ALL_EXTRAS until configured', () => {
		expect(getExtensions()).toEqual(ALL_EXTRAS);
	});

	it('merges a partial over ALL_EXTRAS', () => {
		configureExtensions({ toolResultSurfaceEcho: 'full' });
		expect(getExtensions()).toEqual({ ...ALL_EXTRAS, toolResultSurfaceEcho: 'full' });
	});

	it('is an absolute set, not an accumulation — {} restores the defaults', () => {
		configureExtensions(STRICT);
		expect(getExtensions()).toEqual(STRICT);
		configureExtensions({ batchTools: false });
		expect(getExtensions()).toEqual({ ...ALL_EXTRAS, batchTools: false });
		configureExtensions({});
		expect(getExtensions()).toEqual(ALL_EXTRAS);
	});
});
