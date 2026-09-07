<script lang="ts">
	import '../app.css';
	import { onMount, setContext } from 'svelte';
	import { Agent, AgentShell, type AgentTransport } from 'a2ui-svelte/agent';
	import { GeminiLiveTransport, GeminiTextTransport } from 'a2ui-svelte/agent/gemini';
	import { AnthropicTextTransport } from 'a2ui-svelte/agent/anthropic';
	import { OpenAITextTransport, OpenAIRealtimeTransport } from 'a2ui-svelte/agent/openai';
	import { DeepgramVoiceAgentTransport } from 'a2ui-svelte/agent/deepgram';
	import { HumeEviTransport } from 'a2ui-svelte/agent/hume';
	import { SURFACE_FEEDBACK_KEY, type SurfaceFeedback } from 'a2ui-svelte/renderer';
	import { mountedSurfaces } from 'a2ui-svelte/core';
	import { session } from '$lib/session.svelte';
	import { assistant } from '$lib/agent-definition';

	let { children } = $props();

	// What a tool result echoes back to the agent: every mounted static surface,
	// plus the page's prose context.
	const surfaceFeedback: SurfaceFeedback = {
		globalSurfaces: () =>
			JSON.parse(
				JSON.stringify(
					mountedSurfaces()
						.filter((s) => s.type === 'static')
						.map((s) => s.getJson())
				)
			),
		contextInstructions: () => session.contextInstructions
	};
	setContext<SurfaceFeedback>(SURFACE_FEEDBACK_KEY, surfaceFeedback);

	// ── Model switch ──────────────────────────────────────────────────────────
	// Swapping the transport is the ONLY thing the picker changes. The same
	// definition and the same <AgentShell> serve every choice: the shell reads
	// `agent.capabilities`, so voice transports get the mic + mute cluster and
	// text transports get a pure chat bar. Auth lives on each transport too —
	// voice mints a short-lived token per connect (`/api/voice-token/<id>`),
	// text rides a same-origin key proxy (`/api/<id>`) so the real API key stays
	// server-side. See `.env.template` for the keys each provider needs.
	type ProviderId = 'gemini' | 'anthropic' | 'openai' | 'deepgram' | 'hume';

	/** POST a voice-token mint route and return the short-lived credential. */
	async function mintToken(provider: ProviderId): Promise<string> {
		const r = await fetch(`/api/voice-token/${provider}`, { method: 'POST' });
		if (!r.ok) {
			const body = await r.json().catch(() => ({}));
			throw new Error(body.message || body.error || `Failed to mint ${provider} token`);
		}
		return (await r.json()).token as string;
	}

	type ModelChoice = {
		id: string;
		label: string;
		kind: 'voice' | 'text';
		provider: ProviderId;
		build: () => AgentTransport;
	};

	const origin = () => (typeof location !== 'undefined' ? location.origin : '');

	const MODELS: ModelChoice[] = [
		// Streaming voice — the shell grows a mic + mute cluster.
		{
			id: 'gemini-live',
			label: 'Gemini Live',
			kind: 'voice',
			provider: 'gemini',
			build: () => new GeminiLiveTransport({ token: () => mintToken('gemini') })
		},
		{
			id: 'openai-realtime',
			label: 'OpenAI Realtime',
			kind: 'voice',
			provider: 'openai',
			build: () => new OpenAIRealtimeTransport({ token: () => mintToken('openai') })
		},
		{
			id: 'deepgram',
			label: 'Deepgram Voice Agent',
			kind: 'voice',
			provider: 'deepgram',
			build: () => new DeepgramVoiceAgentTransport({ token: () => mintToken('deepgram') })
		},
		{
			id: 'hume',
			label: 'Hume EVI',
			kind: 'voice',
			provider: 'hume',
			build: () => new HumeEviTransport({ accessToken: () => mintToken('hume') })
		},
		// Request/response text — same shell, no mic.
		{
			id: 'gemini-text',
			label: 'Gemini 3.5 Flash',
			kind: 'text',
			provider: 'gemini',
			build: () => new GeminiTextTransport({ baseUrl: `${origin()}/api/gemini` })
		},
		{
			id: 'anthropic-text',
			label: 'Claude (Opus 4.8)',
			kind: 'text',
			provider: 'anthropic',
			build: () => new AnthropicTextTransport({ baseUrl: `${origin()}/api/claude` })
		},
		{
			id: 'openai-text',
			label: 'GPT (5.2)',
			kind: 'text',
			provider: 'openai',
			build: () => new OpenAITextTransport({ baseUrl: `${origin()}/api/openai` })
		}
	];

	const voiceModels = MODELS.filter((m) => m.kind === 'voice');
	const textModels = MODELS.filter((m) => m.kind === 'text');

	// Which providers have a key configured server-side (booleans only — the keys
	// never leave the server). `null` while still loading. A model whose provider
	// is unavailable is shown disabled, so the picker reflects exactly what
	// `.env` enables.
	let available = $state<Record<ProviderId, boolean> | null>(null);
	let model = $state<string | null>(null);

	const isAvailable = (m: ModelChoice) => available?.[m.provider] ?? false;

	onMount(async () => {
		try {
			const r = await fetch('/api/providers');
			available = r.ok ? await r.json() : null;
		} catch {
			available = null;
		}
		// Default to the first model whose provider is configured.
		model = MODELS.find(isAvailable)?.id ?? null;
	});

	// Build the agent for the active model, tearing the previous one down on
	// switch (and on unmount). Only builds once a configured model is selected.
	let agent = $state<Agent | null>(null);

	$effect(() => {
		const choice = MODELS.find((m) => m.id === model);
		if (!choice || !isAvailable(choice)) {
			agent = null;
			return;
		}
		const built = new Agent(assistant, choice.build());
		agent = built;
		return () => built.stop();
	});

	const noneConfigured = $derived(available !== null && !MODELS.some(isAvailable));
