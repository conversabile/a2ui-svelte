import { describe, it, expect } from 'vitest';
import {
	stripDataModel,
	structuralFingerprint,
	readDataModelFromJson,
	readDataModelsBySurface,
	diffDataModel,
	diffDataModelsBySurface
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
