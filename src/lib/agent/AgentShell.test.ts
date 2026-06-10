import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import AgentShell from './AgentShell.svelte';
import { Agent } from './agent.svelte';
import { ScriptedTransport } from './scripted-transport';
import type {
	AgentTransport,
	AgentTransportConnectOptions,
	AgentTransportEventMap,
	TransportCapabilities
} from './transport';
import { toolRegistry } from '../core/registries/tool-registry';

// ScriptedTransport defers its emits to a microtask; a macrotask hop settles it.
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeAgent(reactions: ConstructorParameters<typeof ScriptedTransport>[0]): Agent {
	return new Agent(
		{
			instructions: 'persona',
			surfaces: () => []
		},
		new ScriptedTransport(reactions)
	);
}

// A do-nothing transport advertising the voice profile, so the shell renders
// its audio affordances (mic + mute) purely from capabilities — without ever
// opening a session (no recorder, no Web Audio in jsdom).
class AudioCapableTransport implements AgentTransport {
	get capabilities(): TransportCapabilities {
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
	async connect(_opts: AgentTransportConnectOptions) {}
	sendText(_text: string) {}
	sendAudioChunk(_b64: string) {}
	sendToolResult(_id: string, _name: string, _result: unknown) {}
	on<E extends keyof AgentTransportEventMap>(
		_event: E,
		_handler: (p: AgentTransportEventMap[E]) => void
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
	beforeEach(() => {
		for (const t of toolRegistry.getDeclarations()) toolRegistry.unregister(t.name);
	});

	it('typing a message sends it and renders both the user turn and the model reply', async () => {
		const agent = makeAgent([{ on: 'hello', text: 'Hi there.' }]);
		const { container, findByText } = render(AgentShell, { agent });

		await sendMessage(container, 'hello');

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

	it('shows no mic on a text-only transport', () => {
		const agent = makeAgent([]);
		const { container } = render(AgentShell, { agent });
		// The shell (with its input bar) renders, but no audio affordance does.
		expect(container.querySelector('.a2ui-agent-shell')).not.toBeNull();
		expect(container.querySelector('.mic-button')).toBeNull();
	});

	it('shows the mic when the transport advertises audio input — same shell, by capability', () => {
		const agent = new Agent(
			{ instructions: 'persona', surfaces: () => [] },
			new AudioCapableTransport()
		);
		const { container } = render(AgentShell, { agent });
		// Uniform UI: the chat input is still there; the mic cluster joins it.
		expect(container.querySelector('input[type="text"]')).not.toBeNull();
		expect(container.querySelector('.mic-button')).not.toBeNull();
		// Mute only appears once a session is open.
		expect(container.querySelector('.mute-button')).toBeNull();
	});

	it('surfaces the latest exchange as a peek without opening the full panel', async () => {
		const agent = makeAgent([{ on: 'hello', text: 'Hi there.' }]);
		const { container } = render(AgentShell, { agent });

		// Nothing above the input bar at first — no peek, no full transcript box.
		expect(container.querySelector('.peek')).toBeNull();
		expect(container.querySelector('.transcript')).toBeNull();

		await sendMessage(container, 'hello');

		// Sending shows the compact peek (last user + agent turn) above the input …
		const peek = container.querySelector('.peek');
		expect(peek).not.toBeNull();
		expect(peek?.textContent).toContain('hello');
		expect(peek?.textContent).toContain('Hi there.');
		// … but does NOT open the full transcript panel, which would cover the app.
		expect(container.querySelector('.transcript')).toBeNull();

		await agent.stop();
	});

	it('dismisses the peek with its [x], and re-shows it on the next turn', async () => {
		const agent = makeAgent([
			{ on: 'hello', text: 'Hi there.' },
			{ on: 'again', text: 'Hello once more.' }
		]);
		const { container } = render(AgentShell, { agent });

		await sendMessage(container, 'hello');
		expect(container.querySelector('.peek')).not.toBeNull();

		// Closing hides the current exchange …
		const close = container.querySelector('.peek-close') as HTMLButtonElement;
		await fireEvent.click(close);
		expect(container.querySelector('.peek')).toBeNull();

		// … but a fresh turn brings the peek back.
		await sendMessage(container, 'again');
		const peek = container.querySelector('.peek');
		expect(peek).not.toBeNull();
		expect(peek?.textContent).toContain('Hello once more.');

		await agent.stop();
	});

	it('expands the full transcript panel only when the user toggles it', async () => {
		const agent = makeAgent([{ on: 'hello', text: 'Hi there.' }]);
		const { container } = render(AgentShell, { agent });

		await sendMessage(container, 'hello');
		expect(container.querySelector('.transcript')).toBeNull();

		// Clicking the expand control reveals the full transcript and hides the peek.
		const expandBtn = container.querySelector('.expand-btn') as HTMLButtonElement;
		await fireEvent.click(expandBtn);
		expect(container.querySelector('.transcript')).not.toBeNull();
		expect(container.querySelector('.peek')).toBeNull();

		await agent.stop();
	});

	it('renders the model reply as markdown but the user turn as plain text', async () => {
		const agent = makeAgent([{ on: 'hello', text: 'Hello **world**' }]);
		const { container } = render(AgentShell, { agent });

		await sendMessage(container, 'hello');

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
