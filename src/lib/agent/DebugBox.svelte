<script lang="ts">
	import { type AgentDebugStats, formatBytes, formatTokens } from './debug.svelte';

	interface Props {
		/** The reactive telemetry to render (an agent's `debug`). */
		debug: AgentDebugStats;
		/** Heading shown top-left. */
		title?: string;
		/** Called when the user clicks the × close button. Omit it to hide the button. */
		onClose?: () => void;
	}

	let { debug: d, title = 'Token debug', onClose }: Props = $props();

	const tr = $derived(d.outbound['tool-result']);
	const cu = $derived(d.outbound['context-update']);
	const sp = $derived(d.outbound['system-prompt']);
</script>

<div class="a2ui-debug-box">
	<div class="a2ui-debug-head">
		<strong>{title}</strong>
		<span class="a2ui-debug-sub">exact bytes · est. tokens · provider usage</span>
		{#if onClose}
			<button
				type="button"
				class="a2ui-debug-close"
				onclick={onClose}
				aria-label="Hide debug stats"
				title="Hide debug stats">×</button
			>
		{/if}
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
			<span class="v"
				>↑ {formatBytes(d.outbound['audio-out'].bytes)} · ↓ {formatBytes(
					d.inbound['audio-in'].bytes
				)}</span
			>
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
					{#if e.bytes != null}<span class="sz"
							>{formatBytes(e.bytes)}{#if e.estTokens}/~{formatTokens(e.estTokens)}t{/if}</span
						>{/if}
					{#if e.note}<span class="note">{e.note}</span>{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
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
		color: var(--a2ui-shell-accent-bg);
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
</style>
