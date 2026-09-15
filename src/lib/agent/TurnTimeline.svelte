<script lang="ts">
	import {
		formatDuration,
		spanDuration,
		turnDuration,
		type TraceSpan,
		type TraceTurn
	} from './trace.svelte';
	import { formatBytes } from './debug.svelte';

	interface Props {
		/** The turn to chart. */
		turn: TraceTurn;
	}

	let { turn }: Props = $props();

	// One clock for the whole chart. A running turn re-reads it whenever a span
	// closes (that's a reactive write), which is often enough for a debug view —
	// no interval, so an open panel costs nothing while nothing happens.
	const now = $derived(turn.endedAt ?? Date.now());
	const total = $derived(Math.max(turnDuration(turn, now), 1));
	const toolCount = $derived(turn.spans.filter((s) => s.kind === 'tool').length);
	const failed = $derived(turn.spans.some((s) => s.tool?.status === 'error'));
	const meta = $derived(
		[
			`turn #${turn.id}`,
			toolCount ? `${toolCount} tool${toolCount === 1 ? '' : 's'}` : null,
			failed ? 'tool error' : null
		]
			.filter(Boolean)
			.join(' · ')
	);

	/** Left offset + width of a span's bar, in percent of the turn. */
	function bar(span: TraceSpan): string {
		const left = ((span.startedAt - turn.startedAt) / total) * 100;
		const width = (spanDuration(span, now) / total) * 100;
		return `left:${Math.min(left, 100).toFixed(2)}%;width:${Math.max(Math.min(width, 100 - left), 0.5).toFixed(2)}%`;
	}

	function label(span: TraceSpan): string {
		return span.kind === 'tool' ? span.name : span.kind;
	}

	function duration(span: TraceSpan): string {
		return span.endedAt == null ? '…' : formatDuration(spanDuration(span, now));
	}

	/** "output · success" — the tool's own return value. */
	function outputLabel(span: TraceSpan): string {
		const detail = span.tool;
		if (!detail) return 'output';
		return `output · ${detail.status ?? 'running'}`;
	}

	/**
	 * "surface echo · surfaceDelta 240 B · updatedContext 120 B" — what the
	 * agent appended to the result. Named per key, because one of them is
	 * usually the whole payload.
	 */
	function echoLabel(span: TraceSpan): string {
		const parts = span.tool?.echoParts ?? [];
		if (parts.length === 0) return 'surface echo';
		return `surface echo · ${parts.map((p) => `${p.key} ${formatBytes(p.bytes)}`).join(' · ')}`;
	}

	/** "1.2 KB → 32.1 KB sent" — the result's own size vs what went on the wire. */
	function sentLabel(span: TraceSpan): string {
		const detail = span.tool;
		if (!detail || detail.sentBytes == null) return '';
		return `${formatBytes(detail.sentBytes)} sent to the model`;
	}

	// Which payload was copied last, so its button can confirm. Cleared on a
	// timer; one id at a time is enough (a second copy replaces the first).
	let copied = $state<string | null>(null);
	let copiedTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Copy one payload verbatim. `navigator.clipboard` needs a secure context
	 * (localhost counts, plain-http LAN does not), so fall back to the
	 * selection-based path rather than failing silently on a dev box.
	 */
	async function copy(text: string, key: string): Promise<void> {
		let ok = false;
		try {
			await navigator.clipboard.writeText(text);
			ok = true;
		} catch {
			ok = copyViaSelection(text);
		}
		if (copiedTimer) clearTimeout(copiedTimer);
		copied = ok ? key : null;
		if (ok) copiedTimer = setTimeout(() => (copied = null), 1400);
		else console.warn('[a2ui] Could not copy to the clipboard.');
	}

	function copyViaSelection(text: string): boolean {
		const el = document.createElement('textarea');
		el.value = text;
		el.setAttribute('readonly', '');
		el.style.position = 'fixed';
		el.style.opacity = '0';
		document.body.appendChild(el);
		el.select();
		let ok = false;
		try {
			ok = document.execCommand('copy');
		} catch {
			ok = false;
		}
		document.body.removeChild(el);
		return ok;
	}
</script>

