import { render, fireEvent } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import DynamicSurface from './DynamicSurface.svelte';
import { DEFAULT_CATALOG } from '../components/default-catalog';
import { a2uiState } from '../core/state.svelte';
import { processMessage } from '../core/processor';
import { userActionBus, type UserAction } from '../core/registries/event-bus';

describe('Dynamic surface rendering', () => {
    it('renders a Column with Text child', () => {
        a2uiState.getOrCreateSurface('test-col');
        a2uiState.updateComponent('test-col', 'col-1', {
            type: 'Column',
            properties: { children: { explicitList: ['txt-1'] } }
        });
        a2uiState.updateComponent('test-col', 'txt-1', {
            type: 'Text',
            properties: { text: { literalString: 'hello world' } }
        });
        a2uiState.setRoot('test-col', 'col-1');

        const { getByText } = render(DynamicSurface, { surfaceId: 'test-col', catalog: DEFAULT_CATALOG });
        expect(getByText('hello world')).toBeTruthy();
    });

    it('reacts to surface updates that arrive AFTER mount', async () => {
        const { findByText } = render(DynamicSurface, { surfaceId: 'late-surface', catalog: DEFAULT_CATALOG });
        // Surface does not yet exist when DynamicSurface mounts; the runtime should react
        // when processMessage / state updates arrive later from the voice agent.
        a2uiState.updateComponent('late-surface', 'col-1', {
            type: 'Column',
            properties: { children: { explicitList: ['txt-1'] } }
        });
        a2uiState.updateComponent('late-surface', 'txt-1', {
            type: 'Text',
            properties: { text: { literalString: 'late hello' } }
        });
        a2uiState.setRoot('late-surface', 'col-1');

        const txt = await findByText('late hello', undefined, { timeout: 1000 });
        expect(txt).toBeTruthy();
    });

    it('reacts to agent-shaped processMessage calls (mirrors VoiceAgent flow)', async () => {
        const { findByText } = render(DynamicSurface, { surfaceId: 'agent-flow', catalog: DEFAULT_CATALOG });

        // This is the exact shape the VoiceAgent passes to processMessage when
        // the agent emits surfaceUpdate / beginRendering tool calls.
        processMessage({
            surfaceUpdate: {
                surfaceId: 'agent-flow',
                components: [
                    { id: 'main-col', component: { Column: { children: { explicitList: ['example-button'] } } } },
                    { id: 'example-button', component: { Button: { child: 'button-label', action: { name: 'do_something' } } } },
                    { id: 'button-label', component: { Text: { text: { literalString: 'Click me' } } } }
                ]
            }
        } as never);
        processMessage({ beginRendering: { surfaceId: 'agent-flow', root: 'main-col' } } as never);

        const btn = await findByText('Click me', undefined, { timeout: 1000 });
        expect(btn).toBeTruthy();
    });

    it('emits userAction when a dynamic Button is clicked', async () => {
        const events: UserAction[] = [];
        const unsubscribe = userActionBus.subscribe((a) => events.push(a));

        a2uiState.getOrCreateSurface('test-btn');
        a2uiState.updateComponent('test-btn', 'col-1', {
            type: 'Column',
            properties: { children: { explicitList: ['btn-1'] } }
        });
        a2uiState.updateComponent('test-btn', 'btn-1', {
            type: 'Button',
            properties: {
                child: 'btn-label',
                action: { name: 'go_yes' }
            }
        });
        a2uiState.updateComponent('test-btn', 'btn-label', {
            type: 'Text',
            properties: { text: { literalString: 'Yes' } }
        });
        a2uiState.setRoot('test-btn', 'col-1');

        const { getByText } = render(DynamicSurface, { surfaceId: 'test-btn', catalog: DEFAULT_CATALOG });
        const btn = getByText('Yes');
        await fireEvent.click(btn);
        unsubscribe();

        expect(events.length).toBe(1);
        expect(events[0].name).toBe('go_yes');
        expect(events[0].sourceComponentId).toBe('btn-1');
        expect(events[0].surfaceId).toBe('test-btn');
        expect(typeof events[0].timestamp).toBe('string');
        expect(Number.isNaN(Date.parse(events[0].timestamp))).toBe(false);
    });
});
