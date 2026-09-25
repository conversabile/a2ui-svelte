import { describe, it, expect, vi, afterEach } from 'vitest';
import { flushSync } from 'svelte';
import { render, fireEvent } from '@testing-library/svelte';
import AgentShell from './AgentShell.svelte';
import { Agent } from './agent.svelte';
import { ScriptedModel } from './scripted-model';
import { toolRegistry } from '../core/registries/tool-registry';
import type {
	AgentModel,
	AgentModelConnectOptions,
	AgentModelEventMap,
	AgentModelCapabilities
} from './model';

// ScriptedModel defers its emits to a microtask; a macrotask hop settles it.
const flush = () =>
	vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(0) : new Promise((r) => setTimeout(r, 0));

function makeAgent(reactions: ConstructorParameters<typeof ScriptedModel>[0]): Agent {
	return new Agent(
		{
			instructions: 'persona',
			surfaces: () => []
		},
		new ScriptedModel(reactions)
	);
}

// A do-nothing model advertising the voice profile, so the shell renders
// its audio affordances (mic + mute) purely from capabilities — without ever
// opening a session (no recorder, no Web Audio in jsdom).
class AudioCapableModel implements AgentModel {
	get capabilities(): AgentModelCapabilities {
		return {
			streaming: true,
			interruptible: true,
			silentContext: true,
			historyOwnership: 'server',
			canInitiateTurn: true,
			input: ['audio', 'text'],
			output: ['audio', 'text']
		};
	}
	async connect(_opts: AgentModelConnectOptions) {}
	sendText(_text: string) {}
	sendAudioChunk(_b64: string) {}
	sendToolResult(_id: string, _name: string, _result: unknown) {}
	on<E extends keyof AgentModelEventMap>(
		_event: E,
		_handler: (p: AgentModelEventMap[E]) => void
	): () => void {
		return () => {};
	}
	close() {}
}

async function sendMessage(container: HTMLElement, text: string) {
	const input = container.querySelector('input[type="text"]') as HTMLInputElement;
	const form = container.querySelector('form') as HTMLFormElement;
	await fireEvent.input(input, { target: { value: text } });
	await fireEvent.submit(form);
	await flush();
}

