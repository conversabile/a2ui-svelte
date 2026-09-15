# Evals — testing against a real model

**What you're testing:** whether a real model, given the prompt your app
ships, actually does what the user asked — and what that costs. Render
your page, attach your agent to a real model, send a message, assert.

Keep them in your own `*.eval.ts` files with your own runner (ours:
[evals/](../../evals/)), never in `pnpm test`: they cost money and are
non-deterministic.

```ts
import { render, screen } from '@testing-library/svelte';
import { Agent } from 'a2ui-svelte/agent';
import { GeminiTextModel } from 'a2ui-svelte/agent/gemini';
import { todoList } from '../src/lib/agent-definition';      // your app's agent
import TodoListPage from '../src/routes/todos/+page.svelte'; // your app's page

it('sets a due date', async () => {
  render(TodoListPage);
  const agent = new Agent(todoList, new GeminiTextModel({ apiKey, model }));
  await agent.start();
  if (agent.configIssue) throw new Error(agent.configIssue);

  await agent.send('Set the due date of the Invoices task to 2026-04-15');

  expect(screen.getByLabelText('Invoices due date')).toHaveValue('2026-04-15');
  expect(agent.debug.usage.peakTotal).toBeLessThan(8_000);   // what it cost
  await agent.stop();
});
```

## It is your agent

An `Agent` is your definition plus a model, and the eval changes only
the model — node has no browser to mint a token, and each scenario
wants a fresh conversation. So keep the definition in a module
(`src/lib/agent-definition.ts`) that your layout and your evals both
import; it needs no other wiring, since the agent sees every mounted
surface by default.

## Assert on your app

Through the same handles as a [component test](testing.md):

- the DOM — `screen`;
- the surface the model saw — `surface('todo-list')!.getDataModel!()`;
- what it replied — `agent.transcript`;
- what it cost — `agent.debug.usage` (`peakTotal`, `sumPromptTokens`,
  `sumResponseTokens`, provider-reported).

## Fail loudly on a bad setup

`agent.start()` records connect failures in `agent.configIssue` instead of
throwing. Without the `if (agent.configIssue) throw …` line above, a wrong
API key reads as the model getting the answer wrong.

## Voice models under node

Wrap the model:

```ts
import { Agent, withoutAudio } from 'a2ui-svelte/agent';
import { GeminiLiveModel } from 'a2ui-svelte/agent/gemini';

new Agent(todoList, withoutAudio(new GeminiLiveModel({ token })));
```

The model still generates audio, so the token bill is unchanged — exactly
the production load. The frames are dropped and the output transcription
carries the text.

## Quota pacing

Free tiers are exhausted by tokens per minute, not request count, and a
streaming session re-bills its whole context every turn. Space the turns
(ours: `A2UI_EVAL_TURN_GAP_MS`), run one scenario at a time against a live
socket, and retry 429s with backoff rather than widening the matrix.

## The worked example

[evals/](../../evals/) is our own suite and the thing to copy: `pnpm eval`
runs the context-cost measurement and drives a real Gemini model over the
real `Agent`, failing if `GEMINI_API_KEY` is unset (environment or repo-root
`.env`); `pnpm eval:hermetic` runs the context-cost measurement alone, with
no key and no network. See its [README](../../evals/README.md) for the knobs
and the profile matrix.
