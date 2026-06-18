# Transport providers — comparison and selection notes

This guide is about **picking a provider** for the agent: what each
built-in transport costs to try, how it authenticates from a browser,
and what made these providers fit the library (and others not). For the
mechanics of wiring a transport — the contract, the events, the
`Agent`/`<AgentShell>` plumbing — see the
[agent integration guide](agent-integration.md).

## At a glance

| Provider / transport | Channel | Architecture | Free way to try it | Browser auth |
|---|---|---|---|---|
| **Gemini** — `GeminiLiveTransport` | streaming voice | native speech-to-speech | AI Studio free-tier API key (rate-limited; dense surfaces burn it fast — see the [extensions guide](extensions.md) for the cost levers) | ephemeral token, minted server-side (`mintGeminiToken`) |
| **Gemini** — `GeminiTextTransport` | text | chat (request/response) | same free-tier key | `baseUrl` key proxy (or raw key, dev only) |
| **Anthropic** — `AnthropicTextTransport` | text | chat (request/response) | no free tier — pay-as-you-go console credit | `baseUrl` key proxy (or raw key, dev only) |
| **OpenAI** — `OpenAITextTransport` | text | chat (request/response) | no free tier — pay-as-you-go | `baseUrl` key proxy (or raw key, dev only) |
| **OpenAI** — `OpenAIRealtimeTransport` | streaming voice | native speech-to-speech | no free tier; metered per audio token (as of mid-2026, `gpt-realtime-2` is ~$32/M audio-in, ~$64/M audio-out) | ephemeral client secret (`mintOpenAIRealtimeSecret`) |
| **Deepgram** — `DeepgramVoiceAgentTransport` | streaming voice | managed STT→LLM→TTS pipeline | **$200 signup credits, no card** — the cheapest way to try a voice transport (agent runtime ~$4.50/h as of mid-2026) | short-lived grant JWT (`mintDeepgramToken`) via the WebSocket subprotocol |
| **Hume** — `HumeEviTransport` | streaming voice | native speech-to-speech (empathic — models prosody/emotion) | **free plan with monthly credits** | OAuth access token (`fetchHumeAccessToken`) as a query parameter |

Default models (all overridable via each transport's `model` option;
current as of mid-2026): Gemini `gemini-3.5-flash` (text) /
`gemini-3.1-flash-live-preview` (Live), Anthropic `claude-opus-4-8`,
OpenAI `gpt-5.2` (text) / `gpt-realtime-2` (Realtime), Deepgram
`nova-3` + `gpt-4o-mini` + `aura-2-thalia-en` (listen/think/speak),
Hume — the platform default unless you pin a `configId`/`voiceId`.

## Practical hints

- **Cheapest voice demo:** Deepgram. The signup credits are far beyond
  what a demo burns, the agent's "think" LLM is Deepgram-hosted (no
  second API key needed), and its audio formats match the library's
  contract natively.
- **Zero-budget voice that keeps working monthly:** Hume EVI (credits
  renew on the free plan) or the Gemini free tier — but watch Gemini
  Live's quota with dense surfaces (see
  [voice token costs](extensions.md)).
- **Best tool-calling voice:** OpenAI Realtime (`gpt-realtime-2`
  reasons before speaking and is precise with function calls) — at a
  price. It is also the only voice transport here with a true
  silent-context channel, so surface-sync never provokes a turn.
- **Pipeline vs native speech-to-speech:** Deepgram transcribes → runs
  a text LLM → synthesizes; the others are audio-native models.
  Pipelines are cheaper and let you pick the LLM (`thinkProvider`),
  audio-native models react to tone and interruptions more fluidly.
- **Latency-sensitive text:** the defaults are deliberately strong
  models (`claude-opus-4-8`, `gpt-5.2`); for a snappier demo agent set
  `model` to each provider's fast tier.

## What makes a provider fit this library

The transports keep the **whole agent definition client-side** — the
`Agent` assembles the system prompt and tool declarations per session
and pushes them over the provider's wire. A provider fits when:

1. **Browser-reachable.** A WebSocket or `fetch` API that works with a
   short-lived token (or a same-origin key proxy). No custom signing
   schemes the browser can't do.
2. **Configurable per session over the wire.** Prompt, tools, and audio
   formats sent at connect time — not baked into a platform-side agent
   object that you manage in a dashboard.
3. **Client-side tool execution.** The provider must hand tool calls
   back to the page (that's the whole point of A2UI) instead of only
   invoking server-hosted endpoints.
4. **Adaptable audio.** The contract fixes mic input at 16 kHz PCM and
   speaker output at 24 kHz PCM; the transport must be able to bridge
   to that (resampling/unpacking inside the transport is fine — OpenAI
   Realtime upsamples the mic stream, Hume unpacks its 48 kHz WAV
   output; Deepgram needs no conversion at all).

## Evaluated and not included

- **ElevenLabs Agents** — polished platform and a free tier, but the
  agent definition (prompt, tools, voice) lives **server-side as a
  dashboard `agent_id`**; the socket only overrides pieces of it. That
  inverts this library's model, where `AgentDefinition` is the single
  client-side source of truth (criterion 2). Revisit if they ship full
  socket-level configuration.
- **Amazon Nova Sonic** — capable speech-to-speech on Bedrock, but the
  API is AWS SigV4-signed bidirectional HTTP/2: not reachable from a
  browser without a full server-side relay (criterion 1).

A new provider that meets the four criteria is welcome as a new
transport directory under `src/lib/agent/<provider>/` — see the
[agent integration guide](agent-integration.md) for the contract and
the existing implementations as references. Per the library's rules
(CLAUDE.md §6), provider specifics never leak outside that directory.
