# Implementation Plan — Testing & evals for consumer apps (v3)

**Status:** in progress — WP0 done (changeset stashed), WP1 and WP1b done.
See §5.
**Supersedes:** [testing-and-evals-v2.md](testing-and-evals-v2.md) and
[testing-and-evals-v1.md](testing-and-evals-v1.md), plus the staged-but-uncommitted
`src/lib/testing/` changeset (see WP0).
**Audit:** every file path, line number, and claim below was verified against the
working tree on 2026-08-27; WP1 and WP2 were reproduced with a live test.
**Related:** [CLAUDE.md](../../CLAUDE.md) (Rule 7 tests, Rule 8 public API),
[evals/README.md](../../evals/README.md).

---

## 0. Thesis

**Almost everything a user needs is already exported.**

| need | use |
|---|---|
| make the agent click/type | `toolRegistry.execute('click_button', { element_id })` — `a2ui-svelte/core` |
| a deterministic model | `ScriptedTransport` — `a2ui-svelte/agent` |
| record what the model got | `ScriptedTransport.textsSent` / `.toolResults` / `.connectOpts` |
| the assembled system prompt | `ScriptedTransport.connectOpts.systemInstruction` |
| token accounting | `agent.debug.usage` (`last`, `peakTotal`, `reports`, `sumResponseTokens`) |
| the human actor | `@testing-library/user-event` |

So **this plan ships almost no new API.** It fixes the bugs that make the
existing classes unusable in a test, closes six gaps, and writes the docs. The
only new subpath is `a2ui-svelte/testing`, holding exactly three functions.

**Do not build a test framework.** If a WP seems to need one of these, the WP is
wrong:

