import { render } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mountedSurfaces } from '../core/registries/surface-index';
import { validateSurface } from '../core/validate-surface';
import OrphanSurface from './__fixtures__/OrphanSurface.svelte';
import OffConventionSurface from './__fixtures__/OffConventionSurface.svelte';
import FieldSurface from './__fixtures__/FieldSurface.svelte';
import LifecycleSurface from './__fixtures__/LifecycleSurface.svelte';
import UnboundInputsHarness from '../authoring/__fixtures__/UnboundInputsHarness.svelte';
import ValueComponentsHarness from '../components/__fixtures__/ValueComponentsHarness.svelte';
import ButtonActionHarness from '../components/__fixtures__/ButtonActionHarness.svelte';
import TextFieldWritabilityHarness from '../components/__fixtures__/TextFieldWritabilityHarness.svelte';

describe('StaticSurface validation on mount', () => {
	beforeEach(() => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());

	it('mounts a compliant surface silently', () => {
		expect(() => render(FieldSurface, { surfaceId: 'clean', prefix: 'a' })).not.toThrow();
		expect(console.warn).not.toHaveBeenCalled();
		expect(console.error).not.toHaveBeenCalled();
	});

	it('throws when the tree the agent would read is broken', () => {
		expect(() => render(OrphanSurface)).toThrow(/not reachable from the root/);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ghost-node'));
	});

	it('warns without throwing when the surface is legal but off-convention', () => {
		expect(() => render(OffConventionSurface)).not.toThrow();
		expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('id is not kebab-case'));
	});
});

/**
 * Every static surface the repo mounts, validated through the same function
 * `pnpm test` would use in CI — warnings included, so a serializer regression
 * that only costs a convention still shows up here.
 */
describe('repo fixtures are A2UI-compliant', () => {
	const fixtures: Array<[string, unknown, Record<string, unknown>]> = [
		['FieldSurface', FieldSurface, { surfaceId: 'fx-field', prefix: 'fx' }],
		['LifecycleSurface', LifecycleSurface, { surfaceId: 'fx-life', buttonId: 'fx-btn' }],
		['UnboundInputsHarness', UnboundInputsHarness, { onReady: () => {} }],
		['ValueComponentsHarness', ValueComponentsHarness, { onReady: () => {} }],
		['ButtonActionHarness', ButtonActionHarness, { onReady: () => {} }],
		['TextFieldWritabilityHarness', TextFieldWritabilityHarness, { onReady: () => {} }]
	];

	for (const [name, component, props] of fixtures) {
		it(`${name} serializes a clean surface`, () => {
			render(component as never, props as never);
			const surfaces = mountedSurfaces();
			expect(surfaces.length).toBeGreaterThan(0);
			for (const surface of surfaces) {
				expect({ [surface.id]: validateSurface(surface.getJson()) }).toEqual({ [surface.id]: [] });
			}
		});
	}
});
