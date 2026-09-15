import { describe, it, expect } from 'vitest';
import {
	stripDataModel,
	structuralFingerprint,
	readDataModelFromJson,
	readDataModelsBySurface,
	diffDataModel,
	diffDataModelsBySurface,
	snapshotSurface,
	snapshotSurfaces,
	snapshotFingerprint,
	diffSurfaces
} from './surface-snapshot';

const staticSurface = (id: string, dataModel: Array<{ key: string; valueString: string }>) => ({
	surfaceId: id,
	rootId: 'root',
	components: [{ id: 'root', component: { Column: { children: { explicitList: [] } } } }],
	...(dataModel.length > 0 ? { dataModel } : {})
});

describe('surface-snapshot', () => {
	it('stripDataModel removes static dataModel and dynamic data, keeps structure', () => {
		expect(stripDataModel({ surfaceId: 's', components: [], dataModel: [{ key: 'a' }] })).toEqual({
			surfaceId: 's',
			components: []
		});
		expect(stripDataModel({ surfaceId: 's', components: [], data: { a: 1 } })).toEqual({
			surfaceId: 's',
			components: []
		});
		expect(stripDataModel('not-an-object')).toBe('not-an-object');
	});

	it('structuralFingerprint is value-independent but structure-sensitive', () => {
		const a = staticSurface('s', [{ key: 'name', valueString: 'John' }]);
		const b = staticSurface('s', [{ key: 'name', valueString: 'Jane' }]);
		expect(structuralFingerprint([a])).toBe(structuralFingerprint([b]));

		const c = staticSurface('s', []);
		(c.components as unknown[]).push({ id: 'extra', component: { Text: {} } });
		expect(structuralFingerprint([a])).not.toBe(structuralFingerprint([c]));
	});

	it('readDataModelFromJson reads the static array and the dynamic object shapes', () => {
		expect(readDataModelFromJson(staticSurface('s', [{ key: 'name', valueString: 'John' }]))).toEqual(
			{ name: 'John' }
		);
		expect(readDataModelFromJson({ surfaceId: 'd', data: { name: 'John' } })).toEqual({
			name: 'John'
		});
		expect(readDataModelFromJson(null)).toEqual({});
	});

	it('readDataModelsBySurface keys by surfaceId and omits empty models', () => {
		const out = readDataModelsBySurface([
			staticSurface('a', [{ key: 'x', valueString: '1' }]),
			staticSurface('b', [])
		]);
		expect(out).toEqual({ a: { x: '1' } });
	});

	it('diffDataModel reports changed and cleared entries only', () => {
		expect(diffDataModel({ a: '1', b: '2' }, { a: '1', b: '', c: '3' })).toEqual({
			b: '',
			c: '3'
		});
		expect(diffDataModel({ a: '1' }, { a: '1' })).toEqual({});
	});

	it('diffDataModelsBySurface only includes surfaces with changes', () => {
		const prev = { s1: { a: '1' }, s2: { b: '2' } };
		const next = { s1: { a: '1' }, s2: { b: '9' } };
		expect(diffDataModelsBySurface(prev, next)).toEqual({ s2: { b: '9' } });
	});
});

