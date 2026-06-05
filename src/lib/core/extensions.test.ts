import { describe, it, expect } from 'vitest';
import {
	A2UI_EXTENSION_NAMESPACE,
	ALL_EXTRAS,
	STRICT,
	readExtension,
	resolveExtensionOptions,
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
			toolResultExtras: false,
			pointerTool: false
		});
	});

	it('ALL_EXTRAS enables every extension', () => {
		expect(ALL_EXTRAS).toEqual({
			surfaceWatch: true,
			batchTools: true,
			toolResultExtras: true,
			pointerTool: true
		});
	});

	it('resolveExtensionOptions defaults missing keys to ALL_EXTRAS', () => {
		expect(resolveExtensionOptions(undefined)).toEqual(ALL_EXTRAS);
		expect(resolveExtensionOptions({ surfaceWatch: false })).toEqual({
			...ALL_EXTRAS,
			surfaceWatch: false
		});
	});
});
