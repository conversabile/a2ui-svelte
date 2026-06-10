# a2ui-svelte


> [!WARNING]
> **This package is experimental, breaking changes will be 
> introduced without notice. Use at your own risk for testing
> and study porposes only.**

A Svelte 5 runtime built on the [A2UI v0.8](https://a2ui.org/)
component catalog: build apps where a human user and a live AI agent
share the same UI. Both target the same Svelte components, the same
component IDs, and the same state.

Look at [A2UI v0.8 compatibility](#a2ui-v08-compatibility) for details about A2UI compatibility.

The library ships:

- A spec-aligned **component catalog** (Card, Column, Row, List, Tabs,
  Text, Button, TextField, Checkbox, …).
- **Dynamic surfaces** (`<DynamicSurface>`) — the standard A2UI model,
  where the agent renders the UI at runtime. Experimental today.
- **Static surfaces** (`<StaticSurface>`) — our inverted pattern (you
  own the UI, the agent reads and drives it). Not classic A2UI, but the
  primary, stable path.
- **Extensions** we added on top of the spec — surface-change polling,
  batched tools, richer tool results, an on-demand "point at this"
  highlight tool — namespaced so spec-strict consumers can ignore them.
- An **authoring helper** (`defineA2uiComponent` + `<A2UIRepresentation>`)
  for adding custom and composite components.
- A transport-neutral **agent framework**: define your agent once
  (`AgentDefinition`), connect it to any transport (streaming voice via
  `GeminiLiveTransport`, request/response text via `GeminiTextTransport`,
  deterministic `ScriptedTransport` for tests, or your own), and render
  the one `<AgentShell>` — it adapts to the transport's capabilities
  (the mic appears exactly when the transport speaks audio).
- **Skills** (Markdown, frontmatter-tagged) so agentic IDEs can teach
  themselves the library.

## Quick start

```bash
npm add a2ui-svelte
```

One file — a surface the human can use and a voice agent that can drive
the same surface, with all defaults enabled:

```svelte
<!-- src/routes/+page.svelte -->
<script lang="ts">
  import { StaticSurface } from 'a2ui-svelte/renderer';
  import { Card, Column, TextField, Button } from 'a2ui-svelte/components';
  import { Agent, AgentShell } from 'a2ui-svelte/agent';
  import { GeminiLiveTransport } from 'a2ui-svelte/agent/gemini';
  import 'a2ui-svelte/renderer/styles.css';

  let surface: ReturnType<typeof StaticSurface>;
  let name = $state('');

  const agent = new Agent(
    {
      instructions:        'You are a friendly assistant.',
      surfaces:            () => (surface ? [surface] : []),
      contextInstructions: () => 'The user can set their name here.'
    },
    new GeminiLiveTransport({
      token: async () =>
        (await (await fetch('/api/voice-token', { method: 'POST' })).json()).token
    })
  );
</script>

<StaticSurface bind:this={surface} surfaceId="hello">
  <Card><Column>
    <TextField id="name" fieldName="name" label="Name" bind:value={name} />
    <Button id="save" primary label="Save"
            action={{ name: 'save' }}
            onclick={() => alert(`Hi ${name}!`)} />
  </Column></Card>
</StaticSurface>

<AgentShell {agent} />
```

You'll also need a `/api/voice-token` endpoint that mints a short-lived
Gemini token (server-side, keeps your API key out of the browser) —
`mintGeminiToken` from `a2ui-svelte/agent/gemini` does it in three lines.

Prefer a text model? Swap the transport — nothing else changes:

```ts
import { GeminiTextTransport } from 'a2ui-svelte/agent/gemini';

const agent = new Agent(sameDefinition, new GeminiTextTransport({ baseUrl: '/api/gemini' }));
```

`<AgentShell>` notices the transport has no audio and renders the same
shell without the mic.

**Next steps:**

- The [agent integration guide](docs/guides/agent-integration.md) for
  the token endpoint, the production layout pattern (session store +
  layout-level agent), and how to write your own transport.
- The [`examples/minimal-app/`](examples/minimal-app/README.md) for a
  runnable SvelteKit project exercising every public API.
- The [guides](docs/guides/) for authoring components, composites,
  theming.

## Concepts

- **Static surface** (`<StaticSurface>`) — a region of UI you declare in
  Svelte. The agent sees it as a JSON tree and interacts through generic
  tools (`click_button`, `update_text_field`). This is our own inversion
  of A2UI (you own the UI, not the agent) and the **primary, stable**
  path.
- **Dynamic surface** (`<DynamicSurface>`) — the classic A2UI model: an
  empty canvas the agent populates at runtime via `surfaceUpdate` /
  `beginRendering`. Renderer reads from a pluggable catalog.
  **Experimental** — agent-generated UI is currently slow and error-prone.
- **Catalog** — the map from A2UI type names to Svelte components.
  `DEFAULT_CATALOG` is the standard set; `extendCatalog` adds your own.
- **Agent definition** (`AgentDefinition`) — what your agent *is*:
  instructions, the surfaces it can see and act on, page context. A
  plain object, declared once, independent of any model or channel.
- **Agent** (`Agent`) — the orchestrator: a definition connected to a
  transport (`new Agent(definition, transport)`). Owns prompt assembly,
  tool dispatch, the surface-watch heartbeat, reactive transcript state —
  and, when the transport speaks audio, the mic recorder, speaker
  player, and mute toggle. It adapts to the transport's declared
  `capabilities`, never to its identity.
- **Transport** (`AgentTransport`) — the per-model adapter. Ships:
  `GeminiLiveTransport` (streaming audio-to-audio over Gemini Live),
  `GeminiTextTransport` (request/response text), and `ScriptedTransport`
  (deterministic, model-free, for tests). Each owns its own auth.
- **AgentShell** (`<AgentShell>`) — the one opt-in UI: chat bar,
  transcript, status, debug panel — plus mic + mute exactly when
  `agent.capabilities` include audio. Snippet slots replace pieces;
  `headless={true}` disables it entirely.

Read the [guides](docs/guides/) for depth — authoring components,
composites, theming, agent integration.

## One agent, any transport

The same `AgentDefinition` runs over every transport — swap the second
constructor argument and everything else (instructions, tools,
surface-sync, transcript, shell) stays identical:

```ts
import { Agent, ScriptedTransport, type AgentDefinition } from 'a2ui-svelte/agent';
import { GeminiLiveTransport, GeminiTextTransport } from 'a2ui-svelte/agent/gemini';

const assistant: AgentDefinition = {
  instructions: 'You are a helpful assistant.',
  surfaces: () => mySurfaces
};

// Streaming voice (mic + mute appear in the shell):
new Agent(assistant, new GeminiLiveTransport({ token: mintEphemeralToken }));

// Request/response text via a key-hiding proxy (same shell, no mic):
new Agent(assistant, new GeminiTextTransport({ baseUrl: '/api/gemini' }));

// Deterministic, network-free tests:
new Agent(assistant, new ScriptedTransport([{ on: 'hi', text: 'Hello!' }]));
```

Transports describe themselves through `TransportCapabilities` (audio
modalities, barge-in, silent context channel, history ownership…), and
both the `Agent` and `<AgentShell>` adapt to that descriptor — so a
custom transport (another provider, or an STT/TTS wrapper that gives a
text model a voice) plugs into the identical machinery.

For the text path, keep your API key server-side by pointing the
transport at a same-origin proxy (`baseUrl`) that injects the real
`x-goog-api-key` — see [examples/minimal-app](examples/minimal-app) for
a working proxy route.

## Example app

`examples/minimal-app/` is a SvelteKit smoke-test consumer that
exercises every public API (static surface, dynamic surface, composite,
agent integration over both Gemini transports, theming). See its
[README](examples/minimal-app/README.md).

```bash
pnpm install
GEMINI_API_KEY=... pnpm --filter minimal-app dev
```

## A2UI v0.8 compatibility

A2UI is easy to misread, so two honest caveats up front — the full story
is in [What `a2ui-svelte` is](docs/guides/a2ui-compatibility.md):

- **The best-supported pattern isn't classic A2UI.** A2UI has the
  *agent generate the UI*; our `<StaticSurface>` flips that — you build
  the UI in Svelte and we make it readable and drivable by an agent via
  A2UI's components and tools. It's stable and what most apps want.
  `<DynamicSurface>` is the real agent-renders-the-UI model: it works,
  but is **experimental — expect slowness and rough edges.**
- **Connecting a 3rd-party agent is DIY.** End-to-end compatibility is
  proven on the built-in agent path (`a2ui-svelte` owns the agent). The
  spec's network transport is A2A; we ship the message types, envelope
  helpers, and an `<A2ASurface>` adapter — but **no working SSE/WebSocket
  transport.** You implement the `A2ATransport` interface to connect an
  external agent.

Within those bounds, the JSON `a2ui-svelte` emits and accepts conforms
to the [v0.8 spec](https://a2ui.org/):

- **All 16 standard catalog components** with their spec-defined props
  (Text, Image, Icon, Divider, Button, TextField, CheckBox, Slider,
  DateTimeInput, MultipleChoice, Row, Column, List, Card, Modal, Tabs).
- **All four server→client message kinds** — `surfaceUpdate`,
  `beginRendering`, `dataModelUpdate`, `deleteSurface`.
- **Both client→server events** — `userAction` (with the spec-mandated
  `{ name, surfaceId, sourceComponentId, timestamp, context }` shape)
  and `error`.
- **Spec-canonical generic tools** — `click_button({element_id})` and
  `update_text_field({element_id, value})`.
- **Catalog selection handshake** — client capabilities under
  `a2uiClientCapabilities`, standard-catalog URI default.
- **A2A envelope** — `application/json+a2ui` `DataPart` + the
  `X-A2A-Extensions` header, with `wrapA2A`/`unwrapA2A` helpers and the
  `<A2ASurface>` adapter. *Transport not included — bring your own.*

A small number of non-spec behaviours useful in practice — surface-change
polling, batched click/update tools, richer tool-result envelope, an
on-demand `point_to_elements` highlight tool, XML-tagged-text `userAction`
for voice live-APIs — ship behind a per-surface flag and emit their data
under `extensions: { 'a2ui-svelte': … }`. Spec-strict consumers drop the
namespace and still see exactly what v0.8 promises. Opt out per surface
with `options={STRICT}` or host-wide via
`setContext(A2UI_EXTENSIONS_CONTEXT_KEY, STRICT)`.

Full details: [compatibility](docs/guides/a2ui-compatibility.md) ·
[extensions](docs/guides/extensions.md).

## Authoring

### Add a new spec component

```svelte
<script lang="ts">
  import { defineA2uiComponent } from 'a2ui-svelte/authoring';
  let { id, value = 0, max = 5 }: { id?: string; value?: number; max?: number } = $props();

  const handle = defineA2uiComponent({
    type: 'RatingStars',
    id,
    a2ui: () => ({ value: { literalNumber: value }, max: { literalNumber: max } }),
    action: { type: 'update', handler: (v) => { value = Number(v); } }
  });
  export const dataAttr = handle.dataAttr;
  export const fire = handle.fire;
  export const componentId = handle.componentId;
</script>

{#if !handle.isHidden}
  <div {...handle.dataAttr}>...stars...</div>
{/if}
```

Then register it: `extendCatalog(DEFAULT_CATALOG, { RatingStars })`.

### Compose with bespoke HTML (composite)

```svelte
<script lang="ts">
  import { A2UIRepresentation } from 'a2ui-svelte/authoring';
  import { TextField, Button } from 'a2ui-svelte/components';

  let inputNode = $state<TextField>();
  let saveNode  = $state<Button>();
  let value = $state('');
</script>

<A2UIRepresentation>
  <TextField bind:this={inputNode} id="input" fieldName="value" bind:value />
  <Button bind:this={saveNode} id="save" primary label="Save"
          action={{ name: 'save' }} onclick={() => console.log(value)} />
</A2UIRepresentation>

<div class="my-look">
  <input bind:value {...inputNode?.dataAttr} />
  <button {...saveNode?.dataAttr} onclick={() => saveNode?.fire()}>Save</button>
</div>
```

The agent sees the standard tree; the user sees your custom HTML.

## Skills

Five Markdown skills ship with the library for agentic IDEs (Claude
Code, Cursor, …):

- `build-a2ui-page` — add a new page that the agent can read.
- `build-custom-component` — add a new spec component to the catalog.
- `build-composite-component` — bespoke HTML, agent sees a clean tree.
- `integrate-agent` — wire `Agent` + a transport + `<AgentShell>` in a layout.
- `style-and-theme` — token overrides + custom catalog.

Manual install (a CLI is deferred):

```bash
mkdir -p .claude/skills
cp node_modules/a2ui-svelte/dist/skills/*.md .claude/skills/
# or for Cursor: cp ... .cursor/rules/
```

## Documentation

- [What `a2ui-svelte` is (A2UI compatibility)](docs/guides/a2ui-compatibility.md)
- [A2UI specification](https://a2ui.org/)
- [Component reference](docs/reference/components.md)
- [Authoring guide](docs/guides/authoring-components.md)
- [Composite components](docs/guides/composite-components.md)
- [Theming](docs/guides/theming.md)
- [Agent integration](docs/guides/agent-integration.md)

## Releasing

Versioning is handled by [`standard-version`](https://github.com/conventional-changelog/standard-version). To cut a new release:

```bash
pnpm run release
```

This bumps `package.json`, regenerates `CHANGELOG.md`, and triggers a `precommit` hook that syncs `src/lib/version.json` (exposed as `a2ui-svelte/version`) with the new version and release date.

Dry run (no commits, no tags, no file writes): `pnpm run release:dry`.

> Don't use `pnpm run release -- --dry-run` — pnpm forwards the literal `--`,
> which `standard-version` (yargs) treats as the end-of-options marker, so the
> `--dry-run` flag silently gets discarded and a real release goes through.

## License

Apache 2.0

## Disclaimer

This is an independent project. It is not affiliated with, endorsed by, or
sponsored by Google or the official A2UI team.