describe('per-component surface diff', () => {
	const surface = (
		surfaceId: string,
		components: Array<{ id: string; component: unknown }>,
		dataModel?: Array<{ key: string; valueString: string }>
	) => ({
		surfaceId,
		rootId: 'root',
		components,
		...(dataModel ? { dataModel } : {})
	});

	const text = (id: string, value: string) => ({
		id,
		component: { Text: { text: { literalString: value }, usageHint: 'caption' } }
	});

	/** A surface big enough that a one-component delta stays under the ratio. */
	const planning = (total: string, shift = '09:00-15:00') =>
		surface(
			'planning',
			[
				{ id: 'root', component: { Column: { children: { explicitList: ['head', 'cell', 'tot'] } } } },
				text('head', 'Kitchen — week 38'),
				{ id: 'cell', component: { TextField: { text: { path: '/shift-ana' } } } },
				text('tot', total)
			],
			[{ key: 'shift-ana', valueString: shift }]
		);

	const sidebar = surface('sidebar', [
		{ id: 'root', component: { Column: { children: { explicitList: ['nav'] } } } },
		{ id: 'nav', component: { Button: { child: 'nav-label' } } },
		text('nav-label', 'Home')
	]);

	it('reports a changed Text literal as one component, and omits untouched surfaces', () => {
		const prev = snapshotSurfaces([planning('38h 00m'), sidebar]);
		const next = snapshotSurfaces([planning('44h 00m'), sidebar]);

		const diff = diffSurfaces(prev, next)!;
		expect(diff.surfaces.map((s) => s.surfaceId)).toEqual(['planning']);
		expect(diff.surfaces[0].changed).toEqual([text('tot', '44h 00m')]);
		expect(diff.surfaces[0].removed).toBeUndefined();
		expect(diff.surfaces[0].full).toBeUndefined();
		// Nothing appeared or disappeared — only an in-place edit.
		expect(diff.structural).toBe(false);
	});

	it('reports a data-model edit and a recomputed literal together, in one surface entry', () => {
		const diff = diffSurfaces(
			snapshotSurfaces([planning('38h 00m', '09:00-15:00')]),
			snapshotSurfaces([planning('44h 00m', '09:00-21:00')])
		)!;
		expect(diff.surfaces).toHaveLength(1);
		expect(diff.surfaces[0].dataModel).toEqual({ 'shift-ana': '09:00-21:00' });
		expect(diff.surfaces[0].changed).toEqual([text('tot', '44h 00m')]);
	});

	it('returns null when nothing moved', () => {
		const snap = snapshotSurfaces([planning('38h 00m'), sidebar]);
		expect(diffSurfaces(snap, snapshotSurfaces([planning('38h 00m'), sidebar]))).toBeNull();
		expect(diffSurfaces(snap, snap)).toBeNull();
	});

	it('reports an added component as changed and a removed one by id, both structural', () => {
		const before = snapshotSurfaces([planning('38h 00m')]);
		const withExtra = planning('38h 00m');
		withExtra.components.push(text('note', 'Understaffed'));
		const added = diffSurfaces(before, snapshotSurfaces([withExtra]))!;
		expect(added.surfaces[0].changed).toEqual([text('note', 'Understaffed')]);
		expect(added.structural).toBe(true);

		const removed = diffSurfaces(snapshotSurfaces([withExtra]), before)!;
		expect(removed.surfaces[0].removed).toEqual(['note']);
		expect(removed.surfaces[0].changed).toBeUndefined();
		expect(removed.structural).toBe(true);
	});

	it('sends the whole surface when a route change replaces every component', () => {
		const menu = surface('planning', [
			{ id: 'root', component: { Column: { children: { explicitList: ['m1', 'm2'] } } } },
			text('m1', 'Menu'),
			text('m2', 'Add a dish')
		]);
		const diff = diffSurfaces(snapshotSurfaces([planning('38h 00m')]), snapshotSurfaces([menu]))!;
		expect(diff.surfaces[0].full).toBe(true);
		expect(diff.surfaces[0].surface).toEqual(menu);
		expect(diff.surfaces[0].changed).toBeUndefined();
		expect(diff.surfaces[0].removed).toBeUndefined();
		expect(diff.structural).toBe(true);
	});

	it('sends a newly mounted surface whole — there is nothing to merge onto', () => {
		const diff = diffSurfaces(snapshotSurfaces([planning('38h 00m')]), snapshotSurfaces([planning('38h 00m'), sidebar]))!;
		expect(diff.surfaces).toHaveLength(1);
		expect(diff.surfaces[0]).toEqual({ surfaceId: 'sidebar', full: true, surface: sidebar });
		expect(diff.structural).toBe(true);
	});

	it('reports an unmounted surface by id only, and leaves the survivors alone', () => {
		const diff = diffSurfaces(snapshotSurfaces([planning('38h 00m'), sidebar]), snapshotSurfaces([planning('38h 00m')]))!;
		expect(diff.removedSurfaces).toEqual(['sidebar']);
		expect(diff.surfaces).toEqual([]);
		expect(diff.structural).toBe(true);
	});

	it('reports a changed rootId', () => {
		const moved = { ...planning('38h 00m'), rootId: 'other' };
		const diff = diffSurfaces(snapshotSurfaces([planning('38h 00m')]), snapshotSurfaces([moved]))!;
		expect(diff.surfaces[0].rootId).toBe('other');
	});

	it('keys by surfaceId, so reordering the surface array is not a change', () => {
		const diff = diffSurfaces(
			snapshotSurfaces([planning('38h 00m'), sidebar]),
			snapshotSurfaces([sidebar, planning('38h 00m')])
		);
		expect(diff).toBeNull();
	});

	it('snapshotSurface takes an explicit id and data model over the JSON', () => {
		const snap = snapshotSurface(planning('38h 00m'), 'handle-id', { a: '1' });
		expect(snap.surfaceId).toBe('handle-id');
		expect(snap.dataModel).toEqual({ a: '1' });
	});

	it('tolerates a surface with no components array', () => {
		const prev = snapshotSurfaces([{ surfaceId: 'x' }]);
		const next = snapshotSurfaces([{ surfaceId: 'x', components: [text('t', 'hi')] }]);
		expect(diffSurfaces(prev, next)!.surfaces[0].full).toBe(true);
		expect(diffSurfaces(next, prev)!.surfaces[0].removed).toEqual(['t']);
	});

	it('snapshotFingerprint is equal iff nothing moved', () => {
		const a = snapshotSurfaces([planning('38h 00m')]);
		expect(snapshotFingerprint(a)).toBe(snapshotFingerprint(snapshotSurfaces([planning('38h 00m')])));
		expect(snapshotFingerprint(a)).not.toBe(snapshotFingerprint(snapshotSurfaces([planning('44h 00m')])));
		// A data-model-only edit moves it too — the whole point of the rewrite.
		expect(snapshotFingerprint(a)).not.toBe(
			snapshotFingerprint(snapshotSurfaces([planning('38h 00m', '10:00-16:00')]))
		);
	});
});
