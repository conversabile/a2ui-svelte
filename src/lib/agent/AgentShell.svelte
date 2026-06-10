<script lang="ts">
	import type { Snippet } from 'svelte';
	import { marked } from 'marked';
	import type { Agent, AgentStatus } from './agent.svelte';
	import type { AgentDebugStats } from './debug.svelte';
	import DebugBox from './DebugBox.svelte';

	interface Props {
		agent: Agent;
		/** Render no UI — the owner provides their own. The agent lifecycle is still the consumer's. */
		headless?: boolean;
		/** Replace the message list. Receives the live transcript + a `sendText` helper. */
		messages?: Snippet<
			[
				{
					entries: Array<{ role: 'user' | 'model'; text: string }>;
					sendText: (t: string) => void;
				}
			]
		>;
		/** Replace the input box. Receives a `sendText` helper + current connection/status. */
		input?: Snippet<
			[
				{
					sendText: (t: string) => void;
					connected: boolean;
					status: AgentStatus;
				}
			]
		>;
		/**
		 * Replace the mic cluster (session toggle + mute). Only rendered when the
		 * transport accepts audio input (`agent.capabilities.input` includes
		 * `'audio'`) — on a text-only transport there is no mic at all.
		 */
		mic?: Snippet<
			[
				{
					connected: boolean;
					status: AgentStatus;
					toggle: () => void;
					muted: boolean;
					toggleMute: () => void;
				}
			]
		>;
		/** Replace the status badge. */
		status?: Snippet<[{ status: AgentStatus }]>;
		/** Replace the controls row (reset + chat toggle + debug toggle). */
		controls?: Snippet<
			[
				{
					resetConversation: () => void;
					toggleChat: () => void;
					isChatOpen: boolean;
					toggleDebug: () => void;
					isDebugOpen: boolean;
				}
			]
		>;
		/**
		 * Enable the token/byte debug panel, bound to `agent.debug`. A chart-icon
		 * button in the controls toggles a stats box at the top of the shell —
		 * collapsed by default. `true` uses the batteries-included box; pass a
		 * snippet to render your own from the same reactive `AgentDebugStats`.
		 * Off by default.
		 */
		debug?: boolean | Snippet<[{ debug: AgentDebugStats }]>;
	}

	let {
		agent,
		headless = false,
		messages,
		input,
		mic,
		status,
		controls,
		debug = false
	}: Props = $props();

	const showDebug = $derived(debug !== false);
	const customDebug = $derived(typeof debug === 'function' ? debug : null);

	// The one switch that adapts the shell to the transport: audio modality from
	// the capabilities descriptor — never the transport's identity. A live voice
	// API and a future STT/TTS-wrapped text transport both light the mic up.
	const hasAudioInput = $derived(agent.capabilities.input.includes('audio'));

	let isChatOpen = $state(false);
	let isDebugOpen = $state(false);
	let textInput = $state('');

	function toggleChat() {
		isChatOpen = !isChatOpen;
	}

	function toggleDebug() {
		isDebugOpen = !isDebugOpen;
	}

	async function handleToggle() {
		await agent.toggle();
	}

	function handleToggleMute() {
		agent.toggleMute();
	}

	async function handleReset() {
		await agent.reset();
		isChatOpen = false;
	}

	// Typing works on every transport (voice live-APIs accept text turns too).
	// A session is established lazily on the first message, so the user can just
	// type and send; on an audio transport the mic button is the explicit
	// session control. `start()` is guarded on `connected` so it's only opened
	// once.
	async function send(text: string) {
		const value = text.trim();
		if (!value) return;
		if (!agent.connected) await agent.start();
		agent.sendTextMessage(value);
	}

	async function handleSubmit(e: Event) {
		e.preventDefault();
		const value = textInput.trim();
		if (!value) return;
		textInput = '';
		await send(value);
	}

	// Render an agent turn's markdown to HTML. Synchronous parse (no plugins that
	// defer), matching how the TextField composite renders its preview.
	function renderMarkdown(text: string): string {
		return marked.parse(text, { async: false }) as string;
	}

	const statusBadge = $derived(
		agent.status === 'thinking' || agent.status === 'error' ? agent.status : null
	);

	// The "peek": the latest exchange (last user + agent turn) shown as bare
	// balloons above the input when the full panel is collapsed, so a response
	// never covers the app.
	const peekEntries = $derived(agent.transcript.slice(-2));

	// The user can dismiss the peek with its [x]. We re-show it whenever a new
	// turn lands (transcript grows), so the dismissal only hides the *current*
	// exchange. `lastTranscriptLen` is intentionally non-reactive — the effect
	// reads it but mustn't re-run on its own write.
	let peekDismissed = $state(false);
	let lastTranscriptLen = 0;
	$effect(() => {
		const len = agent.transcript.length;
		if (len > lastTranscriptLen) peekDismissed = false;
		lastTranscriptLen = len;
	});
