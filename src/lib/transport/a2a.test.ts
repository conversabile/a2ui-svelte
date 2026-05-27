import { describe, it, expect } from 'vitest';
import {
	A2UI_DATA_PART_MIME,
	A2A_EXTENSIONS_HEADER,
	A2UI_V0_8_EXTENSION_URI,
	wrapA2A,
	unwrapA2A,
	type A2UIClientEvent,
	type A2UIServerMessage
} from './a2a';

const exampleSurfaceUpdate: A2UIServerMessage = {
	surfaceUpdate: {
		surfaceId: 'main',
		components: [
			{ id: 'root', component: { Text: { text: { literalString: 'hi' } } } }
		]
	}
};

describe('A2A envelope constants', () => {
	it('declares the spec-mandated DataPart mime type', () => {
		expect(A2UI_DATA_PART_MIME).toBe('application/json+a2ui');
	});

	it('declares the v0.8 extension URI and header name', () => {
		expect(A2A_EXTENSIONS_HEADER).toBe('X-A2A-Extensions');
		expect(A2UI_V0_8_EXTENSION_URI).toBe('https://a2ui.org/a2a-extension/a2ui/v0.8');
	});
});

describe('wrapA2A / unwrapA2A', () => {
	it('wraps a server message inside a single DataPart with the mandated mimeType', () => {
		const env = wrapA2A(exampleSurfaceUpdate);
		expect(env.parts).toHaveLength(1);
		expect(env.parts[0]).toEqual({
			kind: 'data',
			mimeType: A2UI_DATA_PART_MIME,
			data: exampleSurfaceUpdate
		});
		// Server→client messages have no metadata.
		expect(env.metadata).toBeUndefined();
	});

	it('attaches a2uiClientCapabilities to metadata when supplied (required on EVERY outbound client→server message)', () => {
		const event: A2UIClientEvent = {
			userAction: {
				name: 'submit',
				surfaceId: 'main',
				sourceComponentId: 'save-btn',
				timestamp: '2026-05-27T00:00:00.000Z',
				context: {}
			}
		};
		const env = wrapA2A(event, {
			clientCapabilities: {
				supportedCatalogIds: ['https://a2ui.org/specification/v0_8/standard_catalog_definition.json']
			}
		});
		expect(env.metadata).toEqual({
			a2uiClientCapabilities: {
				supportedCatalogIds: [
					'https://a2ui.org/specification/v0_8/standard_catalog_definition.json'
				]
			}
		});
		expect(env.parts[0].data).toEqual(event);
	});

	it('round-trips through unwrapA2A', () => {
		const env = wrapA2A(exampleSurfaceUpdate);
		const unwrapped = unwrapA2A<A2UIServerMessage>(env);
		expect(unwrapped).toEqual(exampleSurfaceUpdate);
	});

	it('returns undefined when the message has no A2UI DataPart', () => {
		expect(
			unwrapA2A({
				parts: [{ kind: 'data', mimeType: 'application/json', data: { foo: 1 } }]
			})
		).toBeUndefined();
		expect(unwrapA2A({ parts: [] })).toBeUndefined();
	});
});
