<script lang="ts">
	import '../app.css';
	import { onDestroy, setContext } from 'svelte';
	import { VoiceAgent, VoiceShell } from 'a2ui-svelte/voice';
	import { GeminiTransport } from 'a2ui-svelte/voice/gemini';
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

	const transport = new GeminiTransport({ model: 'gemini-3.1-flash-live-preview' });

	const agent = new VoiceAgent({
		transport,
		surfaces: () => session.surfaces,
		contextInstructions: () => session.contextInstructions,
		mode: 'both',
		systemInstruction:
			'You are a helpful assistant demonstrating the a2ui-svelte library. Be concise.',
		mintToken: async () => {
			const r = await fetch('/api/voice-token', { method: 'POST' });
			if (!r.ok) {
				const body = await r.json().catch(() => ({}));
				throw new Error(body.error || 'Failed to mint voice token');
			}
			const { token } = await r.json();
			return token as string;
		}
	});

	onDestroy(() => agent.stop());
</script>

<header>
	<h1>a2ui-svelte minimal app</h1>
	<p class="intro">
		A2UI lets a human and an AI voice agent operate the <em>same</em> Svelte
		UI at once. Each tab below demonstrates one way to build that UI — open
		one and use the voice button in the corner to talk to the agent.
	</p>
	<nav>
		<a href="/">Static surface</a>
		<a href="/canvas">Dynamic surface</a>
		<a href="/custom-elements">Custom elements</a>
	</nav>
</header>

<main>
	{@render children()}
</main>

{#if agent.configIssue}
	<aside class="config-issue">
		<p>{agent.configIssue}</p>
		<button onclick={() => (agent.configIssue = null)}>Dismiss</button>
	</aside>
{/if}

<VoiceShell {agent} />

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
	main {
		padding-bottom: 6rem;
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
