<script lang="ts">
	import '../app.css';
	import { setContext } from 'svelte';
	import {
		Agent,
		AgentShell,
		type AgentDefinition,
		type AgentTransport
	} from 'a2ui-svelte/agent';
	import { GeminiLiveTransport, GeminiTextTransport } from 'a2ui-svelte/agent/gemini';
	import { SURFACE_FEEDBACK_KEY, type SurfaceFeedback } from 'a2ui-svelte/renderer';
	import { session } from '$lib/session.svelte';

	let { children } = $props();

	const surfaceFeedback: SurfaceFeedback = {
		globalSurfaces: () =>
			JSON.parse(
				JSON.stringify(
					session.surfaces.filter((s) => s && s.type === 'static').map((s) => s.getJson())
				)
			),
		contextInstructions: () => session.contextInstructions
	};
	setContext<SurfaceFeedback>(SURFACE_FEEDBACK_KEY, surfaceFeedback);

	// ── The agent definition ──────────────────────────────────────────────────
	// What the agent IS — persona, surfaces, page context — declared once,
	// independent of any model or channel. Both transports below run this same
	// definition unchanged.
	const assistant: AgentDefinition = {
		instructions: 'You are a helpful assistant demonstrating the a2ui-svelte library. Be concise.',
		surfaces: () => session.surfaces,
		contextInstructions: () => session.contextInstructions,
		mode: 'both'
	};

	// ── Model switch ──────────────────────────────────────────────────────────
	// Swapping the transport is the ONLY thing the picker changes. The same
	// definition and the same <AgentShell> serve both: the shell reads
	// `agent.capabilities`, so the Live transport (audio in/out) gets the mic +
	// mute cluster and the text transport gets a pure chat bar. Auth also lives
	// on the transport — Live mints an ephemeral token per connect; the text
	// model rides our same-origin proxy (`/api/gemini`) so the real
	// GEMINI_API_KEY stays server-side.
	type ModelChoice = 'gemini-live' | 'gemini-3.5-flash';
	let model = $state<ModelChoice>('gemini-live');

	function buildTransport(choice: ModelChoice): AgentTransport {
		if (choice === 'gemini-live') {
			return new GeminiLiveTransport({
				token: async () => {
					const r = await fetch('/api/voice-token', { method: 'POST' });
					if (!r.ok) {
						const body = await r.json().catch(() => ({}));
						throw new Error(body.error || 'Failed to mint voice token');
					}
					const { token } = await r.json();
					return token as string;
				}
			});
		}
		// See `src/routes/api/gemini/[...path]/+server.ts` for the proxy.
		return new GeminiTextTransport({ baseUrl: `${location.origin}/api/gemini` });
	}

	// Build the agent for the active model, tearing the previous one down on
	// switch (and on unmount).
	let agent = $state<Agent | null>(null);

	$effect(() => {
		const built = new Agent(assistant, buildTransport(model));
		agent = built;
		return () => built.stop();
	});
</script>

<header>
	<h1>a2ui-svelte minimal app</h1>
	<p class="intro">
		A2UI lets a human and an AI agent operate the <em>same</em> Svelte UI at
		once. Each tab below demonstrates one way to build that UI. Pick an agent
		model on the right: <em>Gemini Live</em> (streaming voice — the shell
		grows a mic) or <em>Gemini 3.5 Flash</em> (request/response text) — one
		agent definition and one shell drive both; only the transport changes.
	</p>
	<nav>
		<a href="/">Static surface</a>
		<a href="/canvas">Dynamic surface</a>
		<a href="/custom-elements">Custom elements</a>
	</nav>
	<label class="model-picker">
		Agent model
		<select bind:value={model}>
			<option value="gemini-live">Streaming — Gemini Live (voice)</option>
			<option value="gemini-3.5-flash">Text — Gemini 3.5 Flash (chat)</option>
		</select>
	</label>
</header>

<main>
	{@render children()}
</main>

{#if agent?.configIssue}
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
