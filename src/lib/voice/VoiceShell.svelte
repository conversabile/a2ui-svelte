<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { VoiceAgent, VoiceStatus } from './agent.svelte';
	import { type VoiceDebugStats, formatBytes, formatTokens } from './debug.svelte';

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
		 * Enable the token/byte debug panel, bound to `agent.debug`. When set, a
		 * chart-icon button appears in the controls that toggles a stats box above
		 * the controls — collapsed by default so it never blocks the UI.
		 * `true` uses the batteries-included box; pass a snippet to render your own
		 * from the same reactive `VoiceDebugStats` (the toggle still drives it).
		 * Off by default.
		 */
		debug?: boolean | Snippet<[{ debug: VoiceDebugStats }]>;
	}

	let { agent, headless = false, mic, transcript, status, controls, debug = false }: Props =
		$props();

	const showDebug = $derived(debug !== false);
	const customDebug = $derived(typeof debug === 'function' ? debug : null);

	let isChatOpen = $state(false);
	let isDebugOpen = $state(false);
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

	function toggleDebug() {
		isDebugOpen = !isDebugOpen;
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

{#snippet debugBox(d: VoiceDebugStats)}
	{@const tr = d.outbound['tool-result']}
	{@const cu = d.outbound['context-update']}
	{@const sp = d.outbound['system-prompt']}
	<div class="a2ui-debug-box">
		<div class="a2ui-debug-head">
			<strong>Voice token debug</strong>
			<span class="a2ui-debug-sub">exact bytes · est. tokens · provider usage</span>
			<button
				type="button"
				class="a2ui-debug-close"
				onclick={toggleDebug}
				aria-label="Hide debug stats"
				title="Hide debug stats">×</button
			>
		</div>
		<div class="a2ui-debug-grid">
			<div class="a2ui-debug-cell" class:hot={sp.estTokens >= 20000}>
				<span class="k">System prompt</span>
				<span class="v">{formatBytes(sp.lastBytes)} · ~{formatTokens(sp.estTokens)} tok</span>
				<span class="s">{d.toolCount} tools · {formatBytes(d.outbound['tools'].lastBytes)}</span>
			</div>
			<div class="a2ui-debug-cell" class:hot={tr.estTokens >= 20000}>
				<span class="k">Tool results ×{tr.count}</span>
				<span class="v">{formatBytes(tr.bytes)} · ~{formatTokens(tr.estTokens)} tok</span>
				<span class="s">last {formatBytes(tr.lastBytes)} — echoes full surface</span>
			</div>
			<div class="a2ui-debug-cell">
				<span class="k">Context syncs ×{cu.count}</span>
				<span class="v">{formatBytes(cu.bytes)} · ~{formatTokens(cu.estTokens)} tok</span>
				<span class="s">text turns ×{d.outbound['text'].count}</span>
			</div>
			<div class="a2ui-debug-cell">
				<span class="k">Audio</span>
				<span class="v">↑ {formatBytes(d.outbound['audio-out'].bytes)} · ↓ {formatBytes(d.inbound['audio-in'].bytes)}</span>
				<span class="s">est. context pushed ~{formatTokens(d.estOutboundTokens)} tok</span>
			</div>
			<div class="a2ui-debug-cell wide" class:hot={d.usage.peakTotal >= 100000}>
				<span class="k">Provider usage {d.usage.reports ? `×${d.usage.reports}` : '(none yet)'}</span>
				{#if d.usage.last}
					<span class="v"
						>total {d.usage.last.totalTokenCount?.toLocaleString() ?? '?'} · peak {d.usage.peakTotal.toLocaleString()}</span
					>
					<span class="s"
						>prompt {d.usage.last.promptTokenCount?.toLocaleString() ?? '?'} · resp {d.usage.last
							.responseTokenCount?.toLocaleString() ?? '?'}{#if d.usage.last.cachedContentTokenCount} · cached {d.usage.last.cachedContentTokenCount.toLocaleString()}{/if}{#if d.usage.last.details?.length} · {d.usage.last.details
								.map((x) => `${x.modality} ${formatTokens(x.tokenCount)}`)
								.join(' / ')}{/if}</span
					>
				{:else}
					<span class="v">waiting for first usageMetadata…</span>
					<span class="s">authoritative count the quota is measured against</span>
				{/if}
			</div>
		</div>
		{#if d.events.length}
			<div class="a2ui-debug-feed">
				{#each d.events.slice(-6).reverse() as e (e.t + e.kind + (e.note ?? ''))}
					<div class="a2ui-debug-evt {e.dir}">
						<span class="kind">{e.dir === 'out' ? '↑' : '↓'} {e.kind}</span>
						{#if e.bytes != null}<span class="sz">{formatBytes(e.bytes)}{#if e.estTokens}/~{formatTokens(e.estTokens)}t{/if}</span>{/if}
						{#if e.note}<span class="note">{e.note}</span>{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

{#if !headless}
	<div class="a2ui-voice-shell" class:glowing={agent.connected}>
		{#if showDebug && isDebugOpen}
			{#if customDebug}
				{@render customDebug({ debug: agent.debug })}
			{:else}
				{@render debugBox(agent.debug)}
			{/if}
		{/if}
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
							aria-label="Toggle voice debug stats"
							aria-pressed={isDebugOpen}
							title="Toggle voice debug stats"
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

	.a2ui-voice-shell.glowing {
		box-shadow: 0px -4px 20px var(--a2ui-shell-glow, var(--pico-primary-focus));
		border-top-color: var(--a2ui-shell-border-active, var(--pico-primary-border));
	}

	.chat-wrapper {
		border-bottom: 1px solid var(--a2ui-shell-border, var(--pico-muted-border-color));
	}

	/* ── Debug box ──────────────────────────────────────────────────────── */
	.a2ui-debug-box {
		max-width: 800px;
		margin: 0 auto;
		padding: 0.5rem 0.75rem 0.6rem;
		border-bottom: 1px solid var(--a2ui-shell-border, var(--pico-muted-border-color));
		font-size: 0.72rem;
		font-family:
			ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
		color: var(--pico-color);
	}
	.a2ui-debug-head {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		margin-bottom: 0.4rem;
	}
	.a2ui-debug-sub {
		color: var(--pico-muted-color);
		font-size: 0.66rem;
	}
	.a2ui-debug-close {
		margin: -0.2rem -0.2rem 0 auto;
		padding: 0 0.35rem;
		width: auto;
		line-height: 1.2;
		font-size: 1rem;
		background: transparent;
		border: none;
		color: var(--pico-muted-color);
		cursor: pointer;
	}
	.a2ui-debug-close:hover {
		color: var(--pico-color);
	}
	.a2ui-debug-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 0.4rem;
	}
	.a2ui-debug-cell {
		display: flex;
		flex-direction: column;
		gap: 0.05rem;
		padding: 0.3rem 0.45rem;
		border-radius: 6px;
		background: var(--pico-card-sectioning-background-color, rgba(127, 127, 127, 0.08));
		border: 1px solid transparent;
	}
	.a2ui-debug-cell.wide {
		grid-column: 1 / -1;
	}
	/* A "hot" metric is one large enough to plausibly be the quota culprit. */
	.a2ui-debug-cell.hot {
		background: color-mix(in srgb, var(--pico-del-color, crimson) 12%, transparent);
		border-color: color-mix(in srgb, var(--pico-del-color, crimson) 35%, transparent);
	}
	.a2ui-debug-cell .k {
		color: var(--pico-muted-color);
		font-size: 0.66rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}
	.a2ui-debug-cell .v {
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}
	.a2ui-debug-cell .s {
		color: var(--pico-muted-color);
		font-size: 0.66rem;
	}
	.a2ui-debug-feed {
		margin-top: 0.45rem;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		max-height: 5.5rem;
		overflow-y: auto;
	}
	.a2ui-debug-evt {
		display: flex;
		gap: 0.5rem;
		align-items: baseline;
		white-space: nowrap;
	}
	.a2ui-debug-evt .kind {
		flex: 0 0 auto;
		min-width: 8.5rem;
	}
	.a2ui-debug-evt.out .kind {
		color: var(--pico-primary);
	}
	.a2ui-debug-evt.in .kind {
		color: var(--pico-ins-color, seagreen);
	}
	.a2ui-debug-evt .sz {
		flex: 0 0 auto;
		font-variant-numeric: tabular-nums;
	}
	.a2ui-debug-evt .note {
		color: var(--pico-muted-color);
		overflow: hidden;
		text-overflow: ellipsis;
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
		gap: 0.5rem;
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
		background: var(--pico-primary-background);
		color: var(--pico-primary-inverse);
		border-color: var(--pico-primary-border, var(--pico-primary-background));
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
