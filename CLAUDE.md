# CLAUDE.md — a2ui-svelte

## What This Project Is

`a2ui-svelte` is a **Svelte 5 library** that implements the **A2UI framework**: a
pattern where a human user and a live AI agent simultaneously interact with the
same UI. The agent reads the UI as a JSON component tree and drives it through
generic tools; the human uses the normal HTML. Both see the same components, the
same component IDs, and the same state.

This is both a runtime and a **reference implementation of A2UI** — the goal is a
library of reusable, 100%-spec-compliant Svelte components, plus a transport-neutral
agent layer, that any A2UI-compatible app or agent can consume.

Tech stack: SvelteKit library (`@sveltejs/package`), Svelte 5 runes, Vitest,
Gemini Live API for the built-in voice transport. Theme-agnostic — ships
`--a2ui-*` CSS tokens that default to Pico CSS variables but work without Pico.

It is published to npm as `a2ui-svelte`. Read [README.md](README.md) for the
public-facing overview and quick start, and [docs/](docs/) for the full guides.

---

## Canonical A2UI Spec

The A2UI specification is the **single source of truth** for what JSON this
library may emit and accept. It lives **outside** this repo:

- **v0.8 spec:** <https://a2ui.org/> — the canonical component catalog, message
  kinds, and event shapes.
- **Our honest compatibility statement:** [docs/guides/a2ui-compatibility.md](docs/guides/a2ui-compatibility.md)
  — exactly what we support, what's experimental, and where we extend the spec.

When the spec and this library disagree, the spec wins and the library is the
bug — unless the behaviour is a deliberate, namespaced extension (see Rule 5).

---

## Key Concepts

### Surfaces

- **Static surface** (`<StaticSurface>`) — a region of UI you declare in Svelte.
  The agent sees it as a JSON tree and interacts through generic tools
  (`click_button`, `update_text_field`). This is our **inversion** of A2UI (you
  own the UI, not the agent) and the **primary, stable** path.
- **Dynamic surface** (`<DynamicSurface>`) — the classic A2UI model: an empty
  canvas the agent populates at runtime via `surfaceUpdate` / `beginRendering`.
  Renderer reads from a pluggable catalog. **Experimental** — agent-generated UI
  is currently slow and error-prone.

The renderer core (state, processor, serializer, registries) lives in
[src/lib/core/](src/lib/core/) and is **model- and channel-agnostic** — nothing
voice- or provider-specific belongs there.

### Catalog

The **catalog** maps A2UI type names to Svelte components. `DEFAULT_CATALOG`
([src/lib/components/default-catalog.ts](src/lib/components/default-catalog.ts))
is the standard 16-component set; `extendCatalog` adds custom ones. Authoring
helpers (`defineA2uiComponent`, `<A2UIRepresentation>`) live in
[src/lib/authoring/](src/lib/authoring/).

### Transports and the Agent

One framework, three pieces — definition, transport, shell (see
[docs/implementation_plans/transport-neutral-agent-framework.md](docs/implementation_plans/transport-neutral-agent-framework.md) §0.5):

- **`AgentTransport`** ([src/lib/agent/transport.ts](src/lib/agent/transport.ts))
  — the one provider-agnostic contract. A `TransportCapabilities` descriptor lets
  the orchestrator and the shell adapt (streaming voice vs. request/response
  text, audio modalities, barge-in, history ownership) **without ever branching
  on the transport's identity**. Audio members (`sendAudioChunk?`, `audio-out`,
  `interrupted`) are optional parts of this same contract — there is no separate
  voice interface. **Auth lives on each transport's constructor**, never on the
  agent. Built-ins: `GeminiLiveTransport` (streaming audio-to-audio) and
  `GeminiTextTransport` (request/response) in
  [src/lib/agent/gemini/](src/lib/agent/gemini/), plus the deterministic
  `ScriptedTransport` for tests.
- **`AgentDefinition` + `Agent`** ([src/lib/agent/agent.svelte.ts](src/lib/agent/agent.svelte.ts))
  — the definition is a plain object (instructions, surfaces, context, mode,
  tuning; future guardrails/subagents) declared once and valid for every
  transport; `new Agent(definition, transport)` is the orchestrator: prompt
  assembly, tool dispatch, surface-watch heartbeat, reactive transcript/debug
  state — and the mic recorder / speaker player / mute, created exactly when the
  transport's capabilities include audio.
- **`<AgentShell>`** ([src/lib/agent/AgentShell.svelte](src/lib/agent/AgentShell.svelte))
  — the one opt-in UI for every transport: chat bar + transcript + status +
  debug, growing the mic/mute cluster when `agent.capabilities.input` includes
  `'audio'`. Snippet slots replace pieces; `headless={true}` disables it.
- **A2A network transport** ([src/lib/transport/a2a.ts](src/lib/transport/a2a.ts))
  — message types, envelope helpers (`wrapA2A`/`unwrapA2A`), and the
  `<A2ASurface>` adapter for connecting a 3rd-party agent. **No working
  SSE/WebSocket transport ships — consumers bring their own.**