</script>

<header>
	<h1>a2ui-svelte minimal app</h1>
	<p class="intro">
		A2UI lets a human and an AI agent operate the <em>same</em> Svelte UI at
		once. Each tab below demonstrates one way to build that UI. Pick an agent
		model on the right — streaming <em>voice</em> (the shell grows a mic) or
		request/response <em>text</em> — one agent definition and one shell drive
		them all; only the transport changes. The list is gated by which provider
		keys you set in <code>.env</code> (see <code>.env.template</code>).
	</p>
	<nav>
		<a href="/">Static surface</a>
		<a href="/canvas">Dynamic surface</a>
		<a href="/custom-elements">Custom elements</a>
	</nav>
	<label class="model-picker">
		Agent model
		<select bind:value={model} disabled={available === null || noneConfigured}>
			<optgroup label="Voice (streaming)">
				{#each voiceModels as m (m.id)}
					<option value={m.id} disabled={!isAvailable(m)}>
						{m.label}{isAvailable(m) ? '' : ' — set key in .env'}
					</option>
				{/each}
			</optgroup>
			<optgroup label="Text (chat)">
				{#each textModels as m (m.id)}
					<option value={m.id} disabled={!isAvailable(m)}>
						{m.label}{isAvailable(m) ? '' : ' — set key in .env'}
					</option>
				{/each}
			</optgroup>
		</select>
	</label>
</header>

<main>
	{@render children()}
</main>

{#if noneConfigured}
	<aside class="config-issue">
		<p>
			No provider keys configured. Copy <code>.env.template</code> to
			<code>.env</code>, add at least one real key, and restart the dev server.
		</p>
	</aside>
{:else if agent?.configIssue}
	<aside class="config-issue">
		<p>{agent.configIssue}</p>
		<button
			onclick={() => {
				if (agent) agent.configIssue = null;
			}}>Dismiss</button
		>
	</aside>
{/if}

<!-- One shell for every transport. It adapts itself to `agent.capabilities`:
     audio input ⇒ the mic + mute cluster joins the chat bar; text-only ⇒ the
     bar alone. `debug` surfaces a chart-icon button that toggles a live
     token/byte stats box — handy for watching what each session pushes into
     context. -->
{#if agent}
	<AgentShell {agent} debug />
{/if}

<style>
	header {
		margin-bottom: 1.5rem;
	}
	h1 {
		margin: 0 0 0.5rem;
		font-size: 1.4rem;
	}
	.intro {
		margin: 0 0 0.75rem;
		font-size: 0.9rem;
		color: var(--a2ui-muted-color, #888);
	}
	.model-picker {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.75rem;
		font-size: 0.85rem;
		color: var(--a2ui-muted-color, #888);
	}
	.model-picker select {
		width: auto;
		margin: 0;
	}
	main {
		padding-bottom: 10rem;
	}
	.config-issue {
		position: fixed;
		bottom: 80px;
		left: 1rem;
		right: 1rem;
		max-width: 720px;
		margin: 0 auto;
		padding: 0.75rem 1rem;
		background: var(--a2ui-card-bg);
		border: 1px solid #c0392b;
		border-radius: var(--a2ui-card-radius);
		display: flex;
		gap: 1rem;
		align-items: center;
	}
	.config-issue p {
		margin: 0;
		flex: 1;
	}
	.config-issue button {
		padding: 0.4rem 0.8rem;
		border-radius: var(--a2ui-border-radius);
		border: 1px solid #888;
		background: transparent;
		cursor: pointer;
	}
</style>
