# Evals

Model-in-the-loop evaluation suite — **separate from the unit tests**
(`pnpm test` never touches this directory; `pnpm eval` never runs the unit
suite). A real Gemini text model drives real mounted surfaces through the real
`Agent` + `GeminiTextTransport`, and scenarios assert on tool results and the
resulting UI state.

## Why it exists

A2UI's JSON representation is verbose, and the library's historical defaults
amplify it: the whole serialized surface rides in the system prompt
(pretty-printed), and — with `toolResultExtras: true` — every tool result
echoes the full surface again. On dense surfaces this exhausts provider quotas
and slows dynamic generation. The evals quantify that cost and answer the
follow-up question: **do the context optimizations
(`toolResultExtras: 'diff'`, `compactSurfaceJson`) make the agent unstable?**

## Running

```bash
# Hermetic context-cost measurement only (no network, no key):
pnpm eval

# Full run including LLM scenarios:
GEMINI_API_KEY=… pnpm eval

# …or put GEMINI_API_KEY (and any A2UI_EVAL_* knob) in a repo-root .env —
# the eval config loads it into process.env. A var set on the command line
# always wins over the .env file.

# Knobs:
A2UI_EVAL_MODEL=gemini-3.5-flash      # model under test
A2UI_EVAL_PROFILES=baseline,optimized # subset of the profile matrix
A2UI_EVAL_TURN_GAP_MS=30000           # min gap between conversation turns (quota pacing)
A2UI_EVAL_MAX_RETRIES=1               # 429 retries (exponential backoff) before failing
```

### Surviving provider quotas

A full matrix run sends a lot of turns in a short window and free-tier keys hit
the per-minute quota partway through, after which calls return HTTP 429. Two
mechanisms keep a run alive:

- **Turn gap** (`A2UI_EVAL_TURN_GAP_MS`, default `30000`) — the harness waits at
  least this long between consecutive conversation turns (spanning scenarios),
  pacing the run proactively. This lives in the eval harness, not the transport,
  so the live agent is never slowed. The per-test timeout scales with it.
- **Backoff retries** (`A2UI_EVAL_MAX_RETRIES`, default `1`) — any 429 that still
  slips through (e.g. a burst within a single turn's tool loop) is retried with
  exponential backoff, honouring the server's `retryDelay` hint, and announced
  as a debug `'notice'`. It only surfaces as an error once exhausted.

Set `A2UI_EVAL_TURN_GAP_MS=0` on a paid key with generous quota to run at full
speed.

Each LLM scenario runs once per **profile**:

| Profile     | Surface options               | Agent options              |
|-------------|-------------------------------|----------------------------|
| `baseline`  | defaults (full surface echo)  | pretty JSON                |
| `optimized` | `toolResultExtras: 'diff'`    | `compactSurfaceJson: true` |
| `bare`      | `toolResultExtras: false`     | `compactSurfaceJson: true` |

## Files

- `context-cost.eval.ts` — hermetic measurement: prompt sizes (pretty vs
  compact, scaling with surface density), per-call tool-result sizes per echo
  mode, and the cumulative billed input over a realistic 7-call task on both
  transport families. Always runs; doubles as a regression test of the
  optimization claims.
- `llm-scenarios.eval.ts` — live A/B scenarios (skipped without
  `GEMINI_API_KEY`): single-field edit, batch edit, *add-staff-then-edit*
  (the stability probe — the model must target a field that only exists after
  its own structural change), a read-only comprehension question, and a
  dynamic-surface build+update task.
- `fixtures/ShiftPlannerPage.svelte` — dense, realistic static surface
  (roster of N staff × 7 day TextFields, an add-staff form that appends a
  row, a save button that mutates the page context).
- `fixtures/DynamicCanvasPage.svelte` — minimal dynamic-surface host.
- `harness.ts` — profiles, registry cleanup, the `RecordingTransport`
  wrapper (captures tool calls/results/usage), turn-completion waiting.
- `report.ts` — per-scenario result rows + the comparison summary table;
  raw results persist to `results/` (gitignored).

## Reading the results

The summary table prints per scenario × profile: pass/fail, loop request
count, tool calls, billed input/output tokens (provider-reported), and wall
time. The per-profile aggregate at the bottom is the headline: compare the
pass rate and Σ input tokens of `optimized` (and `bare`) against `baseline`.
A pass-rate drop on `add-staff-then-edit` under `bare` is the expected
instability signal; `optimized` is designed to keep that scenario green while
still cutting the bill.