### Extensions

Non-spec behaviours (surface-change polling, batched tools, richer tool results,
`point_to_elements` highlight, XML-tagged-text `userAction`) ship **behind a
per-surface flag** and emit their data under `extensions: { 'a2ui-svelte': … }`
([src/lib/core/extensions.ts](src/lib/core/extensions.ts)). Spec-strict consumers
drop the namespace and still get exactly v0.8.

---

## Non-Negotiable Rules

These rules apply to every task. Violating them breaks A2UI interoperability, the
spec contract, theming, or the agent's ability to target elements.

### 1. A2UI Spec Compliance

Every surface component must produce JSON that is **100% compliant** with the
[A2UI v0.8 specification](https://a2ui.org/).

- **Use only standard catalog component types**: Text, Image, Icon, Divider,
  Button, TextField, CheckBox, Slider, DateTimeInput, MultipleChoice, Row,
  Column, List, Card, Modal, Tabs. See [docs/reference/components.md](docs/reference/components.md).
- **Respect property contracts**: Card has a single `child` (not `children`) —
  wrap multiple elements in a Column or Row inside a Card. Column/Row/List use
  `children: { explicitList: [...] }`. Button has a single `child` (its label
  Text node).
- **No synthesis hacks**: if a Svelte template doesn't naturally produce valid
  A2UI JSON, restructure the template — don't add fixup logic in the serializer.
- **Dual-facing as last resort**: only when a native component can't achieve the
  needed visual style, register as a standard A2UI type and render custom HTML
  underneath. `AutocompleteField` and the `<A2UIRepresentation>` authoring helper
  are the canonical pattern — see [docs/guides/composite-components.md](docs/guides/composite-components.md).

### 2. Theming — Tokens Only, Never Hardcode

The library is theme-agnostic and must stay that way.

- **Never hardcode colours.** Style the catalog through the `--a2ui-*` tokens in
  [src/lib/renderer/styles.css](src/lib/renderer/styles.css). New visual surface
  ⇒ a new token (defaulting to a Pico variable, with a plain fallback so the
  library works without Pico).
- **Must survive dark mode and token overrides** — a consumer overriding one
  `--a2ui-*` token (or loading Pico's dark theme) must re-skin without forking.
- **Allowed raw CSS**: layout only (`margin`, `gap`, `display`, flex/grid). Any
  colour/border/radius/spacing goes through a token.
- Full guide: [docs/guides/theming.md](docs/guides/theming.md).

### 3. Component IDs and Actions

- **Component IDs use hyphens throughout** — never mix `save-button` with
  `save_button`. Divergent separators cause agent hallucinations.
- **`action.name` = component `id`** — both appear in the surface JSON; keep them
  identical so the agent targets what it sees.
- **Generic tools are spec-canonical** — `click_button({element_id})` and
  `update_text_field({element_id, value})`. Batched siblings are an extension
  (Rule 5), never a replacement.
- **Tool results must report failure** — a tool that wraps a failing operation
  must return `status: 'error'` with the underlying message, so the agent learns
  the operation failed instead of silently continuing.

### 4. Screen/Tree Parity

**Everything visible on screen must be an A2UI component. Everything in the A2UI
tree must be visible on screen.** No exceptions. Hidden DOM elements (agent sees,
user doesn't) and bare HTML (user sees, agent doesn't) both break live-API
conversations and the shared-state guarantee.

- Use native catalog components for all visible content; style them with tokens.
- If the agent needs extra context beyond what's visible, use
  `contextInstructions` on the surface — never hidden elements.

### 5. Spec Strictness — Extensions Stay Namespaced

Every non-spec behaviour is **opt-in and namespaced**.

- It must ride behind a per-surface flag and emit its data under
  `extensions: { 'a2ui-svelte': … }` — never inline into spec-defined fields.
- A spec-strict consumer (`options={STRICT}`, or host-wide via
  `setContext(A2UI_EXTENSIONS_CONTEXT_KEY, STRICT)`) must still receive **exactly**
  what v0.8 promises, byte-for-byte in the spec fields.
- Document any new extension in [docs/guides/extensions.md](docs/guides/extensions.md).

### 6. Transport Neutrality

The orchestrator, the shell, and core **must never branch on a transport's
identity.**

- Adapt behaviour through `TransportCapabilities`, not `if (transport instanceof …)`.
  This includes audio: the `Agent` runs the mic recorder / speaker player and
  `<AgentShell>` shows the mic **iff** the capabilities advertise the `'audio'`
  modality — never because the transport is "the voice one".
- A request/response transport drives its tool-loop internally and emits the
  **same events** a voice transport does — one shared code path, not "two code
  paths in a trenchcoat."
- Never reintroduce per-channel classes (`VoiceAgent`, `VoiceTransport`,
  `VoiceShell`, `ChatShell` are deliberately gone). New channels are new
  **transports** (or transport wrappers, e.g. STT/TTS around a text model) —
  not new agents or shells.
- Keep model/provider specifics inside the transport adapters
  ([src/lib/agent/gemini/](src/lib/agent/gemini/)); nothing provider-specific
  belongs in [src/lib/core/](src/lib/core/) or the neutral agent/shell files.

### 7. Tests Ship With Behaviour

Tests are co-located Vitest specs (`*.test.ts`). Any new component, tool,
serializer path, extension, or transport behaviour ships with a test. Run
`pnpm test` before declaring a change done.

### 8. Public API Discipline

The package's surface is the `exports` map in [package.json](package.json)
(`./core`, `./components`, `./renderer`, `./authoring`, `./agent`,
`./agent/gemini`, `./transport`, `./skills`). Adding to it is cheap; **changing
or removing an export is a breaking change** — flag it, don't do it silently.
The package is pre-1.0 and experimental, but breakage should still be deliberate
and noted.

---

## Contribution Patterns

You do the changes, I make the commits. Don't stage/unstage files, never commit,
never push; never operate with git in general.

Commit messages follow **Conventional Commits** (`feat:`, `fix:`, `refactor:`,
`perf:`, …) because `standard-version` generates `CHANGELOG.md` and bumps the
version from them — so when you propose a commit message, use the right type.

Keep the library's own **skills** ([src/lib/skills/](src/lib/skills/)) in sync
with the code: if you change how a page, component, composite, agent wiring, or
theming is done, update the matching skill — it's what teaches consuming IDEs.

### Common commands

| Command | Does |
|---|---|
| `pnpm test` | Run Vitest |
| `pnpm check` | `svelte-check` type/diagnostic pass |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |
| `pnpm package` | Build the publishable `dist/` (`svelte-package` + `publint`) |
| `GEMINI_API_KEY=… pnpm --filter minimal-app dev` | Run the example consumer app |

---

## Documentation Map

Read the relevant docs before starting any implementation task.

| Task | Read |
|---|---|
| Understand what we do/don't support vs the spec | [docs/guides/a2ui-compatibility.md](docs/guides/a2ui-compatibility.md) |
| Build or modify a catalog component | [docs/guides/authoring-components.md](docs/guides/authoring-components.md) + [docs/reference/components.md](docs/reference/components.md) |
| Build a composite (bespoke HTML, agent sees a clean tree) | [docs/guides/composite-components.md](docs/guides/composite-components.md) |
| Theme components (tokens / custom catalog) | [docs/guides/theming.md](docs/guides/theming.md) |
| Work on the agent, transports, or `<AgentShell>` | [docs/guides/agent-integration.md](docs/guides/agent-integration.md) |
| Add or change a namespaced extension | [docs/guides/extensions.md](docs/guides/extensions.md) |
| Generalise the agent across voice/text transports | [docs/implementation_plans/transport-neutral-agent-framework.md](docs/implementation_plans/transport-neutral-agent-framework.md) |
| Understand A2UI spec / compliance | [v0.8 spec](https://a2ui.org/) + [docs/reference/components.md](docs/reference/components.md) |

---

## Key File Locations

| What | Where |
|---|---|
| Renderer core (state, processor, serializer) | [src/lib/core/](src/lib/core/) |
| Tool / action registries, user-action event bus | [src/lib/core/registries/](src/lib/core/registries/) |
| Extensions namespacing | [src/lib/core/extensions.ts](src/lib/core/extensions.ts) |
| Catalog-selection handshake | [src/lib/core/catalog-selection.ts](src/lib/core/catalog-selection.ts) |
| Component catalog + default map | [src/lib/components/](src/lib/components/) ([default-catalog.ts](src/lib/components/default-catalog.ts)) |
| Surfaces (Static / Dynamic / A2A) | [src/lib/renderer/](src/lib/renderer/) |
| Theme tokens | [src/lib/renderer/styles.css](src/lib/renderer/styles.css) |
| Authoring helpers (`defineA2uiComponent`, `<A2UIRepresentation>`) | [src/lib/authoring/](src/lib/authoring/) |
| Agent framework (contract, `Agent`, `AgentShell`, prompt builder, audio, debug) | [src/lib/agent/](src/lib/agent/) |
| Transport contract (`AgentTransport`, `TransportCapabilities`) | [src/lib/agent/transport.ts](src/lib/agent/transport.ts) |
| Gemini transports (Live + text) + token minter | [src/lib/agent/gemini/](src/lib/agent/gemini/) |
| A2A network types + envelope helpers | [src/lib/transport/a2a.ts](src/lib/transport/a2a.ts) |
| Library skills (for consuming IDEs) | [src/lib/skills/](src/lib/skills/) |
| Public API surface | `exports` in [package.json](package.json) |
| Runnable example consumer | [examples/minimal-app/](examples/minimal-app/) |
| Guides | [docs/guides/](docs/guides/) |
| Implementation plans (in-flight / archived) | [docs/implementation_plans/](docs/implementation_plans/) |