</script>

{#if !headless}
	<div class="a2ui-agent-shell" class:glowing={agent.connected}>
		{#if showDebug && isDebugOpen}
			{#if customDebug}
				{@render customDebug({ debug: agent.debug })}
			{:else}
				<DebugBox debug={agent.debug} title="Agent token debug" onClose={toggleDebug} />
			{/if}
		{/if}

		{#if messages}
			{@render messages({ entries: agent.transcript, sendText: (t) => send(t) })}
		{:else if agent.hasStarted && isChatOpen}
			<div class="chat-wrapper">
				<div class="chat-container container">
					<div class="transcript">
						{#if agent.transcript.length === 0}
							<p class="placeholder">
								<em>
									{hasAudioInput && agent.connected
										? 'Listening...'
										: 'Send a message to start the conversation.'}
								</em>
							</p>
						{/if}
						{#each agent.transcript as message}
							<div class="message {message.role}">
								<strong class="role">{message.role === 'user' ? 'You' : 'Agent'}:</strong>
								{#if message.role === 'model'}
									<span class="md">{@html renderMarkdown(message.text)}</span>
								{:else}
									{message.text}
								{/if}
							</div>
						{/each}
					</div>
				</div>
			</div>
		{:else if agent.hasStarted && peekEntries.length > 0 && !peekDismissed}
			<div class="peek">
				<button
					class="peek-close"
					onclick={() => (peekDismissed = true)}
					aria-label="Dismiss latest messages"
					title="Dismiss"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="M18 6 6 18" />
						<path d="m6 6 12 12" />
					</svg>
				</button>
				{#each peekEntries as message}
					<div class="message {message.role}">
						{#if message.role === 'model'}
							<span class="md">{@html renderMarkdown(message.text)}</span>
						{:else}
							{message.text}
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		<div class="a2ui-agent-controls container">
			<div class="left-controls">
				{#if controls}
					{@render controls({
						resetConversation: handleReset,
						toggleChat,
						isChatOpen,
						toggleDebug,
						isDebugOpen
					})}
				{:else}
					{#if showDebug}
						<button
							class="debug-toggle-btn outline secondary"
							class:active={isDebugOpen}
							onclick={toggleDebug}
							aria-label="Toggle agent debug stats"
							aria-pressed={isDebugOpen}
							title="Toggle agent debug stats"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="20"
								height="20"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<line x1="6" x2="6" y1="20" y2="14" />
								<line x1="12" x2="12" y1="20" y2="4" />
								<line x1="18" x2="18" y1="20" y2="10" />
							</svg>
						</button>
					{/if}
					{#if agent.hasStarted}
						<button
							class="reset-convo-btn outline secondary"
							onclick={handleReset}
							aria-label="New Conversation"
							title="New Conversation"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="20"
								height="20"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
								<path d="M3 3v5h5" />
							</svg>
						</button>
					{/if}
				{/if}
			</div>

			<div class="input-container">
				{#if input}
					{@render input({
						sendText: (t) => send(t),
						connected: agent.connected,
						status: agent.status
					})}
				{:else}
					<form onsubmit={handleSubmit}>
						<div class="chat-row">
							<input
								class="chat-input"
								type="text"
								bind:value={textInput}
								placeholder={hasAudioInput && agent.connected
									? 'Listening... or type a message'
									: 'Type a message...'}
								aria-label="Message"
							/>
							<button
								type="submit"
								class="send-button"
								disabled={!textInput.trim() || agent.status === 'thinking'}
								aria-label="Send message"
								title="Send message"
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="22"
									height="22"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<path
										d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"
									/>
									<path d="m21.854 2.147-10.94 10.939" />
								</svg>
							</button>
						</div>
					</form>
				{/if}
			</div>

			{#if hasAudioInput}
				<div class="mic-container">
					{#if mic}
						{@render mic({
							connected: agent.connected,
							status: agent.status,
							toggle: handleToggle,
							muted: agent.muted,
							toggleMute: handleToggleMute
						})}
					{:else}
						<button
							class="mic-button {agent.connected ? '' : 'outline primary'}"
							onclick={handleToggle}
							aria-label={agent.connected ? 'Pause Live' : 'Start Live'}
							title={agent.connected ? 'Pause Live' : 'Start Live'}
						>
							{#if agent.connected}
								<!-- Open session: the button pauses (and interrupts the agent). -->
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="24"
									height="24"
									viewBox="0 0 24 24"
									fill="currentColor"
									stroke="currentColor"
									stroke-width="1"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<rect x="6" y="4" width="4" height="16" rx="1" />
									<rect x="14" y="4" width="4" height="16" rx="1" />
								</svg>
							{:else}
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="24"
									height="24"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
									<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
									<line x1="12" x2="12" y1="19" y2="22" />
								</svg>
							{/if}
						</button>
						{#if agent.connected}
							<button
								class="mute-button outline secondary"
								class:muted={agent.muted}
								onclick={handleToggleMute}
								aria-label={agent.muted ? 'Unmute microphone' : 'Mute microphone'}
								aria-pressed={agent.muted}
								title={agent.muted ? 'Unmute microphone' : 'Mute microphone'}
							>
								{#if agent.muted}
									<!-- Muted: mic input is dropped; tap to resume sending audio. -->
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="20"
										height="20"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
									>
										<line x1="2" x2="22" y1="2" y2="22" />
										<path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
										<path d="M5 10v2a7 7 0 0 0 12 5" />
										<path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
										<path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
										<line x1="12" x2="12" y1="19" y2="22" />
									</svg>
								{:else}
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="20"
										height="20"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
									>
										<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
										<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
										<line x1="12" x2="12" y1="19" y2="22" />
									</svg>
								{/if}
							</button>
						{/if}
					{/if}
				</div>
			{/if}

			<div class="right-controls">
				{#if status}
					{@render status({ status: agent.status })}
				{:else if statusBadge}
					<span class="status-badge {statusBadge}">
						{statusBadge === 'thinking' ? 'thinking...' : 'error'}
					</span>
				{/if}
				{#if !controls && agent.hasStarted}
					<button
						class="expand-btn outline secondary"
						onclick={toggleChat}
						aria-label={isChatOpen ? 'Collapse Chat' : 'Expand Chat'}
						title={isChatOpen ? 'Collapse Chat' : 'Expand Chat'}
					>
						{#if isChatOpen}
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="24"
								height="24"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg
							>
						{:else}
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="24"
								height="24"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"><path d="m18 15-6-6-6 6" /></svg
							>
						{/if}
					</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.a2ui-agent-shell {
		position: fixed;
		bottom: 0;
		/* Defaults to full-width. Apps with a side layout (e.g. fixed sidebar)
		   can inset the shell by setting `--a2ui-shell-left` / `--a2ui-shell-right`
		   on any ancestor — CSS custom properties cascade through the DOM tree
		   regardless of position:fixed. */
		left: var(--a2ui-shell-left, 0);
		right: var(--a2ui-shell-right, 0);
		background: var(--a2ui-shell-bg, var(--pico-card-background-color));
		border-top: 1px solid var(--a2ui-shell-border, var(--pico-muted-border-color));
		z-index: 999;
		padding: 0.5rem 1rem;
		transition:
			box-shadow 0.3s ease,
			border-top-color 0.3s ease;
	}

	.a2ui-agent-shell.glowing {
		box-shadow: 0px -4px 20px
			var(--a2ui-shell-glow, color-mix(in srgb, var(--a2ui-shell-accent-bg) 45%, transparent));
		border-top-color: var(--a2ui-shell-border-active, var(--a2ui-shell-accent-bg));
	}

	.chat-wrapper {
		border-bottom: 1px solid var(--a2ui-shell-border, var(--pico-muted-border-color));
	}

	/* The compact peek: balloons on a semi-transparent panel (the app shows through
	   behind it), showing just the latest exchange above the input. Caps its own
	   height and scrolls so a long turn never grows the bar off-screen. */
	.peek {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		/* Symmetric side gutters leave room for the dismiss [x] at top-right so it
		   never overlaps the right-aligned user balloon. */
		padding: 0.75rem 1.75rem;
		max-width: 800px;
		margin: 0 auto;
		max-height: 40vh;
		overflow-y: auto;
		border-radius: var(--pico-border-radius);
		background: var(
			--a2ui-shell-peek-bg,
			color-mix(in srgb, var(--a2ui-shell-bg, var(--pico-card-background-color)) 75%, transparent)
		);
		backdrop-filter: blur(4px);
	}

	/* Small dismiss [x] pinned to the peek's top-right corner. */
	.peek-close {
		position: absolute;
		top: 0.25rem;
		right: 0.25rem;
		width: 24px;
		height: 24px;
		padding: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		border: none;
		border-radius: 50%;
		background: transparent;
		color: var(--pico-muted-color);
		cursor: pointer;
		opacity: 0.7;
	}

	.peek-close:hover {
		opacity: 1;
		background: color-mix(in srgb, currentColor 12%, transparent);
	}

	.chat-container {
		height: 50vh;
		display: flex;
		flex-direction: column;
		padding-top: 1rem;
		padding-bottom: 1rem;
		max-width: 800px;
		margin: 0 auto;
	}

	.a2ui-agent-controls {
		background: var(--a2ui-shell-bg, var(--pico-card-background-color));
		display: flex;
		align-items: center;
		gap: 0.75rem;
		height: 70px;
		padding: 0 1rem;
		max-width: 800px;
		margin: 0 auto;
	}

	.left-controls,
	.right-controls {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	/* The input is the centrepiece of the shell, so it grows to fill the bar
	   between the (auto-width) control clusters. */
	.input-container {
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
	}

	.input-container form {
		width: 100%;
		margin: 0;
	}

	.chat-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
	}

	.chat-input {
		flex: 1 1 auto;
		min-width: 0;
		margin-bottom: 0;
	}

	.transcript {
		flex: 1;
		border: 1px solid var(--pico-border-color);
		border-radius: var(--pico-border-radius);
		padding: 1rem;
		overflow-y: auto;
		background: var(--pico-card-sectioning-background-color);
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.05);
	}

	.message {
		padding: 0.8rem;
		border-radius: var(--pico-border-radius);
		line-height: 1.5;
		max-width: 85%;
		overflow-wrap: anywhere;
	}

	.message.user {
		background: var(--a2ui-shell-accent-bg);
		color: var(--a2ui-shell-accent-fg);
		align-self: flex-end;
		border-bottom-right-radius: 2px;
	}

	.message.model {
		background: var(--a2ui-shell-bubble-bg);
		color: var(--a2ui-shell-bubble-fg);
		align-self: flex-start;
		border-bottom-left-radius: 2px;
	}

	.placeholder {
		color: var(--pico-muted-color);
		text-align: center;
	}

	/* Rendered markdown sits inline after the "Agent:" label, but its block
	   children (paragraphs, lists, code) still flow as blocks inside it. */
	.md {
		display: inline-block;
		vertical-align: top;
		max-width: 100%;
	}

	/* Pico sets `color` directly on block tags (p, ul, ol, pre, …) via
	   `…,p,…{color:var(--pico-color)}` — an element-level rule that beats the
	   bubble's inherited colour, rendering the reply in the body text colour
	   (dark-on-dark on the muted bubble). Force every markdown descendant back to
	   the bubble's own colour. */
	.md :global(*) {
		color: inherit;
	}

	.md :global(> :first-child) {
		margin-top: 0;
	}

	.md :global(> :last-child) {
		margin-bottom: 0;
	}

	.md :global(p) {
		margin: 0 0 0.5rem;
	}

	.md :global(ul),
	.md :global(ol) {
		margin: 0 0 0.5rem;
		padding-left: 1.25rem;
	}

	/* Code panels derive from the bubble's own text colour so they read on any
	   theme (light/dark) and any bubble background, without a hardcoded colour. */
	.md :global(code) {
		background: color-mix(in srgb, currentColor 12%, transparent);
		padding: 0.1em 0.3em;
		border-radius: 4px;
		font-size: 0.9em;
	}

	.md :global(pre) {
		margin: 0 0 0.5rem;
		padding: 0.5rem 0.75rem;
		border-radius: var(--pico-border-radius);
		overflow-x: auto;
		background: color-mix(in srgb, currentColor 10%, transparent);
	}

	.md :global(pre code) {
		background: none;
		padding: 0;
	}

	.md :global(a) {
		color: inherit;
	}

	.status-badge {
		font-size: 0.65rem;
		font-weight: 600;
		letter-spacing: 0.02em;
		white-space: nowrap;
		pointer-events: none;
	}

	.status-badge.thinking {
		color: var(--a2ui-shell-accent-bg);
		animation: pulse-opacity 1.5s ease-in-out infinite;
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.status-badge.thinking::before {
		content: '';
		display: inline-block;
		width: 6px;
		height: 6px;
		background-color: var(--a2ui-shell-accent-bg);
		border-radius: 50%;
	}

	.status-badge.error {
		color: var(--pico-del-color);
	}

	@keyframes pulse-opacity {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.3;
		}
	}

	/* The send button and the mic button share the circular accent language, so
	   text-only and voice-capable transports render the same shell — the mic is
	   simply present or not. */
	.send-button {
		flex: 0 0 auto;
		width: 48px;
		height: 48px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		margin-bottom: 0;
		padding: 0;
		cursor: pointer;
		background: var(--a2ui-shell-accent-bg);
		color: var(--a2ui-shell-accent-fg);
		border: 1px solid var(--a2ui-shell-accent-bg);
	}

	.send-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.send-button svg {
		width: 22px;
		height: 22px;
	}

	.mic-container {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.mic-button {
		width: 48px;
		height: 48px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		margin-bottom: 0;
		padding: 0;
		cursor: pointer;
		box-shadow: var(--pico-box-shadow);
	}

	.mic-button:not(.outline) {
		animation: pulse-border 2s infinite;
		background: var(--a2ui-shell-accent-bg);
		color: var(--a2ui-shell-accent-fg);
	}

	/* Idle (not connected) mic is a Pico outline button — colour its ring/icon
	   with the accent too so the whole shell tracks one accent token. */
	.mic-button.outline {
		color: var(--a2ui-shell-accent-bg);
		border-color: var(--a2ui-shell-accent-bg);
	}

	.mic-button svg {
		width: 24px;
		height: 24px;
	}

	.mute-button {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		margin-bottom: 0;
		padding: 0;
		cursor: pointer;
	}

	.mute-button svg {
		width: 20px;
		height: 20px;
	}

	/* Muted = the agent can't hear you. Use the destructive colour as a filled
	   "off" state so it's unmistakable the mic is cut. */
	.mute-button.muted {
		background: var(--pico-del-color, crimson);
		border-color: var(--pico-del-color, crimson);
		color: var(--pico-card-background-color, #fff);
	}

	.reset-convo-btn,
	.expand-btn,
	.debug-toggle-btn {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		margin-bottom: 0;
		padding: 0;
		cursor: pointer;
	}

	.expand-btn svg,
	.debug-toggle-btn svg {
		width: 20px;
		height: 20px;
	}

	/* Active = stats box open. Drop the outline for a filled, "pressed" look. */
	.debug-toggle-btn.active {
		background: var(--a2ui-shell-accent-bg);
		color: var(--a2ui-shell-accent-fg);
		border-color: var(--a2ui-shell-accent-bg);
	}

	@keyframes pulse-border {
		0% {
			box-shadow: 0 0 0 0 color-mix(in srgb, var(--a2ui-shell-accent-bg) 45%, transparent);
		}
		70% {
			box-shadow: 0 0 0 15px transparent;
		}
		100% {
			box-shadow: 0 0 0 0 transparent;
		}
	}
</style>
