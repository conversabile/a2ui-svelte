# Testing an A2UI app

What you test in an A2UI app is that **both actors see the same UI**: when
the agent acts, your app reacts; when the human types, the agent sees it.

**The library ships no test framework** — no runner, no scenario DSL, no
mock model beyond a deterministic transport. You use Vitest + Testing
Library as usual; we add two functions that drive the UI as the agent
does and throw when it can't.

Three activities, three sections: component tests (below), tests that
need a live `Agent`, end-to-end. Running a **real** model is an eval —
see [evals.md](evals.md).

## The two import paths

| you import | from | what it is |
|---|---|---|
| `surface`, `mountedSurfaces`, `toolRegistry`, `actionRegistry`, `validateSurface` | `a2ui-svelte/core` | framework — your app uses these too |
| `Agent`, `ScriptedTransport`, `withoutAudio` | `a2ui-svelte/agent` | framework |
| `agentCall`, `agentClick`, `agentFill` | `a2ui-svelte/testing` | **test-only** |

The rule: something lives in `a2ui-svelte/testing` **iff it is useless or
harmful in a running app**. `agentCall` throws where production must fold
the failure into `{ status: 'error' }` so the model can recover. That is
the whole subpath — three functions — and it stays that way, so you can
lint the boundary:

```js
// eslint.config.js
{
  files: ['**/*.svelte', 'src/**/*.ts'],
  ignores: ['**/*.test.ts'],
  rules: {
    'no-restricted-imports': ['error', { patterns: ['a2ui-svelte/testing'] }]
  }
}
```

## 1. Component tests — Vitest + jsdom

**What you're testing:** that when the agent acts, your app reacts — and
that what a human does is visible to the agent. No model, no transport:
you call the same tool registry a real model hits.

```ts
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { surface } from 'a2ui-svelte/core';
import { agentClick, agentFill } from 'a2ui-svelte/testing';
import TodoList from './TodoList.svelte';

test('the agent can add a task', async () => {
  render(TodoList);

  await agentFill('add-todo-title', 'Groceries');
  await agentFill('add-todo-tag', 'Home');
  await agentClick('add-todo-btn');

  expect(screen.getByText('Groceries')).toBeInTheDocument();
});

test('a human edit is visible to the agent', async () => {
  render(TodoList);
  await userEvent.type(screen.getByLabelText('Invoices due date'), '2026-04-15');

  expect(surface('todo-list')!.getDataModel!()['todo-invoices-due'])
    .toBe('2026-04-15');
});
```

`agentClick` / `agentFill` / `agentCall` drive the registry and **throw at
the call site** when the id doesn't exist or the handler fails — bare
`toolRegistry.execute` folds the failure into its result instead, and the
test dies three lines later on an unrelated assertion. `surface(id)` hands
you the tree (`getJson()`) and data model (`getDataModel()`) the agent
sees; both members are optional on the handle type, hence the `!`.

`@testing-library/user-event` is your own devDependency.

### The environment — nothing to set up

These tests run under jsdom (`environment: 'jsdom'`), which has no layout
engine and therefore no `CSS.escape` and no `Element.prototype.scrollIntoView`
— both of which the glow and auto-reveal helpers call on every agent
action. **The library guards them internally**
([core/dom.ts](../../src/lib/core/dom.ts)), so you stub nothing. If you
hit a crash there, it's our bug, not your missing setup file — don't copy
one from elsewhere.

### What this covers

- your state and DOM after an agent action;
- a human edit reaching the agent's view — where a hand-written `a2ui:`
  projection on a custom or composite component breaks;
- the control being agent-reachable under that id at all. For a plain
  catalog Button that is the *only* thing this adds over a
  `userEvent.click` test — but a bare `<button>`, or a composite wired to
  the wrong handler, passes the human version and fails this one.

### What is not worth asserting

- **that `update_text_field` sets a value**, or that a failing handler
  returns `status: 'error'` — those are ours, covered by our suite;
- **that a real model would pick that id** — no model runs here (that's an
  [eval](evals.md));
- **that your `contextInstructions` name ids your template registers.** The
  id in a test is a hardcoded string, like a CSS selector: rename it in the
  template and the test and the prompt still point at a ghost. Compare the
  two live sources instead:

```ts
import { actionRegistry } from 'a2ui-svelte/core';
import { todoList } from './agent-definition';   // the prompt your app ships

test('every id the instructions name is really registered', () => {
  render(TodoList);
  const live = new Set(actionRegistry.listActions());
  const prompt = todoList.instructions + (todoList.contextInstructions?.() ?? '');
  const named = prompt.match(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/g) ?? [];

  for (const id of named) expect(live).toContain(id);
});
```

