import { describe, it, expect } from 'vitest';
import { validateSurface, STANDARD_CATALOG_TYPES, formatSurfaceIssues } from './validate-surface';
import { DEFAULT_CATALOG } from '../components/default-catalog';

function comp(id: string, type: string, props: Record<string, unknown> = {}) {
	return { id, component: { [type]: props } };
}

function surface(components: Array<{ id: string; component: object }>, rootId = 'root') {
	return { surfaceId: 'test', rootId, components };
}

const messages = (json: unknown) => validateSurface(json).map((i) => i.message);
const errors = (json: unknown) =>
	validateSurface(json)
		.filter((i) => i.severity === 'error')
		.map((i) => i.message);
const warnings = (json: unknown) =>
	validateSurface(json)
		.filter((i) => i.severity === 'warning')
		.map((i) => i.message);

describe('validateSurface', () => {
	it('accepts a well-formed surface', () => {
		const json = surface([
			comp('root', 'Column', { children: { explicitList: ['card-1'] } }),
			comp('card-1', 'Card', { child: 'body' }),
			comp('body', 'Row', { children: { explicitList: ['label', 'save-btn'] } }),
			comp('label', 'Text', { text: { literalString: 'Hello' } }),
			comp('save-btn', 'Button', { child: 'save-label', action: { name: 'save-btn' } }),
			comp('save-label', 'Text', { text: { literalString: 'Save' } })
		]);
		expect(validateSurface(json)).toEqual([]);
	});

	it('rejects non-object input and missing top-level fields', () => {
		expect(messages(null)).toContain('surface JSON is not an object');
		expect(messages({})).toEqual(
			expect.arrayContaining(['missing surfaceId', 'missing rootId', 'components is not an array'])
		);
	});

	it('warns — does not error — on an unknown component type', () => {
		const json = surface([
			comp('root', 'Column', { children: { explicitList: ['x'] } }),
			comp('x', 'FancyGrid')
		]);
		expect(warnings(json)).toContain('unknown component type "FancyGrid" (not in catalog)');
		expect(errors(json)).toEqual([]);
	});

	it('accepts a custom catalog type when the catalog is passed', () => {
		const json = surface([
			comp('root', 'Column', { children: { explicitList: ['x'] } }),
			comp('x', 'FancyGrid')
		]);
		const custom = new Set([...STANDARD_CATALOG_TYPES, 'FancyGrid']);
		expect(validateSurface(json, { catalog: custom })).toEqual([]);
	});

	it('warns on an empty single-child slot, errors on a malformed one', () => {
		const empty = surface([
			comp('root', 'Column', { children: { explicitList: ['card-1'] } }),
			comp('card-1', 'Card', {})
		]);
		expect(warnings(empty)).toContain('Card has no `child` (an empty Card shows nothing)');
		expect(errors(empty)).toEqual([]);

		const malformed = surface([
			comp('root', 'Column', { children: { explicitList: ['card-1'] } }),
			comp('card-1', 'Card', { child: ['a', 'b'] })
		]);
		expect(errors(malformed)).toContain(
			'Card must have a single string `child` (wrap multiples in a Column/Row)'
		);
	});

	it('errors on a container without children and on a dangling reference', () => {
		const json = surface([
			comp('root', 'Column', { children: { explicitList: ['row-1'] } }),
			comp('row-1', 'Row', {})
		]);
		expect(errors(json)).toContain('Row has no children property');

		const dangling = surface([comp('root', 'Column', { children: { explicitList: ['ghost'] } })]);
		expect(errors(dangling)).toContain('references missing component "ghost"');
	});

	it('errors on duplicate ids', () => {
		const json = surface([
			comp('root', 'Column', { children: { explicitList: ['a'] } }),
			comp('a', 'Text'),
			comp('a', 'Text')
		]);
		expect(validateSurface(json)).toContainEqual({
			componentId: 'a',
			message: 'duplicate component id',
			severity: 'error',
			scope: 'shape'
		});
	});

	it('errors on an orphan component (screen/tree parity)', () => {
		const json = surface([
			comp('root', 'Column', { children: { explicitList: [] } }),
			comp('hidden-note', 'Text', { text: { literalString: 'agent-only' } })
		]);
		expect(validateSurface(json)).toContainEqual({
			componentId: 'hidden-note',
			message: 'component is not reachable from the root (orphan)',
			severity: 'error',
			scope: 'wiring'
		});
	});

	it('warns on a non-kebab id, including the root', () => {
		const json = surface(
			[
				comp('Main_Root', 'Column', { children: { explicitList: ['todo_notes'] } }),
				comp('todo_notes', 'Text')
			],
			'Main_Root'
		);
		const nonKebab = validateSurface(json).filter((i) => i.message === 'id is not kebab-case');
		expect(nonKebab.map((i) => i.componentId).sort()).toEqual(['Main_Root', 'todo_notes']);
		expect(nonKebab.every((i) => i.severity === 'warning')).toBe(true);
	});

	it('leaves an agent-chosen action.name alone', () => {
		const json = surface([
			comp('root', 'Column', { children: { explicitList: ['save-btn'] } }),
			comp('save-btn', 'Button', { child: 'lbl', action: { name: 'do_something' } }),
			comp('lbl', 'Text')
		]);
		expect(validateSurface(json)).toEqual([]);
	});

	it('validates Modal and Tabs child references', () => {
		const json = surface([
			comp('root', 'Column', { children: { explicitList: ['modal-1', 'tabs-1'] } }),
			comp('modal-1', 'Modal', { entryPointChild: 'open-btn', contentChild: 'nope' }),
			comp('open-btn', 'Button', { child: 'open-lbl' }),
			comp('open-lbl', 'Text'),
			comp('tabs-1', 'Tabs', { tabItems: [{ title: { literalString: 't' }, child: 'missing-tab' }] })
		]);
		const msgs = messages(json);
		expect(msgs).toContain('references missing component "nope"');
		expect(msgs).toContain('references missing component "missing-tab"');
	});

	it('scopes the checks that need a finished tree as `wiring`', () => {
		// The half-sent tree a `surfaceUpdate` carries before `beginRendering`:
		// no root, children still missing. Every complaint must be `wiring`, so
		// the dynamic path can accept it and re-check at `beginRendering`.
		const partial = {
			surfaceId: 'test',
			components: [comp('main-col', 'Column', { children: { explicitList: ['later'] } })]
		};
		const shape = validateSurface(partial).filter((i) => i.scope === 'shape');
		expect(shape).toEqual([]);
		expect(validateSurface(partial).map((i) => i.message)).toEqual(
			expect.arrayContaining(['missing rootId', 'references missing component "later"'])
		);
	});

	it('flags a malformed envelope whether or not the tree is finished', () => {
		const partial = {
			surfaceId: 'test',
			components: [{ id: 'two-types', component: { Text: {}, Button: {} } }]
		};
		const shape = validateSurface(partial).filter((i) => i.scope === 'shape');
		expect(shape.map((i) => i.message)).toContain(
			'component envelope must have exactly one type key, got [Text, Button]'
		);
	});

	it('knows exactly the types the default catalog renders', () => {
		expect([...STANDARD_CATALOG_TYPES].sort()).toEqual(Object.keys(DEFAULT_CATALOG).sort());
	});

	it('formats issues one readable line each', () => {
		const json = surface([comp('root', 'Column', { children: { explicitList: ['ghost'] } })]);
		expect(formatSurfaceIssues(validateSurface(json))).toContain(
			'  - [root] references missing component "ghost"'
		);
	});
});
