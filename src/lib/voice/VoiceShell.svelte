<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { VoiceAgent, VoiceStatus } from './agent.svelte';

	interface Props {
		agent: VoiceAgent;
		/** Render no UI — owner provides their own. The agent's lifecycle is still owned by the consumer. */
		headless?: boolean;
		mic?: Snippet<
			[{ connected: boolean; status: VoiceStatus; toggle: () => void }]
		>;
		transcript?: Snippet<
			[
				{
					entries: Array<{ role: 'user' | 'model'; text: string }>;
					sendText: (t: string) => void;
				}
			]
		>;
		status?: Snippet<[{ status: VoiceStatus }]>;
		controls?: Snippet<
			[{ resetConversation: () => void; toggleChat: () => void; isChatOpen: boolean }]
		>;
	}

	let { agent, headless = false, mic, transcript, status, controls }: Props = $props();

	let isChatOpen = $state(false);
	let textInput = $state('');

	async function handleToggle() {
		await agent.toggle();
	}

	async function handleReset() {
		await agent.reset();
		isChatOpen = false;
	}

	function toggleChat() {
		isChatOpen = !isChatOpen;
	}

	function handleSendText(e: Event) {
		e.preventDefault();
		const value = textInput.trim();
		if (!value) return;
		agent.sendTextMessage(value);
		textInput = '';
	}

	const statusBadge = $derived(
		agent.status === 'thinking' || agent.status === 'error' ? agent.status : null
	);
</script>

{#if !headless}
	<div class="a2ui-voice-shell" class:glowing={agent.connected}>
		{#if transcript}
			{@render transcript({ entries: agent.transcript, sendText: (t) => agent.sendTextMessage(t) })}
		{:else if agent.hasStarted && isChatOpen}
			<div class="chat-wrapper">
				<div class="chat-container container">
					<div class="transcript">
						{#if agent.transcript.length === 0}
							<p class="placeholder">
								<em>{agent.connected ? 'Listening...' : 'Live session is paused'}</em>
							</p>
						{/if}
						{#each agent.transcript as message}
							<div class="message {message.role}">
								<strong>{message.role === 'user' ? 'You' : 'Agent'}:</strong>
								{message.text}
							</div>
						{/each}
					</div>

					<form onsubmit={handleSendText}>
						<!-- svelte-ignore a11y_no_redundant_roles -->
						<fieldset role="group">
							<input
								type="text"
								bind:value={textInput}
								placeholder={agent.connected
									? 'Type a message...'
									: 'Start live session to type...'}
								disabled={!agent.connected}
							/>
							<button type="submit" disabled={!agent.connected || !textInput.trim()}>Send</button>
						</fieldset>
					</form>
				</div>
			</div>
		{/if}

		<div class="a2ui-voice-controls container">
			<div class="left-controls">
				{#if controls}
					{@render controls({ resetConversation: handleReset, toggleChat, isChatOpen })}
				{:else if agent.hasStarted}
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
			</div>

			<div class="mic-container">
				{#if mic}
					{@render mic({ connected: agent.connected, status: agent.status, toggle: handleToggle })}
				{:else}
					<button
						class="mic-button {agent.connected ? '' : 'outline primary'}"
						onclick={handleToggle}
						aria-label={agent.connected ? 'Stop Live' : 'Start Live'}
						title={agent.connected ? 'Stop Live' : 'Start Live'}
					>
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
					</button>
				{/if}
				{#if status}
					{@render status({ status: agent.status })}
				{:else if statusBadge}
					<span class="status-badge {statusBadge}">
						{statusBadge === 'thinking' ? 'thinking...' : 'error'}
					</span>
				{/if}
			</div>

			<div class="right-controls">
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
	.a2ui-voice-shell {
		position: fixed;
		bottom: 0;
		left: clamp(220px, 18vw, 450px);
		right: 0;
		background: var(--a2ui-shell-bg, var(--pico-card-background-color));
		border-top: 1px solid var(--a2ui-shell-border, var(--pico-muted-border-color));
		z-index: 999;
		padding: 0.5rem 1rem;
		transition:
			box-shadow 0.3s ease,
			border-top-color 0.3s ease;
	}

	@media (max-width: 768px) {
		.a2ui-voice-shell {
			left: 0;
		}
	}

	.a2ui-voice-shell.glowing {
		box-shadow: 0px -4px 20px var(--a2ui-shell-glow, var(--pico-primary-focus));
		border-top-color: var(--a2ui-shell-border-active, var(--pico-primary-border));
	}

	.chat-wrapper {
		border-bottom: 1px solid var(--a2ui-shell-border, var(--pico-muted-border-color));
	}

	.chat-container {
		height: 50vh;
		display: flex;
		flex-direction: column;
		padding-top: 1rem;
		max-width: 800px;
		margin: 0 auto;
	}

	.a2ui-voice-controls {
		background: var(--a2ui-shell-bg, var(--pico-card-background-color));
		display: flex;
		justify-content: space-between;
		align-items: center;
		height: 70px;
		padding: 0 1rem;
		max-width: 800px;
		margin: 0 auto;
	}

	.left-controls,
	.right-controls {
		flex: 1;
	}

	.left-controls {
		display: flex;
		justify-content: flex-start;
	}

	.right-controls {
		display: flex;
		justify-content: flex-end;
	}

	.transcript {
		flex: 1;
		border: 1px solid var(--pico-border-color);
		border-radius: var(--pico-border-radius);
		padding: 1rem;
		overflow-y: auto;
		background: var(--pico-card-sectioning-background-color);
		margin-bottom: 1rem;
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
	}

	.message.user {
		background: var(--pico-primary-background);
		color: var(--pico-primary-inverse);
		align-self: flex-end;
		border-bottom-right-radius: 2px;
	}

	.message.model {
		background: var(--pico-secondary-background);
		color: var(--pico-secondary-inverse);
		align-self: flex-start;
		border-bottom-left-radius: 2px;
	}

	.placeholder {
		color: var(--pico-muted-color);
		text-align: center;
	}

	.mic-container {
		flex: 0 0 auto;
		display: flex;
		justify-content: center;
		align-items: center;
		position: relative;
	}

	.status-badge {
		position: absolute;
		left: calc(100% + 8px);
		top: 50%;
		transform: translateY(-50%);
		font-size: 0.65rem;
		font-weight: 600;
		letter-spacing: 0.02em;
		white-space: nowrap;
		pointer-events: none;
	}

	.status-badge.thinking {
		color: var(--pico-primary);
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
		background-color: var(--pico-primary);
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

	.mic-button {
		width: 56px;
		height: 56px;
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
		background: var(--pico-primary-background);
		color: var(--pico-primary-inverse);
	}

	.mic-button svg {
		width: 24px;
		height: 24px;
	}

	.reset-convo-btn,
	.expand-btn {
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

	.expand-btn svg {
		width: 20px;
		height: 20px;
	}

	@keyframes pulse-border {
		0% {
			box-shadow: 0 0 0 0 var(--pico-primary-focus);
		}
		70% {
			box-shadow: 0 0 0 15px transparent;
		}
		100% {
			box-shadow: 0 0 0 0 transparent;
		}
	}
</style>