{#snippet payload(text: string, key: string)}
	<div class="payload">
		<button
			type="button"
			class="copy"
			class:done={copied === key}
			onclick={() => copy(text, key)}
			title={copied === key ? 'Copied' : 'Copy to clipboard'}
			aria-label={copied === key ? 'Copied' : 'Copy to clipboard'}
		>
			{#if copied === key}
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg
				>
			{:else}
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
					<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
				</svg>
			{/if}
		</button>
		<pre>{text}</pre>
	</div>
{/snippet}

<div class="a2ui-turn-trace" class:failed>
	<div class="head">
		<span class="total">{turn.endedAt == null ? '…' : formatDuration(total)}</span>
		<span class="meta">{meta}</span>
	</div>

	<ol class="spans">
		{#each turn.spans as span, i (i)}
			<li class="span {span.kind}" class:error={span.tool?.status === 'error'}>
				{#if span.tool}
					<details>
						<summary>
							<span class="caret" aria-hidden="true">▸</span>
							<span class="label">{label(span)}</span>
							<span class="track"
								><span class="rail" style={bar(span)} class:running={span.endedAt == null}
								></span></span
							>
							<span class="ms">{duration(span)}</span>
						</summary>
						<div class="detail">
							<div class="kv">input</div>
							{@render payload(span.tool.args, `${i}-args`)}
							<div class="kv">{outputLabel(span)}</div>
							{@render payload(span.tool.output ?? '—', `${i}-output`)}
							{#if span.tool.echo}
								<div class="kv">{echoLabel(span)}</div>
								{@render payload(span.tool.echo, `${i}-echo`)}
							{/if}
							{#if sentLabel(span)}
								<div class="kv total-sent">{sentLabel(span)}</div>
							{/if}
						</div>
					</details>
				{:else}
					<div class="row">
						<span class="caret" aria-hidden="true"></span>
						<span class="label">{label(span)}</span>
						<span class="track"
							><span class="rail" style={bar(span)} class:running={span.endedAt == null}
							></span></span
						>
						<span class="ms">{duration(span)}</span>
					</div>
				{/if}
			</li>
		{/each}
	</ol>
</div>

<style>
	/* A turn's latency waterfall, rendered inline in the transcript between the
	   user message and the agent's answer. Dev-facing, so it reads as a tool
	   panel rather than a chat bubble: full width, monospace, muted. */
	.a2ui-turn-trace {
		align-self: stretch;
		padding: 0.4rem 0.55rem;
		border: 1px solid var(--a2ui-trace-border);
		border-radius: var(--a2ui-border-radius);
		background: var(--a2ui-trace-bg);
		font-family:
			ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
		font-size: 0.68rem;
		color: var(--a2ui-trace-fg);
	}

	.head {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		margin-bottom: 0.3rem;
	}

	.total {
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	.meta {
		color: var(--a2ui-trace-muted-fg);
	}

	.spans {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}

	/* The three-cell row (label · track · duration) is shared by plain spans and
	   by the <summary> of an expandable tool span, so the bars stay aligned. */
	.row,
	summary {
		display: grid;
		grid-template-columns: 0.75rem minmax(5rem, 8rem) 1fr 4rem;
		align-items: center;
		gap: 0.4rem;
	}

	summary {
		cursor: pointer;
		list-style: none;
	}

	summary::-webkit-details-marker {
		display: none;
	}

	.caret {
		color: var(--a2ui-trace-muted-fg);
		transition: transform 0.15s ease;
	}

	details[open] .caret {
		transform: rotate(90deg);
	}

	.label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.track {
		position: relative;
		height: 0.55rem;
		border-radius: 3px;
		background: var(--a2ui-trace-track-bg);
	}

	.rail {
		position: absolute;
		top: 0;
		bottom: 0;
		border-radius: 3px;
		background: var(--a2ui-trace-thinking);
	}

	.span.generating .rail {
		background: var(--a2ui-trace-generating);
	}

	.span.tool .rail {
		background: var(--a2ui-trace-tool);
	}

	.span.error .label {
		color: var(--a2ui-trace-error);
	}

	.span.error .rail {
		background: var(--a2ui-trace-error);
	}

	/* A turn with a failed tool call is the one a developer is looking for. */
	.a2ui-turn-trace.failed {
		border-color: var(--a2ui-trace-error);
	}

	/* A span still running has no end yet — pulse instead of reporting a
	   number that would be stale the moment it is painted. */
	.rail.running {
		animation: a2ui-trace-pulse 1.2s ease-in-out infinite;
	}

	@keyframes a2ui-trace-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}

	.ms {
		text-align: right;
		font-variant-numeric: tabular-nums;
		color: var(--a2ui-trace-muted-fg);
	}

	.detail {
		margin: 0.25rem 0 0.4rem 1.15rem;
	}

	.kv {
		color: var(--a2ui-trace-muted-fg);
		text-transform: uppercase;
		letter-spacing: 0.03em;
		font-size: 0.62rem;
		margin-top: 0.25rem;
	}

	/* The bottom line: what actually went on the wire, result + echo. */
	.kv.total-sent {
		margin-top: 0.4rem;
		font-weight: 700;
		color: var(--a2ui-trace-fg);
	}

	/* The payload panes hold the FULL json (nothing is truncated), so they cap
	   their own height and scroll — the copy button is what gets the whole
	   thing out. */
	.payload {
		position: relative;
	}

	.detail pre {
		margin: 0.1rem 0 0;
		/* Right padding leaves room for the copy button. */
		padding: 0.35rem 2rem 0.35rem 0.45rem;
		max-height: 12rem;
		overflow: auto;
		border-radius: var(--a2ui-border-radius);
		background: var(--a2ui-trace-track-bg);
		font-size: 0.65rem;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		color: inherit;
	}

	.copy {
		position: absolute;
		top: 0.3rem;
		right: 0.3rem;
		z-index: 1;
		width: 1.5rem;
		height: 1.5rem;
		padding: 0.25rem;
		margin: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--a2ui-trace-border);
		border-radius: var(--a2ui-border-radius);
		background: var(--a2ui-trace-bg);
		color: var(--a2ui-trace-muted-fg);
		cursor: pointer;
		opacity: 0.75;
	}

	.copy:hover {
		opacity: 1;
		color: var(--a2ui-trace-fg);
	}

	.copy.done {
		opacity: 1;
		color: var(--a2ui-trace-tool);
		border-color: var(--a2ui-trace-tool);
	}

	.copy svg {
		width: 100%;
		height: 100%;
	}
</style>