| don't build | use |
|---|---|
| `conversation()` / `chat` | `new Agent(def, transport)` **is** the conversation |
| `scriptedModel()` | `new ScriptedTransport([...])` |
| `RecordingTransport` | `ScriptedTransport` already records — `textsSent`, `toolResults`, `connectOpts` |
| an `agent` / `assistant` actor beyond WP9b's three functions | `Agent`'s own dispatch *is* `toolRegistry.execute` ([agent.svelte.ts:839](../../src/lib/agent/agent.svelte.ts#L839)); WP9b adds only the throw-on-failure those three need |
| an `a2ui-svelte/evals` subpath | `agent.debug.usage` for tokens; `withoutAudio` ships from `./agent` (WP9) |
| `clearRegistries`, `stubJsdomGaps`, `sendAndWait`, `estTokens` | each is a bug wearing a helper costume — fix it at the source: WP4, WP5, WP6 |

**The placement rule.** An export goes in `a2ui-svelte/testing` **iff it is
useless or harmful in a running app** — `agentCall` throws where production must
fold the failure into `{ status: 'error' }` so the model can recover. Everything
a consumer could build their app with stays in the framework subpaths, even when
tests are its only user today:

| export | subpath | why |
|---|---|---|
| `mountedSurfaces()`, `surface(id)` (WP7) | `./core` | `surfaces: mountedSurfaces` is production `AgentDefinition` wiring |
| `validateSurface()` (WP10) | `./core` | `<StaticSurface>` calls it on mount under `DEV` |
| `withoutAudio()` (WP9) | `./agent` | a real `AgentTransport` wrapper; valid in any headless deployment |
| `ScriptedTransport` | `./agent` (unchanged) | implements the production contract faithfully — usable for demos and offline mode |
| `agentCall`, `agentClick`, `agentFill` (WP9b) | `./testing` | invert production behaviour; dangerous in app code |
| `window.__a2ui` (WP8) | neither — installed, never imported | |

`./testing` carries this rule as a charter comment (WP9b). Keep it to the three
functions.

### 0.1 WP0 — Unwind the staged changeset first

There is a staged, uncommitted changeset on this branch adding
`src/lib/testing/{harness,index,validate-surface,validate-surface.test}.ts`,
`docs/guides/testing.md`, a `./testing` entry in `package.json` `exports`, a
Rule 8 edit to `CLAUDE.md`, and a refactor of [evals/harness.ts](../../evals/harness.ts)
(and, via re-export, [evals/context-cost.eval.ts](../../evals/context-cost.eval.ts))
to import from `src/lib/testing/harness.ts`. **The changeset is live and
load-bearing**: deleting `src/lib/testing/harness.ts` before touching the evals
breaks the build.

**Do not commit it as-is.** It publishes a Rule 8 surface (`./testing` with
seven exports) this plan immediately shrinks to three, and Phase 1 deletes
roughly half of it.

**Sequence (git operations are yours to run):**

```bash
git diff --cached > /tmp/a2ui-testing-wip.patch   # keep as reference
git stash push --staged -m "wip: testing helpers (superseded by testing-and-evals-v3)"
```

This returns the tree to HEAD, where `evals/harness.ts` (359 lines) is
self-contained. Every WP below assumes that state. From the patch, cherry-pick
by hand later — never `git stash pop`:

- `src/lib/testing/validate-surface{,.test}.ts` → reused by WP10 (moves to core);
- the `CLAUDE.md` Rule 8 text and `package.json` `./testing` entry → re-land in
  WP9b's commit;
- `docs/guides/testing.md` → superseded; WP12 writes the guide from §1;
- everything else (`harness.ts`, `index.ts`, the evals refactor) → superseded,
  reference only.

---

## 1. How users should test — the recommendation

Three activities: component tests (§1.1, and §1.2 when an `Agent` must be
attached), end-to-end (§1.3), evals against a real model (§1.4). This section
is the spec for the docs (WP12).

### 1.1 Component tests — Vitest + jsdom

**What you're testing:** that when the agent acts, your app reacts — and that
what a human does is visible to the agent. No model, no transport: you call the
same tool registry a real model hits.

```ts
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
// `surface` lands in WP7, the agent* helpers in WP9b.
import { surface } from 'a2ui-svelte/core';
import { agentClick, agentFill } from 'a2ui-svelte/testing';
import ShiftPlanner from './ShiftPlanner.svelte';

test('the agent can add a staff member', async () => {
	render(ShiftPlanner);

	await agentFill('add-staff-name', 'Giulia');
	await agentFill('add-staff-role', 'Cook');
	await agentClick('add-staff-btn');

	expect(screen.getByText('Giulia')).toBeInTheDocument();
});

test('a human edit is visible to the agent', async () => {
	render(ShiftPlanner);
	await userEvent.type(screen.getByLabelText('Anna Monday'), '10:00-18:00');

	expect(surface('shift-planner').getDataModel()['shift-anna-mon']).toBe('10:00-18:00');
});
```

**What we give you:** `agentClick` / `agentFill` / `agentCall` (WP9b) drive the
registry and **throw at the call site** when the id doesn't exist — bare
`toolRegistry.execute` folds the failure into its result instead, and the test
dies three lines later on an unrelated assertion. `surface(id)` (WP7) hands you
the tree and data model the agent sees. (`@testing-library/user-event` is the
user's own devDependency — and ours too, from WP9b, so these snippets run
verbatim in this repo.)

**Covered:**

- your state and DOM after an agent action;
- a human edit reaching the agent's view — where a hand-written `a2ui:`
  projection on a custom or composite component breaks;
- the control being agent-reachable under that id at all. For a plain catalog
  Button that is the *only* thing this adds over a `userEvent.click` test — but a
  bare `<button>` or a composite wired to the wrong handler passes the human
  version and fails this one.

**Not covered:**

- that `update_text_field` sets a value, or that a failing handler returns
  `status: 'error'` — ours, covered by our suite;
- whether a real model would pick that id — no model runs here (§1.4);
- whether your `contextInstructions` name the ids your template registers. The id
  in the test is a hardcoded string, like a CSS selector; rename it in the
  template and the test and the prompt still points at a ghost. Compare the two
  live sources instead:

```ts
import { actionRegistry } from 'a2ui-svelte/core';
import { shiftPlanner } from './agent-definition';   // the prompt your app ships — §1.4

test('every id the instructions name is really registered', () => {
	render(ShiftPlanner);
	const live = new Set(actionRegistry.listActions());
	const prompt = shiftPlanner.instructions + (shiftPlanner.contextInstructions?.() ?? '');
	const named = prompt.match(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/g) ?? [];

	for (const id of named) expect(live).toContain(id);
});
```

The regex is crude. Declaring the ids once as a const and referencing it from
both the template and the instructions deletes the failure mode instead of
testing for it; keep the test for surfaces whose instructions are prose.

### 1.2 Tests that need a live `Agent` — `ScriptedTransport`

**What you're testing:** your code that only runs with an agent attached — UI
bound to `agent.status` or `agent.transcript`, a `userActionBus.emit` you fire
yourself, a `buildPrompt` override. Same runner and tier as §1.1.

**What we give you:** [`ScriptedTransport`](../../src/lib/agent/scripted-transport.ts),
a deterministic stand-in model that replies from a script and records what it was
sent (`textsSent`, `toolResults`, `connectOpts`). Don't hand-roll a transport:
its `TransportCapabilities` decide which `Agent` paths run (`streaming`,
`interruptible`, `historyOwnership`, `canInitiateTurn`), and one wrong value
makes the test green against a configuration your app never runs.

```ts
import { render, screen } from '@testing-library/svelte';
import { Agent, ScriptedTransport } from 'a2ui-svelte/agent';
import { shiftPlanner } from './agent-definition';   // your app's own definition — §1.4
import PlannerPage from './PlannerPage.svelte';

// The app disables its own Save button while the agent is mid-turn, so the
// human and the agent can't both write the week.
test('the human Save button locks while the agent is working', async () => {
	const model = new ScriptedTransport([
		{ on: 'save', calls: [{ name: 'click_button', args: { element_id: 'save-week-btn' } }] }
	]);
	const agent = new Agent(shiftPlanner, model);
	render(PlannerPage, { agent });     // mounts the surface `mountedSurfaces` will find
	await agent.start();

	const turn = agent.send('save the week');            // WP6: resolves at turn end
	expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

	await turn;
	expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
	expect(screen.getByText('Week saved')).toBeInTheDocument();
});
```

**The rule:** a scripted reply is a fixture, never an expectation. It exists to
put the agent into the state your code reacts to. Asserting that the tool calls
match the calls you scripted is the script echoing itself.

**The other two cases:**

- an event you emit yourself (`userActionBus.emit`, a route change, a domain
  event): script nothing — `new ScriptedTransport()` is then a pure recorder —
  and assert on `model.textsSent`, the agent's output rather than yours;
- a `buildPrompt` override
  ([agent.svelte.ts:169](../../src/lib/agent/agent.svelte.ts#L169)): assert on
  `model.connectOpts!.systemInstruction`. Fair *because* you overrode it —
  without an override that asserts our prompt builder.

Most apps use stock `<AgentShell>`, emit no events of their own and don't
override prompt assembly. They need none of this.

### 1.3 End-to-end — Playwright

**What you're testing:** a whole journey against your real build — real CSS,
routing, network — in a real browser. Slow, so keep it for journeys, not for the
per-component checks §1.1 already covers.

**The problem:** the test runs in node, your app runs in the browser. Two
processes, no shared memory, so the test can't import `toolRegistry` and make the
agent act. Playwright's bridge is `page.evaluate(fn)`, which runs `fn` inside the
page — so the registries have to be reachable from in there.

**What we give you:** `window.__a2ui` (WP8), installed by the library with
`<StaticSurface>` (nothing to wire up), typed, and forwarding straight to the
registries a real model drives — no behaviour of its own to get wrong:

```ts
window.__a2ui.execute(tool, args)   // exactly the dispatch a real model runs
window.__a2ui.tools()               // tool names the agent can call
window.__a2ui.surfaces()            // ids of the mounted surfaces
window.__a2ui.json(id?)             // the surface JSON the agent sees
```

One test then covers both actors on the same UI:

```ts
test('agent and human share the same UI', async ({ page }) => {
	await page.goto('/planner');

	await page.getByLabel('Anna Monday').fill('10:00-18:00');          // human
	await page.evaluate(() =>                                          // agent
		window.__a2ui!.execute('click_button', { element_id: 'save-week-btn' })
	);

	await expect(page.getByText('Week saved')).toBeVisible();
});
```

**It is not in your production build.** The handle is guarded by
`import.meta.env.DEV`, which your bundler replaces with `false` at build time and
drops. Ours doesn't: `svelte-package` transpiles file by file, so `__a2ui` *is*
present in `a2ui-svelte`'s published `dist/` — correct, and erased by your build.
Verify your own output:

```
vite build && grep -r __a2ui dist/     # expect no match
```

A full voice or text round trip needs a real model — that's an eval (§1.4), not a
test: it costs money and is non-deterministic.

### 1.4 Evals — a real model

**What you're testing:** whether a real model, given the prompt your app ships,
actually does what the user asked — and what that costs. Render your page, attach
your agent to a real transport, send a message, assert. Your own `*.eval.ts`
files with your own runner (ours: [evals/](../../evals/)), never `pnpm test`:
they cost money and are non-deterministic.

```ts
import { render, screen } from '@testing-library/svelte';
import { Agent } from 'a2ui-svelte/agent';
import { GeminiTextTransport } from 'a2ui-svelte/agent/gemini';
import { shiftPlanner } from '../src/lib/agent-definition';    // your app's agent
import PlannerPage from '../src/routes/planner/+page.svelte';  // your app's page

it('sets a shift', async () => {
	render(PlannerPage);
	const agent = new Agent(shiftPlanner, new GeminiTextTransport({ apiKey, model }));
	await agent.start();

	await agent.send("Set Anna's Wednesday shift to 10:00-18:00");    // WP6

	expect(screen.getByLabelText('Anna Wednesday')).toHaveValue('10:00-18:00');
	expect(agent.debug.usage.peakTotal).toBeLessThan(8_000);          // what it cost
	await agent.stop();
});
```

**It is your agent.** An `Agent` is your definition plus a transport, and the
eval changes only the transport — node has no browser to mint a token, and each
scenario wants a fresh conversation. So keep the definition in a module
(`src/lib/agent-definition.ts`) that your layout and your evals both import; with
`surfaces: mountedSurfaces` (WP7) it needs no other wiring.

**Assert on your app**, through the same handles as §1.1: the DOM (`screen`), the
surface the model saw (`surface('shift-planner').getDataModel()`), what it
replied (`agent.transcript`), what it cost (`agent.debug.usage`).

**Fail loudly on a bad setup.** `agent.start()` records connect failures in
`agent.configIssue` instead of throwing, so add
`if (agent.configIssue) throw new Error(agent.configIssue)` — otherwise a wrong
API key reads as the model getting the answer wrong.

To eval a **voice** transport under node, wrap it (WP9):

```ts
new Agent(shiftPlanner, withoutAudio(new GeminiLiveTransport({ … })));
```

The model still generates audio, so the token bill is unchanged — exactly the
production load. The frames are dropped and the output transcription carries the
text.

---

## 2. Cross-cutting constraints

- **Rule 6 — transport neutrality.** No `instanceof` on transports in `Agent`,
  `<AgentShell>`, or `src/lib/core/`. Provider quirks are normalized inside the
  provider adapter.
- **Rule 7 — tests ship with behaviour.** Every WP lands with co-located
  `*.test.ts`. Run `pnpm test` before declaring done.
- **Rule 8 — public API discipline.** One new subpath, `./testing`, holding only
  WP9b's three helpers (the placement rule in §0). Everything else is added to
  `./core` (WP7, WP10) and `./agent` (WP6, WP9).
- **One WP = one closed conventional commit.** Each WP's commit contains its
  code, its tests, **and every doc/skill/example its change invalidates** — so
  the tree is consistent at every commit and `standard-version` renders a
  changelog where each entry is a finished thing. Breaking WPs (WP2, WP9c) use
  the `!` marker **and** a `BREAKING CHANGE:` footer describing the migration.
  WP12 holds only the *new* documents, not fixes to existing ones.
- **Do not run `pnpm lint` / `pnpm format`** — no config in the repo; Prettier
  corrupts the tabs + single-quote style.
- **You do the changes, the user commits.** Never operate git — including WP0's
  stash, which is the user's to run.

---

## PHASE 1 — Bugs

Five independent `fix:` commits. No dependency on anything else in this plan
(WP0 aside).

### WP1 — TextField ignores its update action when only an `id` is given — DONE

**Reproduced 2026-08-27** with a throwaway test. Two TextFields in a surface:

```svelte
<TextField id="only-id"    label="A" bind:value={a} />
<TextField id="with-field" fieldName="with-field" label="B" bind:value={b} />
```

`actionRegistry.has('with-field', 'update')` → `true`.
`actionRegistry.has('only-id', 'update')` → **`false`**.

**Effect.** The field is serialized into the surface JSON, so the agent sees it
and tries to write to it, and `update_text_field` throws
`No "update" action registered for element "only-id"`. Readable, not writable.
Nothing warns.

**Cause.** [TextField.svelte:109](../../src/lib/components/TextField.svelte#L109)
registers the action only when `fieldName` is set (`action: fieldName ? … :
undefined`), while the value binding a few lines up
([line 99](../../src/lib/components/TextField.svelte#L99)) uses
`fieldName ?? componentId`. Same identifier, two rules in one component.

**Fix.** Register unconditionally, keyed by `fieldName ?? componentId` — which is
what Checkbox, Slider, DateTimeInput, Tabs and MultipleChoice already do
(they have no ternary). The action's result payload (`{ field, message }`) uses
the same fallback, matching
[Slider.svelte:66](../../src/lib/components/Slider.svelte#L66)'s
`fieldName ?? id ?? ''`.

**Not in scope: `fieldName` itself.** It is not redundant with `id` and must
stay. `id` names a component in the tree; `fieldName` names a value in the data
model (`dataSources`, a separate map —
[surface-registry.ts:19](../../src/lib/core/surface-registry.ts#L19)). They
differ when two components edit one value:

```svelte
<Slider    id="portions-slider" fieldName="portions" bind:value={portions} />
<TextField id="portions-input"  fieldName="portions" bind:value={portions} />
```

Two ids (the agent must target each), one field key (the app has one value).
Collapse them and this is unrepresentable. What is wrong today is only that the
fallback is missing in one place, and that our own docs and fixtures write both
names when they are identical.

**Tests.** Co-located `TextField.test.ts`: the two-field case above; a fill
through `toolRegistry.execute` on an id-only field lands in the data model.

**In this commit (closure):** state in
[docs/reference/components.md](../../docs/reference/components.md) when
`fieldName` is needed (shared data key) and that it defaults to the id;
drop `fieldName={id}` from any fixture/example/skill where the two are equal.

**Commit:** `fix(components): register TextField update action when only an id is given`

---

### WP1b — The data-model key has one spelling everywhere — DONE

**Spotted during WP1.** Two leftovers of the defect WP1 fixed in TextField.

1. **Checkbox, Slider, DateTimeInput and MultipleChoice report
   `field: fieldName ?? id ?? ''`** ([Slider.svelte:66](../../src/lib/components/Slider.svelte#L66)
   and the same line in the other three). With neither prop set the component
   still has an auto-generated id and a data source keyed by it — so the tool
   result tells the model it wrote a field called `""`.
2. **[build-custom-component.md](../../src/lib/skills/build-custom-component.md#L60-L66)
   teaches the opposite of every built-in**: `data: fieldName ? { … } : undefined`
   next to an inlined `value: { literalNumber: value }`. A component built from
   that skill registers no data source without a `fieldName`, and its value rides
   in the structural snapshot — which is exactly what pushes `'sync'`-mode
   delivery off the cheap delta path the built-ins path-bind to stay on.

**Fix.** Make both obey the rule WP1 wrote into
[authoring-components.md](../../docs/guides/authoring-components.md) §`action`:
**a value-bearing component's data-model key is `fieldName ?? componentId`** — it
path-binds to that key, registers its data source under it, and reports it back
in the action result.

1. The four components: `field: fieldName ?? handle.componentId ?? ''`. They
   already annotate the handler `Promise<unknown>`, which is what breaks the
   circular type inference WP1 hit.
2. The skill's example: unconditional `data: { key: fieldName, value: () => value }`,
   and `a2ui: (componentId) => { const bindingKey = fieldName ?? componentId; … }`
   with the literal kept only as the no-surface fallback — matching the built-ins
   and the JSON block printed under it.

**Tests.** One case per value-bearing component, on WP1's
[TextField.test.ts](../../src/lib/components/TextField.test.ts) pattern: mounted
with neither `id` nor `fieldName`, an `update_text_field` on the auto-generated
id reports that id as `field`.

**Commit:** `fix(components): report the resolved data-model key in update results`

---

### WP2 — A Button without `action` is dead for the human too

**Reproduced 2026-08-27** with a throwaway test.
`<Button label="Save" id="save-btn" onclick={fn} />` — no `action` prop — does
**not** call `fn` when a human clicks it.

**Cause.** The DOM handler is `onclick={() => handle.fire()}`
([Button.svelte:81](../../src/lib/components/Button.svelte#L81)), and `fire()`
returns early on `if (!opts.action)`
([define-component.svelte.ts:200](../../src/lib/authoring/define-component.svelte.ts#L200)).
The handler closure only exists when the `action` prop is set
([Button.svelte:54](../../src/lib/components/Button.svelte#L54):
`action: action ? { type: 'click', handler: () => onclick?.() } : undefined`).
No `action` ⇒ no handler ⇒ nothing happens, for anyone, silently.

(v2 called the `state_referenced_locally` compiler warning on that line a
"second defect". The warning is real but **catalog-wide** — every component's
setup-time `id` / `label` / `fieldName` capture triggers it, ~30 instances —
so it is ambient noise, not evidence of this bug. Fixing this line removes only
its own instance; a repo-wide warning cleanup is a separate task, not this WP.)

**Fix.**

1. Register the click action **unconditionally**, like every other interactive
   component. The handler closure `() => onclick?.()` already reads `onclick` at
   call time — keep that.
2. Emit `action: { name: componentId }` from inside the reactive `a2ui:` closure
   instead of taking it as a prop, so the JSON stays spec-shaped and
   `action.name === id` holds **by construction**.
3. Replace the `action?: { name: string }` prop with `actionName?: string` for
   the rare case where the semantic action name must differ from the id (the
   spec keeps `name` and `sourceComponentId` separate on `userAction`, and the
   dynamic path uses `name` — [Component.svelte:126](../../src/lib/renderer/Component.svelte#L126),
   [agent.svelte.ts:881](../../src/lib/agent/agent.svelte.ts#L881)).

This is breaking: `action={{ name: 'x' }}` stops being accepted. It removes the
id-written-twice ceremony from every call site —
[ShiftPlannerPage.svelte:144](../../evals/fixtures/ShiftPlannerPage.svelte#L144)
becomes `<Button id="add-staff-btn" label="Add staff" onclick={addStaff} />`.

**A Button with neither `action` nor `onclick`** becomes agent-clickable and does
nothing. That is correct: it is on screen as a Button, so per Rule 4 the agent
must see it, and a button that does nothing is an app bug either way.

**Tests.** Co-located `Button.test.ts`: `onclick` fires with no `action` prop;
the serialized JSON carries `action.name === id`; `actionName` overrides it.

**In this commit (closure):** update every `action={{ name }}` call site in
`evals/fixtures/`, `examples/minimal-app/`, `src/lib/skills/`, and the docs;
reword CLAUDE.md Rule 3 — `action.name === id` now holds by construction for
Button, authors no longer maintain it by hand.

**Commit:** `fix(components)!: run Button onclick without an explicit action prop`
(footer: `BREAKING CHANGE: Button's action={{ name }} prop is replaced by actionName; the action name defaults to the component id.`)

---

### WP3 — Normalize `turn-complete` on `GeminiLiveTransport`

**The bug.** [transport.ts:172](../../src/lib/agent/transport.ts#L172) defines
`turn-complete` as "model finished its turn", but
[live-transport.ts:284-286](../../src/lib/agent/gemini/live-transport.ts#L284-L286)
forwards **every** `serverContent.turnComplete` — including the one that arrives
right after a `toolCall`, before the model has seen the results. Anything
observing it (a test, a composer re-enabling, `Agent.#onTurnComplete` flushing a
sync) fires mid-loop. WP6 is unimplementable without this.

**The fix — copy what already exists in this repo.**
[realtime-transport.ts:302-314](../../src/lib/agent/openai/realtime-transport.ts#L302-L314)
tracks `#pendingCount`, emits `tool-call`, and deliberately does not emit
`turn-complete`. [scripted-transport.ts:116-129](../../src/lib/agent/scripted-transport.ts#L116-L129)
does the same.

1. `#pendingToolResults`, set to `calls.length` when emitting `tool-call`
   ([lines 248-258](../../src/lib/agent/gemini/live-transport.ts#L248-L258)).
2. Decrement in `sendToolResult`.
3. Suppress `turn-complete` while `> 0`. The genuine end-of-turn one arrives
   after the continuation and is forwarded normally.
4. Safety net inside the adapter: if all results are back and no new
   `turnComplete` arrives within ~1500 ms, emit one. Private constant, not a
   public option.
5. Clear on `close()` and on `interrupted`.

**Also audit** [deepgram/agent-transport.ts:290-292](../../src/lib/agent/deepgram/agent-transport.ts#L290-L292)
(`AgentAudioDone`) and [hume/evi-transport.ts:283-285](../../src/lib/agent/hume/evi-transport.ts#L283-L285)
(`assistant_end`) for the same hazard; document the finding in each file's
comment either way.

**Tests.** `live-transport.test.ts`: feed `toolCall` → `turnComplete` →
(after `sendToolResult`) `modelTurn` + `turnComplete`; assert exactly one
`turn-complete` reaches the listener, after the continuation. Plus the timeout case.

**Done when:** `pnpm eval` no longer needs `A2UI_EVAL_QUIESCE_MS` (WP11 deletes it).

**Commit:** `fix(gemini): defer live turn-complete until tool results are back`

---

### WP4 — Guard the jsdom gaps in the renderer

**The bug.** Unguarded browser APIs crash any component test the moment the
agent points at or updates an element:

- [highlight.ts:28](../../src/lib/core/highlight.ts#L28) — `CSS.escape(elementId)`
- [reveal.ts:15](../../src/lib/core/reveal.ts#L15) — `CSS.escape(id)`
- [highlight.ts:102](../../src/lib/core/highlight.ts#L102) — `entry.el.scrollIntoView({…})`

**The fix.** An internal `escapeAttrValue(id)` in `src/lib/core/` used by both
call sites: `CSS.escape` when available, otherwise a fallback that escapes at
least `"` and `\` (the value is interpolated into `[data-a2ui-id="…"]` — never
emit a malformed selector). `scrollIntoView?.({ … })`. Say *why* in the doc
comment so nobody simplifies it back.

**Tests.** `highlightElements` / `revealElements` resolve and don't throw with
`globalThis.CSS` undefined and with `scrollIntoView` absent; an id containing a
quote and a backslash pins the escaping.

**Commit:** `fix(core): guard CSS.escape and scrollIntoView for non-browser DOMs`

---

### WP5 — Unregister tools when a surface unmounts

**The bug.** [StaticSurface.svelte:379-381](../../src/lib/renderer/StaticSurface.svelte#L379-L381)
unregisters the surface's *actions* on destroy but never its **tools**
([lines 248-378](../../src/lib/renderer/StaticSurface.svelte#L248-L378)).
`SurfaceRegistry` already tracks what it registered in `registeredToolNames`
([surface-registry.ts:18](../../src/lib/core/surface-registry.ts#L18)) — unused.

Consequences: tool declarations leak between test fixtures; in a production SPA
an unmounted page leaves live tool closures bound to a dead surface, so
`buildToolResult` computes feedback from it.

**The fix.**

- `SurfaceRegistry.dispose()` — `toolRegistry.unregister(name)` for every tracked
  name, then clear. Call it from the existing `onDestroy`. Same for
  `<DynamicSurface>` if it registers tools.
- **Ordering hazard (the substance of this WP):** two mounted surfaces both
  register `click_button` under one global name. Unmounting one must not remove
  a name the other still provides. Either refcount in `ToolRegistry`, or have
  `dispose()` unregister only names whose currently-registered definition is the
  one this registry installed. Pick one and test it.
- `ToolRegistry.register`/`unregister` `console.log` on every call
  ([tool-registry.ts:27,33](../../src/lib/core/registries/tool-registry.ts#L27-L33)).
  Unmount churn makes that noisy — gate behind the existing debug flag.

**Tests.** Mount A, mount B, unmount A → `click_button` still declared and routes
to B; unmount B → registry empty. Plus a single mount/unmount round trip.

**In this commit (closure):** delete the manual resets in
[agent.test.ts:120-122](../../src/lib/agent/agent.test.ts#L120-L122),
[AgentShell.test.ts:65](../../src/lib/agent/AgentShell.test.ts#L65),
[scripted-transport.test.ts:33](../../src/lib/agent/scripted-transport.test.ts#L33) and
[StaticSurface.extensions.test.ts:21-23](../../src/lib/renderer/StaticSurface.extensions.test.ts#L21-L23);
suite stays green without them — that is the proof the fix works.

**Commit:** `fix(renderer): unregister surface tools on unmount`

---

## PHASE 2 — The six real gaps

### WP6 — `agent.send()` / `agent.on()`

**Depends on:** WP3 (`turn-complete` must be trustworthy first).

**The gap.** [`Agent.sendTextMessage`](../../src/lib/agent/agent.svelte.ts#L452)
is fire-and-forget. There is no way to await a turn boundary. Production needs it
too (disable the composer until the turn ends, chain a follow-up, show a spinner
that doesn't lie).

**The fix.** Both, same plumbing:

1. `agent.on('turn-complete' | 'error', handler): () => void`. Minimal payload —
   do not re-export the transport's event map.
2. `agent.send(text): Promise<void>` — resolves on the next `turn-complete`,
   **rejects** on transport `error` or `close` during the turn.
   `sendTextMessage` keeps its void signature and becomes a thin wrapper.

Requirements:

- **Event-driven, never polled.** A `setTimeout` loop hangs under
  `vi.useFakeTimers()`.
- **No quiesce window, no activity heuristic.** If you need one, WP3 is
  incomplete — fix it there.
- Identical for streaming and request/response transports (Rule 6).
- Handle: `send` before `start()`; optional `timeoutMs` with a default that does
  not make Vitest's 5 s timeout fire first with a useless message.

**Tests.** Extend [agent.test.ts](../../src/lib/agent/agent.test.ts) with the
existing `MockAgentTransport`: resolves after a tool-call round trip, not at the
intermediate events; rejects on error and on close; sequential sends resolve in
order; `on()` unsubscribes.

**In this commit (closure):** the
[agent-integration.md §Testing](../../docs/guides/agent-integration.md) snippet
switches `sendTextMessage` + comment to `await agent.send(…)`.

**Commit:** `feat(agent): add turn-completion signal (agent.send / agent.on)`

---

### WP7 — `mountedSurfaces()`

**The gap.** There is no way to find a mounted surface, so every consumer
hand-rolls the plumbing: the example app keeps a store whose only job is holding
`SurfaceEntry[]` ([session.svelte.ts](../../examples/minimal-app/src/lib/session.svelte.ts));
every eval fixture exports `export const surface = () => surfaceRef;`
([ShiftPlannerPage.svelte:108](../../evals/fixtures/ShiftPlannerPage.svelte#L108))
with a `bind:this` purely for testability. `actionRegistry` and `toolRegistry`
are already module-global, so this is consistent, not a new kind of global.

**The fix.**

- `src/lib/core/registries/surface-index.ts` — a module-global
  `surfaceId → AgentSurface` map ([`AgentSurface`:
  agent.svelte.ts:41](../../src/lib/agent/agent.svelte.ts#L41)). **Not**
  `surface-registry.ts`, which exists and is the per-surface component collector.
- `<StaticSurface>` / `<DynamicSurface>` add themselves on mount and remove
  themselves in the `onDestroy` WP5 touches. The registered value is the handle
  they already expose ([StaticSurface.svelte:384-400](../../src/lib/renderer/StaticSurface.svelte#L384-L400)),
  which already satisfies `AgentSurface`.
- Export `mountedSurfaces(): AgentSurface[]` and `surface(id): AgentSurface | undefined`
  from `a2ui-svelte/core`.
- **Do not change `AgentDefinition`.** `surfaces` stays a callback; the easy path
  is `surfaces: mountedSurfaces`. Apps that scope surfaces per route keep working.
- Duplicate id: last wins, `console.warn` — two live surfaces with one id already
  break agent targeting.
- Registration is mount-time only, never at module scope (SSR).

**Tests.** Two fixtures → both listed, `surface('x')` resolves; unmount → gone;
duplicate warns; nothing registers during SSR.

**In this commit (closure):** delete the hand-rolled surface list from
[examples/minimal-app](../../examples/minimal-app/) and the `surface()` accessors
from the eval fixtures — if that doesn't get simpler, the API is wrong. Then move
the example's `AgentDefinition` out of
[+layout.svelte:35](../../examples/minimal-app/src/routes/+layout.svelte#L35)
into `examples/minimal-app/src/lib/agent-definition.ts` — the layout keeps only
the transport picker. That is the shape §1.4 tells users to adopt.

**Commit:** `feat(core): track mounted surfaces in a global registry`

---

### WP8 — `window.__a2ui` for end-to-end tests

**Depends on:** WP7.

**The gap.** A Playwright test runs outside the page and cannot import
`toolRegistry`, so there is no way to drive the agent half of an E2E test.
Nothing exposes a global today.

**The fix.** In `<StaticSurface>` (or a single module `src/lib/core/dev-global.ts`
imported by it), when `import.meta.env.DEV` **and** `typeof window !== 'undefined'`:

```ts
window.__a2ui = {
	execute: (tool, args) => toolRegistry.execute(tool, args),
	tools: () => toolRegistry.getDeclarations().map((d) => d.name),
	surfaces: () => mountedSurfaces().map((s) => s.id),
	json: (id) => surface(id)?.getJson()          // id omitted: the sole mounted
	                                              // surface, else throw with the
	                                              // list of mounted ids
};
```

- Dev/preview only. The guard is `import.meta.env.DEV`, which **our** build
  leaves unresolved (`svelte-package` transpiles per file and does not
  tree-shake), so `__a2ui` is expected in our `dist/`. The consumer's bundler is
  what erases it — verify in the example app's production output:
  `pnpm --filter minimal-app build && grep -r __a2ui examples/minimal-app/build/`.
- Read-through only: no new logic, just a window-reachable door onto the existing
  registries.
- Ship the TypeScript declaration so `page.evaluate` types resolve.

**Tests.** A unit test asserting the global is installed under `DEV` and that
`execute` reaches the registry. E2E coverage itself is the example app's job.

**Commit:** `feat(core): expose a dev-only window.__a2ui handle for e2e tests`

---

### WP9 — `withoutAudio(transport)`

**The gap.** Evaluating a voice transport under node needs the audio modality
masked so `Agent` drives it text-in/text-out. Today
[evals/harness.ts](../../evals/harness.ts) (at HEAD, after WP0) does this with a
local `HeadlessTextMask`: ~65 lines hand-copying the `AgentTransport` contract
member-by-member, so adding one optional member to the contract silently stops
it forwarding, with no compiler signal. Replace it.

**The fix.** Two small pieces in `src/lib/agent/`:

1. `forwardTransport(inner, overrides?)` — **internal, not exported**: forwards
   every contract member, applies overrides, and **preserves optionality**: a
   member absent on `inner` must stay absent on the result
   (`'sendAudioChunk' in result === false`), because `Agent` and `<AgentShell>`
   feature-detect on it. A `Proxy` gets this right naturally. Must expose
   `dispose()` that unsubscribes — `inner.on()` returns an unsubscribe, and all
   six are easy to drop. Export it the day a second wrapper needs it, not before
   (Rule 8: adding later is cheap).
2. `withoutAudio(transport)` on top of it: strips `'audio'` from
   `capabilities.input`/`output` and hides `sendAudioChunk`. Exported from
   `a2ui-svelte/agent`.

Doc comment must keep the hard-won point: **the model still generates audio, so
the token bill is unchanged — exactly the production load.** The frames are
dropped; the output transcription carries the text.

**Tests.** A fake transport with and without each optional member: `'sendAudioChunk' in wrapped`
tracks `inner`; `capabilities` reads through live (the built-ins declare it as a
getter — the mask depends on that); overrides win; `dispose()` unsubscribes.

**Commit:** `feat(agent): add withoutAudio transport mask`

---

### WP9b — `agentCall()`: a swallowed tool failure must fail the test

**The gap.** `toolRegistry.execute` **never throws.**
[tool-registry.ts:57](../../src/lib/core/registries/tool-registry.ts#L57)
returns `{ error }` for an unknown tool and
[tool-registry.ts:64-66](../../src/lib/core/registries/tool-registry.ts#L64-L66)
catches everything else. Before that, `runClicks` / `runUpdates` already catch
the `actionRegistry` throw and fold it into `{ element_id, status: 'error',
error }` inside the result
([StaticSurface.svelte:176-182](../../src/lib/renderer/StaticSurface.svelte#L176-L182)).

Every layer of that is **correct in production** — the model needs the failure
back as a tool result so it can recover — and every layer of it is wrong in a
test:

```ts
await agentClick('add-staff-btnn');           // typo — resolves, zero signal
expect(screen.getByText('Giulia')).toBeInTheDocument();
// ❌ Unable to find an element with the text: Giulia
```

The typo surfaces as an assertion failure three lines later, pointing at the
wrong thing. Inverting a production-correct behaviour is the one thing users
cannot get from the exported API, and the reason they cannot write these two
lines correctly themselves.

**The fix.** Three functions, ~20 lines, in `src/lib/testing/agent-actor.ts`,
exported from `a2ui-svelte/testing` — harmful in app code, so §0's placement
rule puts them there rather than in `./core`.

`src/lib/testing/index.ts` exports these three and nothing else, headed by the
charter comment: **test-only inversions of production behaviour live here;
everything else a test needs is already in `./core` and `./agent`.** Consumers
can then lint the boundary — `no-restricted-imports` on `a2ui-svelte/testing`
outside `*.test.ts`, a rule that is unwriteable if these live in `./core`.

```ts
/**
 * Statuses that count as success. Fail-closed: anything not in this set — a
 * status added later, a renamed one, a missing one — throws. Keep it small;
 * WP9c reduces it to a single value.
 */
const SUCCESS_STATUSES = new Set(['success', 'pointed']);

export async function agentCall(name: string, args: Record<string, any> = {}) {
	const result = await toolRegistry.execute(name, args);
	if (result?.error) throw new Error(`Tool "${name}" failed: ${result.error}`);
	for (const r of result?.results ?? [])
		if (!SUCCESS_STATUSES.has(r?.status))
			throw new Error(`${name} did not succeed: ${JSON.stringify(r)}`);
	return result;
}

export const agentClick = (id: string) => agentCall('click_button', { element_id: id });
export const agentFill = (id: string, value: string) =>
	agentCall('update_text_field', { element_id: id, value });
```

`agentCall` returns the full result on success, so
`expect(await agentClick('save-btn')).toMatchObject({ … })` still works, and it
covers custom tools unchanged — the envelope (`{ error }`) and the standard
`results[].status` are all a generic helper can honestly inspect.

**Why the check is negative.** `!SUCCESS_STATUSES.has(status)`, never
`status === 'error'`. A positive check is a check that silently stops working:
the day a result shape grows `'fail'`, `'rejected'`, or `success: false`, every
affected test goes green while the feature is broken. The negative check turns
that same change into a loud failure on the next `pnpm test`. **False positives
are cheap to diagnose; false negatives are a suite that lies.** This is not
hypothetical — `runPointer` already returns `'pointed'` / `'not_found'`
([StaticSurface.svelte:204-212](../../src/lib/renderer/StaticSurface.svelte#L204-L212)),
which is exactly why the allow-list is a named constant rather than a literal:
adding a status is a deliberate edit to that line, and forgetting to make it is
a test failure, not silence.

**WP9c deletes the allow-list** by making every tool emit `'success'` / `'error'`,
collapsing this to `if (r?.status !== 'success')` — still negative, still
fail-closed. Until then the constant is the honest interim: it *names* the
divergence between our tools instead of hiding it behind a passing test.

**Tests.**

- unknown tool → throws, message names the tool;
- unknown element id → throws, message carries `actionRegistry`'s
  `Available IDs: …` list
  ([action-registry.ts:59](../../src/lib/core/registries/action-registry.ts#L59)
  — the string already exists; this is what makes a human ever see it);
- a handler that throws → throws, not a silent pass;
- happy path returns the whole result object;
- **a result with an unrecognised `status` throws** — this pins the fail-closed
  guarantee so a future status change cannot quietly disable it;
- `point_to_elements` against a mounted id does not throw.

**In this commit (closure):** the `./testing` entry in
[package.json](../../package.json) `exports` and the CLAUDE.md Rule 8 paragraph
(subpath list + placement rule) — both re-landed from the WP0 patch. Add
`@testing-library/user-event` as a devDependency: §1.1's snippets use it, this
repo doesn't have it, and §4 requires the snippets to run verbatim here.

**Commit:** `feat(testing): add agentCall test helper that fails closed on tool errors`

---

### WP9c — One success signal for every tool

**The gap.** WP9b's `SUCCESS_STATUSES` allow-list is a symptom, not a design.
Two facts sit next to each other in the repo today:

1. [prompt-builder.ts:192](../../src/lib/agent/prompt-builder.ts#L192) tells the
   model, globally and for every tool, that a result item is
   `{ "element_id": "...", "status": "success" | "error", ... }`.
2. `point_to_elements` returns `'pointed'` / `'not_found'`
   ([StaticSurface.svelte:204-212](../../src/lib/renderer/StaticSurface.svelte#L204-L212)),
   documented that way in
   [extensions.md:138-148](../../docs/guides/extensions.md#L138-L148).

**The contract we teach the model is already violated by one of our own tools.**
The model is handed a two-value vocabulary in the system prompt and a third and
fourth value on the wire — exactly the class of confusion this plan exists to
remove, and nothing catches it because no test asserts that the prompt and the
implementations agree.

**The fix — normalize on `status`; do not add a boolean.** Make
[prompt-builder.ts:192](../../src/lib/agent/prompt-builder.ts#L192)'s promise
true rather than aspirational:

| tool | today | after |
|---|---|---|
| `click_button` / `update_text_field` (+ batched) | `'success'` / `'error'` | unchanged |
| `point_to_elements`, id resolved | `'pointed'` | `'success'` |
| `point_to_elements`, id missing | `'not_found'` | `'error'` + `error: 'No element "…" on any mounted surface'` |
| `surfaceUpdate` / `beginRendering` / `dataModelUpdate` ([agent.svelte.ts:837](../../src/lib/agent/agent.svelte.ts#L837)) | `'success'` | unchanged |
| agent-level catch ([agent.svelte.ts:850](../../src/lib/agent/agent.svelte.ts#L850)) | `'error'` | unchanged |

Pointing at an id that does not exist **is** a failure, so `'error'` loses
nothing and gains a populated `error` string the model can act on — strictly
more useful than the bare `'not_found'` token. `'pointed'` carried nothing
`'success'` does not.

**Why not `success: true`** (the shape originally proposed):

- **Redundant on the hottest token path.** Tool results echo back on every call
  and are a top quota cost — the reason `toolResultExtras: 'diff'` exists at
  all. A boolean *beside* `status` pays for the same bit twice, per element, per
  call. A boolean *instead of* `status` throws away the natural home of the
  `error` string.
- **It churns the model contract to express the same two states.** `'success' |
  'error'` is what the prompt documents and what every transport test fixture
  already asserts. Swapping in a boolean means rewriting the prompt rule, those
  fixtures, and any consumer's assertions — a Rule 8 breaking change — for no
  behavioural gain.
- **A closed two-value string is already as machine-checkable as a boolean**,
  and it leaves room to add a third state deliberately later instead of forcing
  a parallel field the day one is needed.

**Verify against the spec before landing.**
[StaticSurface.svelte:96](../../src/lib/renderer/StaticSurface.svelte#L96) calls
the `results` array "spec-canonical", but nothing in this repo records whether
v0.8 fixes the `status` **vocabulary** or only the envelope. Check
<https://a2ui.org/> first: if the spec pins the values, this WP is constrained to
whatever it says and our extension bends to it (Rule 1); if it does not, the
table above stands. Either way, record the answer in
[docs/guides/a2ui-compatibility.md](../../docs/guides/a2ui-compatibility.md),
which is currently silent on tool results entirely.

**Consequences.**

- WP9b's `SUCCESS_STATUSES` set collapses to one check — still written
  negatively, `if (r?.status !== 'success') throw`. The fail-closed property is
  unchanged; the allow-list stops needing maintenance.
- The prompt rule gains one clause: `status` is exactly `'success'` or
  `'error'`, and a failed element always carries `error`.

**Tests.**

- **Table-driven over `registry.getDeclarations()`**: every registered tool,
  driven with a bad element id, returns `status: 'error'` and a non-empty
  `error`. This is the test that matters — a tool added later cannot introduce a
  new vocabulary without going red.
- `point_to_elements` on a mounted id → `'success'`; on a missing id → `'error'`.
- **Prompt and implementation agree**: assert the statuses named in the rule
  string at [prompt-builder.ts:192](../../src/lib/agent/prompt-builder.ts#L192)
  are exactly the set the tools can emit. This is the check whose absence let
  the two drift apart.

**In this commit (closure):** update
[extensions.md:138-148](../../docs/guides/extensions.md#L138-L148) (the
`point_to_elements` example block and the sentence explaining `status`) and the
a2ui-compatibility note above.

**Commit:** `refactor(renderer)!: normalize every tool result on status success|error`
(footer: `BREAKING CHANGE: point_to_elements results report status success|error instead of pointed|not_found.`)

---

## PHASE 3 — Spec compliance is our job, not the user's

### WP10 — Surface validation: dev warning + our own tests

**Reuses:** `src/lib/testing/validate-surface{,.test}.ts` from the WP0 patch —
the logic is sound, the packaging changes.

Split the checks by who can break them:

| check | who | where it goes |
|---|---|---|
| single-`child` slots, `children.explicitList` shape, unique ids, resolvable refs, one-type envelopes, reachability | **us** — properties of our serializer | our own suite, run over every repo fixture |
| `action.name === id` | **us**, after WP2 — it holds by construction | our own suite |
| kebab-case ids, unknown/custom types | **users** — host conventions, custom catalogs | dev-mode `console.warn` |

**Deliver.**

1. Move the structural assertions into the serializer's suite and run the
   validator over every fixture in the repo as part of `pnpm test`.
2. `<StaticSurface>` and `<DynamicSurface>` validate on mount when
   `import.meta.env.DEV` and `console.warn` a readable report. Zero-cost in
   production; must never throw. Finding out while running `pnpm dev` beats
   finding out only if you happened to write a test.
3. Export `validateSurface(json)` from `a2ui-svelte/core` for users who want it
   in CI. One function, no package.

**Fix these defects from the staged version wherever it lands:**

- `STANDARD_CATALOG_TYPES` hand-copies all 16 keys of `DEFAULT_CATALOG`
  (staged file line 18). Derive it: `new Set(Object.keys(DEFAULT_CATALOG))`.
- The root id is silently exempt from the kebab-case rule (staged file line 139,
  `comp.id !== rootId`) with no explanation — justify it in a comment or drop
  the exemption.
- Name it `validateSurface`, not `validateSurfaceJson`; fold
  `assertValidSurface` in or drop it — one exported function.

**Tests.** Keep the staged cases; add: the dev warning fires on a bad surface and
is silent on a good one; the derived catalog set matches `DEFAULT_CATALOG`; every
repo fixture validates clean.

**Commit:** `feat(renderer): warn on non-compliant surfaces in dev`

---

## PHASE 4 — Our own eval suite

### WP11 — Simplify `evals/` onto the fixed primitives

**Depends on:** WP3, WP6, WP7, WP9. File references below are to the HEAD
versions (post-WP0).

- Delete `EVAL_QUIESCE_MS` / `A2UI_EVAL_QUIESCE_MS`, `sendAndWait`'s
  activity-fingerprint polling, `clearRegistries` and `stubJsdomGaps` from
  [evals/harness.ts](../../evals/harness.ts) — WP3–WP6 make each one
  meaningless. Every live turn loses a ~4 s sleep. Turn-gap pacing (provider
  quota) stays.
- Replace `HeadlessTextMask` with `withoutAudio` (WP9) and `RecordingTransport`
  with `ScriptedTransport`'s own fields where a script is used; where a real
  transport runs, assert through `agent.transcript` / `agent.debug` instead of
  a recorder.
- Replace the fixtures' `surface()` accessors with `mountedSurfaces` (WP7).
- Move each fixture's agent definition into a module the eval imports
  (`evals/fixtures/shift-planner-agent.ts`, `…/dynamic-canvas-agent.ts`) — today
  `STATIC_INSTRUCTIONS` and the definition built inside `startSession` sit next
  to the assertions, which is not the shape §1.4 recommends. `startSession` then
  only picks the transport.
- Assert through the DOM / `getDataModel()` instead of the fixtures' `getStaff()`
  accessor where the state is in the surface — users have no such accessor.
- Use `agent.debug.usage` for token accounting instead of a bespoke counter.
  `estTokens` (a 4-chars/token guess) moves next to its only consumer — the
  report formatting in [context-cost.eval.ts:190](../../evals/context-cost.eval.ts#L190)
  — e.g. into [evals/report.ts](../../evals/report.ts). (v2 claimed it was
  already there; it wasn't.)
- **Rename the file.** Nothing in this repo should be called `harness.ts`
  (`Agent` is the harness). `evals/setup.ts`. It keeps only the Gemini matrix:
  `PROFILES`, `selectedProfiles`, `makeEvalTransport`, env knobs.
- Update [evals/llm-scenarios.eval.ts](../../evals/llm-scenarios.eval.ts),
  [evals/context-cost.eval.ts](../../evals/context-cost.eval.ts) and
  [evals/README.md](../../evals/README.md). `startSession` / `runScenario`
  should shrink noticeably; if they don't, say so in the progress log.

**Also decide and record:** does `evals/` stay our internal suite, or does it
become a shipped runner (scenarios, rubric scoring, retries, comparison table)?
Shipping a runner is a real feature and its own plan. Until then the docs must
say "primitives and a worked example", not "eval framework".

**Commit:** `refactor(evals): drop quiesce hacks and hand-rolled transport masks`

---

## PHASE 5 — Documentation

### WP12 — The new guides and the skill

**Depends on:** the WPs it documents. Can land incrementally. Doc *fixes* now
live in the WP that invalidated them (WP1, WP2, WP6, WP9c); this WP holds only
the new documents.

- **`docs/guides/testing.md`** — new (the staged draft is superseded). §1.1 →
  §1.2 → §1.3 of this plan, in that order, with runnable snippets. State plainly
  that the library ships no test framework and show the two-line sugar. Include
  the "what is not worth asserting" list. State the §0 placement rule where a
  reader meets the two import paths for the first time — `./testing` is
  useless-or-harmful in an app, everything else is framework — and show the
  `no-restricted-imports` rule that enforces it.
- **`docs/guides/evals.md`** — new. §1.4 verbatim in shape: the runnable
  snippet first, then the definition module, assertions, cost,
  `withoutAudio`, quota pacing, and [evals/](../../evals/) as the worked example.
  Keep it as short as §1.4 — a user must see how to send a message and assert on
  the result before reading anything else.
- **Link both** from [README.md](../../README.md) and the documentation map in
  [CLAUDE.md](../../CLAUDE.md). The staged guide was linked from neither.
- **Add the `test-a2ui-app` skill** to [src/lib/skills/](../../src/lib/skills/),
  registered in [index.json](../../src/lib/skills/index.json), modelled on
  [integrate-agent.md](../../src/lib/skills/integrate-agent.md). It must carry
  the placement rule too — a coding agent adding a helper needs to know which
  subpath it belongs in without reading this plan.
- **Update [docs/guides/agent-integration.md](../../docs/guides/agent-integration.md)**
  §Testing to point at the new guide.

**Commit:** `docs: add testing and evals guides, add test-a2ui-app skill`

---

## 3. Sequencing

```
WP0       stash the staged changeset (user runs git) — everything assumes HEAD
Phase 1   WP1  WP1b  WP2  WP3  WP4  WP5   independent, parallel, separate fix: commits
                     ↓
Phase 2   WP6 (needs WP3)   WP7   WP8 (needs WP7)   WP9   WP9b   WP9c (simplifies WP9b)
                     ↓
Phase 3   WP10        (independent — can start any time after WP0)
                     ↓
Phase 4   WP11 (needs WP3, WP6, WP7, WP9)
                     ↓
Phase 5   WP12 (incremental)
```

**Minimum viable slice:** WP0 + WP1 + WP2 + WP4 + WP5 + WP9b + WP12. That makes
component tests work, makes them fail honestly, and documents them. WP3 + WP6
add conversation-level tests; WP8 adds Playwright.

---

## 4. Definition of done

- The §1.1, §1.2, §1.3 and §1.4 snippets run verbatim against a repo fixture —
  **and go red when the fixture's wiring is broken** (rename an id, drop an
  `onclick`, break a handler). If a snippet stays green under all three, it is
  testing us, not the app: replace it. (`@testing-library/user-event` is a
  devDependency — WP9b.)
- A tool failure never passes silently: an unknown tool, an unknown element id,
  a throwing handler, and an unrecognised `status` string each fail the test at
  the call site (WP9b).
- Every registered tool reports outcome the same way — `status: 'success' |
  'error'`, failures carrying `error` — and a test driven off
  `registry.getDeclarations()` makes a divergent new tool go red (WP9c).
- The status vocabulary in [prompt-builder.ts:192](../../src/lib/agent/prompt-builder.ts#L192)
  and the one the tools actually emit are asserted equal, not assumed (WP9c).
- The example app and both eval fixtures export their agent definition from a
  module, and every snippet imports one instead of re-declaring it (§1.4).
- The only new subpath in [package.json](../../package.json) `exports` is
  `./testing`, and it exports exactly `agentCall`, `agentClick`, `agentFill`.
  Nothing importable from `./testing` is usable in a running app, and nothing in
  `./core` or `./agent` is unsafe in one (§0 placement rule).
- No file in the repo is named `harness.ts`.
- No test file resets a registry by hand.
- Every commit is a closed unit — its code, tests, and doc/skill updates land
  together, its message is a conventional commit, and breaking ones carry `!`
  plus a `BREAKING CHANGE:` footer.
- `pnpm test` and `pnpm check` green; `pnpm eval` runs without
  `A2UI_EVAL_QUIESCE_MS` and is measurably faster per live turn.
- `pnpm --filter minimal-app build` leaves no `__a2ui` in the example app's
  production output (our own `dist/` still contains the guarded block — see WP8).
- No fixture, example, skill or doc writes `fieldName` equal to its `id`, or
  passes `action={{ name: id }}`.
- Every value-bearing component — built-in, or built by following the
  custom-component skill — path-binds, registers and reports one key:
  `fieldName ?? componentId`. One with neither prop reports its auto-generated
  id, never `''` (WP1b).

---

## 5. Progress log

_(append per WP, max ~8 lines: what landed, decisions that contradict the WP
text, what the next WP must know. The diff holds everything else.)_

### WP1 — DONE (2026-08-29, branch `develop`)

- TextField registers `update` unconditionally; result `field` reports
  `fieldName ?? handle.componentId ?? ''`. Id-only fields (and
  `AutocompleteField`) are writable. New `TextField.test.ts` + harness fixture.
- `fieldName={id}` dropped where equal, across fixtures/examples/skills/docs;
  the register-unconditionally rule written into `authoring-components.md`
  §`action`.
- Deviation: `handle.componentId`, not the siblings' `id` — with neither prop
  set `id` is `undefined` while the data-model key is the generated id. Fixed
  for the siblings in WP1b.
- Referencing `handle` inside its own handler needs an explicit return
  annotation (TS circular initializer).
- **WP9b must re-land** CLAUDE.md's Rule 8 `./testing` text — WP0's
  `git stash push --staged` reverted it.

### WP1b — DONE (2026-08-30, branch `develop`)

- Checkbox, Slider, DateTimeInput, MultipleChoice and **Tabs** (not in the WP
  text, same defect: `field: id ?? 'tabs'`) report the resolved data-model key.
- `build-custom-component.md`: unconditional `data` + action, path-bound under
  `fieldName ?? componentId`; dropped the `fieldName` JSON property (it
  duplicated the `path`).
- New `value-components.test.ts` + harness. It reads each component's exported
  `componentId` via `bind:this` — auto-ids are a per-surface counter, so
  hardcoding `slider-2` makes tests order-dependent. Reuse that.
- `pnpm test` 236 passed / 1 skipped; `pnpm check` 0 errors.