describe('AgentShell', () => {
	it('typing a message sends it and renders both the user turn and the model reply', async () => {
		const agent = makeAgent([{ on: 'hello', text: 'Hi there.' }]);
		const { container, findByText } = render(AgentShell, { agent });

		await sendMessage(container, 'hello');
		await fireEvent.click(container.querySelector('.expand-btn') as HTMLButtonElement);

		// The user's message reached the agent (and the surface) …
		expect(agent.transcript).toContainEqual({ role: 'user', text: 'hello' });
		// … and the scripted model reply landed.
		expect(await findByText('Hi there.', { exact: false })).toBeTruthy();
		expect(await findByText('hello', { exact: false })).toBeTruthy();
		// The input was cleared after submit.
		const input = container.querySelector('input[type="text"]') as HTMLInputElement;
		expect(input.value).toBe('');

		await agent.stop();
	});

	it('renders nothing when headless', () => {
		const agent = makeAgent([]);
		const { container } = render(AgentShell, { agent, headless: true });
		expect(container.querySelector('.a2ui-agent-shell')).toBeNull();
	});

	it('shows no mic on a text-only model', () => {
		const agent = makeAgent([]);
		const { container } = render(AgentShell, { agent });
		// The shell (with its input bar) renders, but no audio affordance does.
		expect(container.querySelector('.a2ui-agent-shell')).not.toBeNull();
		expect(container.querySelector('.mic-button')).toBeNull();
	});

	it('shows the mic when the model advertises audio input — same shell, by capability', () => {
		const agent = new Agent(
			{ instructions: 'persona', surfaces: () => [] },
			new AudioCapableModel()
		);
		const { container } = render(AgentShell, { agent });
		// Uniform UI: the chat input is still there; the mic cluster joins it.
		expect(container.querySelector('input[type="text"]')).not.toBeNull();
		expect(container.querySelector('.mic-button')).not.toBeNull();
		// Mute only appears once a session is open.
		expect(container.querySelector('.mute-button')).toBeNull();
	});

	describe('subtitles', () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		const subtitle = (c: HTMLElement) => c.querySelector('.subtitle')?.textContent ?? null;

		it('shows only the agent reply, over the app, until subtitleDuration passes', async () => {
			vi.useFakeTimers();
			const agent = makeAgent([{ on: 'hello', text: 'Hi there.' }]);
			const { container } = render(AgentShell, { agent, subtitleDuration: 1000 });

			expect(subtitle(container)).toBeNull();
			await sendMessage(container, 'hello');

			expect(subtitle(container)).toBe('Hi there.');
			// The user's own turn is not subtitled, and the panel stays closed.
			expect(container.textContent).not.toContain('hello');
			expect(container.querySelector('.transcript')).toBeNull();

			await vi.advanceTimersByTimeAsync(990);
			flushSync();
			expect(subtitle(container)).toBe('Hi there.');
			await vi.advanceTimersByTimeAsync(20);
			flushSync();
			expect(subtitle(container)).toBeNull();

			await agent.stop();
		});

		it('keeps a long reply for its reading time', async () => {
			vi.useFakeTimers();
			const reply = 'x'.repeat(60); // 4 s at 15 characters per second
			const agent = makeAgent([{ on: 'hello', text: reply }]);
			const { container } = render(AgentShell, { agent, subtitleDuration: 1000 });

			await sendMessage(container, 'hello');
			await vi.advanceTimersByTimeAsync(3900);
			flushSync();
			expect(subtitle(container)).toBe(reply);
			await vi.advanceTimersByTimeAsync(200);
			flushSync();
			expect(subtitle(container)).toBeNull();

			await agent.stop();
		});

		it('stays while the agent speaks, then for subtitleDuration after', async () => {
			vi.useFakeTimers();
			const agent = makeAgent([{ on: 'hello', text: 'Hi there.' }]);
			const { container } = render(AgentShell, { agent, subtitleDuration: 1000 });

			await sendMessage(container, 'hello');
			agent.speaking = true;
			await vi.advanceTimersByTimeAsync(5000);
			flushSync();
			expect(subtitle(container)).toBe('Hi there.');

			agent.speaking = false;
			await vi.advanceTimersByTimeAsync(990);
			flushSync();
			expect(subtitle(container)).toBe('Hi there.');
			await vi.advanceTimersByTimeAsync(20);
			flushSync();
			expect(subtitle(container)).toBeNull();

			await agent.stop();
		});

		it('are toggled by the captions button, and can start off', async () => {
			const agent = makeAgent([
				{ on: 'hello', text: 'Hi there.' },
				{ on: 'again', text: 'Hello once more.' }
			]);
			const { container } = render(AgentShell, { agent, subtitles: false });

			await sendMessage(container, 'hello');
			expect(subtitle(container)).toBeNull();

			const toggle = container.querySelector('.subtitles-toggle-btn') as HTMLButtonElement;
			expect(toggle.getAttribute('aria-pressed')).toBe('false');
			await fireEvent.click(toggle);
			expect(toggle.getAttribute('aria-pressed')).toBe('true');

			await sendMessage(container, 'again');
			expect(subtitle(container)).toBe('Hello once more.');

			await agent.stop();
		});

		it('are hidden while the chat panel is open', async () => {
			const agent = makeAgent([{ on: 'hello', text: 'Hi there.' }]);
			const { container } = render(AgentShell, { agent });

			await sendMessage(container, 'hello');
			expect(subtitle(container)).toBe('Hi there.');
			await fireEvent.click(container.querySelector('.expand-btn') as HTMLButtonElement);
			expect(subtitle(container)).toBeNull();

			await agent.stop();
		});
	});

	it('expands the full transcript panel only when the user toggles it', async () => {
		const agent = makeAgent([{ on: 'hello', text: 'Hi there.' }]);
		const { container } = render(AgentShell, { agent });

		await sendMessage(container, 'hello');
		expect(container.querySelector('.transcript')).toBeNull();

		// Clicking the expand control reveals the full transcript.
		const expandBtn = container.querySelector('.expand-btn') as HTMLButtonElement;
		await fireEvent.click(expandBtn);
		expect(container.querySelector('.transcript')).not.toBeNull();

		await agent.stop();
	});

	it('charts each turn between the user message and the reply when debug is open', async () => {
		const agent = makeAgent([
			{ on: 'save', calls: [{ name: 'shell_trace_tool', args: { x: 1 } }], text: 'Saved.' }
		]);
		toolRegistry.register({
			name: 'shell_trace_tool',
			description: 'test tool',
			parameters: { type: 'object', properties: {} },
			execute: async () => ({ results: [{ element_id: 'a', status: 'success' }] })
		});
		const { container } = render(AgentShell, { agent, debug: true });

		await sendMessage(container, 'save');
		await fireEvent.click(container.querySelector('.expand-btn') as HTMLButtonElement);

		// Debug is enabled but still collapsed — no timeline yet.
		expect(container.querySelector('.a2ui-turn-trace')).toBeNull();

		await fireEvent.click(container.querySelector('.debug-toggle-btn') as HTMLButtonElement);

		const rows = [...container.querySelectorAll('.transcript > *')];
		const classes = rows.map((el) => el.className);
		// user message · timeline · model reply, in that order.
		expect(classes[0]).toContain('message user');
		expect(classes[1]).toContain('a2ui-turn-trace');
		expect(classes[2]).toContain('message model');

		// The tool call is a row of the chart, with its detail behind a toggle.
		const trace = rows[1] as HTMLElement;
		expect(trace.textContent).toContain('shell_trace_tool');
		expect(trace.querySelector('details')).not.toBeNull();
		expect(trace.textContent).toContain('thinking');
		expect(trace.textContent).toContain('generating');

		await agent.stop();
	});

	it('renders no timeline when debug is off', async () => {
		const agent = makeAgent([{ on: 'hello', text: 'Hi there.' }]);
		const { container } = render(AgentShell, { agent });

		await sendMessage(container, 'hello');
		await fireEvent.click(container.querySelector('.expand-btn') as HTMLButtonElement);

		expect(container.querySelector('.a2ui-turn-trace')).toBeNull();
		// Without `debug` there is no way to switch it on, either.
		expect(container.querySelector('.debug-toggle-btn')).toBeNull();

		await agent.stop();
	});

	it('renders the model reply as markdown but the user turn as plain text', async () => {
		const agent = makeAgent([{ on: 'hello', text: 'Hello **world**' }]);
		const { container } = render(AgentShell, { agent });

		await sendMessage(container, 'hello');
		await fireEvent.click(container.querySelector('.expand-btn') as HTMLButtonElement);

		// The agent's `**world**` became real emphasis markup (inside the rendered
		// `.md` body — not the "Agent:" role label, which is also a <strong>) …
		const strong = container.querySelector('.message.model .md strong');
		expect(strong?.textContent).toBe('world');
		// … while the user's turn stays literal (no markdown parsing applied).
		const userMsg = container.querySelector('.message.user') as HTMLElement;
		expect(userMsg.querySelector('.md')).toBeNull();
		expect(userMsg.textContent).toContain('hello');

		await agent.stop();
	});
});
