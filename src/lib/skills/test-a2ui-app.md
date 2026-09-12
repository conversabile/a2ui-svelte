---
name: test-a2ui-app
description: Use when writing or fixing tests for an app built with a2ui-svelte — component tests that drive the UI as the agent does, tests needing a live Agent via ScriptedTransport, Playwright end-to-end through window.__a2ui, or evals against a real model.
type: skill
---

# Test an A2UI app

## When to use this skill

Use it when you write tests for A2UI surfaces, agent wiring, or the
agent+human interplay. What an A2UI test asserts is that **both actors see
the same UI**: when the agent acts, the app reacts; when the human types,
the agent sees it.

Trigger phrases: "write tests for this page", "test the agent can click
this", "my test can't reach the tool", "test with a fake model", "add a
Playwright test", "eval this against a real model".

**The library ships no test framework.** Vitest + Testing Library as usual;
we add three functions and a scripted transport.

## Which subpath an import comes from

| import | from |
|---|---|
| `surface`, `mountedSurfaces`, `toolRegistry`, `actionRegistry`, `validateSurface` | `a2ui-svelte/core` |
| `Agent`, `ScriptedTransport`, `withoutAudio` | `a2ui-svelte/agent` |
| `agentCall`, `agentClick`, `agentFill` | `a2ui-svelte/testing` |

**The placement rule:** something belongs in `a2ui-svelte/testing` **iff it
is useless or harmful in a running app** — `agentCall` throws where
production must fold the failure into `{ status: 'error' }` so the model can
recover. Everything a consumer could build their app with stays in the
framework subpaths, even when tests are its only user. Never import
`a2ui-svelte/testing` outside a `*.test.ts`; enforce it with
`no-restricted-imports`.

## How to apply

### 1. Component test — the agent acts, the app reacts

No model, no transport: call the same registry a real model hits.

```ts
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { surface } from 'a2ui-svelte/core';
import { agentClick, agentFill } from 'a2ui-svelte/testing';
import TodoList from './TodoList.svelte';

test('the agent can add a task', async () => {
  render(TodoList);

  await agentFill('add-todo-title', 'Groceries');
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

- Use `agentClick` / `agentFill` / `agentCall`, **not**
  `toolRegistry.execute`: the helpers throw at the call site on an unknown
  id, an unknown tool, or a throwing handler. Bare `execute` folds the
  failure into its result and the test dies later on an unrelated assertion.
- `surface(id)` gives `getJson()` (the tree the agent sees) and
  `getDataModel()` (the flat `{ fieldId → value }` map). Both members are
  optional on the handle type, hence the `!`.
- **Stub nothing for jsdom.** `CSS.escape` and `scrollIntoView` are guarded
  inside the library. A crash there is our bug — don't add a setup file.

### 2. A test that needs a live `Agent` — `ScriptedTransport`

Only for code that runs when an agent is attached: UI bound to
`agent.status` / `agent.transcript`, an event you emit yourself, a
`buildPrompt` override.

```ts
import { Agent, ScriptedTransport } from 'a2ui-svelte/agent';
import { todoList } from './agent-definition';

const model = new ScriptedTransport([
  { on: 'save', calls: [{ name: 'click_button', args: { element_id: 'save-list-btn' } }] }
]);
const agent = new Agent(todoList, model);
render(TodoListPage, { agent });
await agent.start();

const turn = agent.send('save the list');  // resolves at turn-complete
expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
await turn;
```

- **A scripted reply is a fixture, never an expectation.** Asserting the
  tool calls match the ones you scripted is the script echoing itself.
  Assert on your app's state, or on `model.textsSent` / `model.toolResults`
  / `model.connectOpts`.
- Don't hand-roll a transport. `ScriptedTransport`'s capabilities decide
  which `Agent` paths run; one wrong value makes the test green against a
  configuration the app never runs.
- A hang on `agent.send(…)` means the scripted turn never completed — pass
  `{ timeoutMs }` under the runner timeout for a message that says so.

### 3. End-to-end — Playwright via `window.__a2ui`

The test is in node, the app in the browser, so it can't import the
registry. The library installs `window.__a2ui` with `<StaticSurface>` —
`execute(tool, args)`, `tools()`, `surfaces()`, `json(id?)` — guarded by
`import.meta.env.DEV`, so the consumer's build drops it.

```ts
await page.getByLabel('Invoices due date').fill('2026-04-15');   // human
await page.evaluate(() =>                                        // agent
  window.__a2ui!.execute('click_button', { element_id: 'save-list-btn' })
);
await expect(page.getByText('List saved')).toBeVisible();
```

Check the app's own output once: `vite build && grep -r __a2ui dist/` must
find nothing (our published `dist/` does contain it — that's expected).

### 4. Eval — a real model

A real model costs money and is non-deterministic: keep it out of
`pnpm test`, in its own `*.eval.ts` with its own runner.

```ts
const agent = new Agent(todoList, new GeminiTextTransport({ apiKey, model }));
await agent.start();
// Without this, a wrong API key reads as the model getting the answer wrong.
if (agent.configIssue) throw new Error(agent.configIssue);
await agent.send('Set the due date of the Invoices task to 2026-04-15');

expect(screen.getByLabelText('Invoices due date')).toHaveValue('2026-04-15');
expect(agent.debug.usage.peakTotal).toBeLessThan(8_000);
```

Wrap a voice transport in `withoutAudio(...)` to run it under node.

## Don't assert

- that `update_text_field` sets a value, or that a failing handler returns
  `status: 'error'` — ours, covered by our suite;
- that a real model would pick that id — no model runs in a test;
- ids named in `contextInstructions`, by hardcoding them a third time.
  Declare the ids once as a const shared by template and instructions.

## Keep the definition in a module

`src/lib/agent-definition.ts`, imported by the layout, the tests and the
evals — with `surfaces: mountedSurfaces` it needs no other wiring. A test
that re-declares the definition is testing a prompt the app never ships.

## Related skills

- `integrate-agent` — wiring `Agent` + transport + `<AgentShell>`.
- `build-a2ui-page` — the surfaces and ids these tests drive.