The regex is crude. Declaring the ids once as a const and referencing it
from both the template and the instructions deletes the failure mode
instead of testing for it; keep the test for surfaces whose instructions
are prose.

## 2. Tests that need a live `Agent` — `ScriptedTransport`

**What you're testing:** code that only runs with an agent attached — UI
bound to `agent.status` or `agent.transcript`, a `userActionBus.emit` you
fire yourself, a `buildPrompt` override. Same runner and tier as §1.

`ScriptedTransport` is a deterministic stand-in model: it replies from a
script and records what it was sent (`textsSent`, `toolResults`,
`connectOpts`). Don't hand-roll a transport — its `TransportCapabilities`
decide which `Agent` paths run (`streaming`, `interruptible`,
`historyOwnership`, `canInitiateTurn`), and one wrong value makes the test
green against a configuration your app never runs.

```ts
import { render, screen } from '@testing-library/svelte';
import { Agent, ScriptedTransport } from 'a2ui-svelte/agent';
import { todoList } from './agent-definition';   // your app's own definition
import TodoListPage from './TodoListPage.svelte';

// The app disables its own Save button while the agent is mid-turn, so the
// human and the agent can't both write the list.
test('the human Save button locks while the agent is working', async () => {
  const model = new ScriptedTransport([
    { on: 'save', calls: [{ name: 'click_button', args: { element_id: 'save-list-btn' } }] }
  ]);
  const agent = new Agent(todoList, model);
  render(TodoListPage, { agent });    // mounts the surface `mountedSurfaces` finds
  await agent.start();

  const turn = agent.send('save the list');   // resolves at the model's turn-complete
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

  await turn;
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  expect(screen.getByText('List saved')).toBeInTheDocument();
});
```

**A scripted reply is a fixture, never an expectation.** It exists to put
the agent into the state your code reacts to. Asserting that the tool calls
match the calls you scripted is the script echoing itself.

The other two cases:

- **an event you emit yourself** (`userActionBus.emit`, a route change, a
  domain event): script nothing — `new ScriptedTransport()` is then a pure
  recorder — and assert on `model.textsSent`, the agent's output rather
  than yours;
- **a `buildPrompt` override**: assert on
  `model.connectOpts!.systemInstruction`. Fair *because* you overrode it —
  without an override, that asserts our prompt builder.

Most apps use stock `<AgentShell>`, emit no events of their own and don't
override prompt assembly. They need none of this.

If a test hangs on `agent.send(…)`, the scripted turn never completed; pass
`{ timeoutMs }` below the runner's own timeout to get a message that says so.

## 3. End-to-end — Playwright

**What you're testing:** a whole journey against your real build — real
CSS, routing, network — in a real browser. Slow, so keep it for journeys,
not for the per-component checks §1 already covers.

The test runs in node, your app runs in the browser: two processes, no
shared memory, so the test can't import `toolRegistry` and make the agent
act. The bridge is `window.__a2ui`, installed by the library with
`<StaticSurface>` (nothing to wire up), typed, and forwarding straight to
the registries a real model drives:

```ts
window.__a2ui.execute(tool, args)   // exactly the dispatch a real model runs
window.__a2ui.tools()               // tool names the agent can call
window.__a2ui.surfaces()            // ids of the mounted surfaces
window.__a2ui.json(id?)             // the surface JSON the agent sees
```

One test then covers both actors on the same UI:

```ts
test('agent and human share the same UI', async ({ page }) => {
  await page.goto('/todos');

  await page.getByLabel('Invoices due date').fill('2026-04-15');   // human
  await page.evaluate(() =>                                       // agent
    window.__a2ui!.execute('click_button', { element_id: 'save-list-btn' })
  );

  await expect(page.getByText('List saved')).toBeVisible();
});
```

**It is not in your production build.** The handle is guarded by
`import.meta.env.DEV`, which your bundler replaces with `false` at build
time and drops. Ours doesn't: `svelte-package` transpiles file by file, so
`__a2ui` *is* present in `a2ui-svelte`'s published `dist/` — correct, and
erased by your build. Verify your own output:

```
vite build && grep -r __a2ui dist/     # expect no match
```

A full voice or text round trip needs a real model — that's an
[eval](evals.md), not a test: it costs money and is non-deterministic.
