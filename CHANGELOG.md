# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [0.1.0](https://github.com/conversabile/a2ui-svelte/compare/v0.0.3...v0.1.0) (2026-10-03)


### ⚠ BREAKING CHANGES

* **agent:** return a per-component surface delta instead of the whole tree
* **agent:** AgentTransport is now AgentModel, TransportCapabilities is
AgentModelCapabilities, AgentTransportConnectOptions is
AgentModelConnectOptions, AgentTransportEventMap is AgentModelEventMap, and
the eight transport classes (GeminiLive, GeminiText, AnthropicText,
OpenAIText, OpenAIRealtime, DeepgramVoiceAgent, HumeEvi, Scripted) end in
Model rather than Transport, along with their options types.
forwardTransport/ForwardedTransport are forwardModel/ForwardedModel, and
agent.transport is agent.model. No deprecated aliases ship.
* **evals:** fail pnpm eval without a key, add pnpm eval:hermetic
* **core:** ALL_EXTRAS.toolResultSurfaceEcho is now 'changed'
instead of 'full'. Apps that never called configureExtensions get
delta tool results instead of a full surface snapshot on every call.
Set configureExtensions({ toolResultSurfaceEcho: 'full' }) to keep
the old behaviour.
* **renderer:** point_to_elements results report status success|error instead of pointed|not_found.
* **core:** register the generic tools once and build the echo in the Agent
* extensions are now one app-wide record set with
configureExtensions() instead of a per-surface prop. Removed: the `options`
prop on <StaticSurface>/<DynamicSurface>, A2UI_EXTENSIONS_CONTEXT_KEY,
resolveExtensionOptions, the `extensions` field on surface handles, and the
ExtensionOptions type name (now Extensions). `toolResultExtras: true |
'diff' | false` is now `toolResultSurfaceEcho: 'full' | 'changed' | 'none'`.
Migrate: call configureExtensions({...}) once at startup (a root layout).
* **components:** Button's `action={{ name }}` prop is removed with no
replacement. Write `id` + `onclick`; the action name is the component id.

### Features

* add "mute" button to the voice shell ([66ccc44](https://github.com/conversabile/a2ui-svelte/commit/66ccc44d2ad1607c9779d633be6fe7c3363f83d3))
* add /explore skill to explore the codebase and implementation plans ([3c55837](https://github.com/conversabile/a2ui-svelte/commit/3c558379fed557835ef09e58878e7c494850a440))
* add debug panel feature in Voice Shell ([2deefa6](https://github.com/conversabile/a2ui-svelte/commit/2deefa68f9a25a8c392f30293c4896ae2eafb0aa))
* add option to run evals against GeminiLive ([31be1d3](https://github.com/conversabile/a2ui-svelte/commit/31be1d3efdee371745149582f4cdf008e42687c1))
* add point-to-item extension ([e6dbd72](https://github.com/conversabile/a2ui-svelte/commit/e6dbd72859732609580be8574f7913f436e1729b))
* **agent:** add debug conversation trace to Agent Shell ([345b5f1](https://github.com/conversabile/a2ui-svelte/commit/345b5f1ea6ffc5154c25561118b4841a8f39e987))
* **agent:** add support for extended thinking in Gemini Live model ([3657d94](https://github.com/conversabile/a2ui-svelte/commit/3657d94782ee548d2dd63e0af30bd0412e16df20))
* **agent:** add turn-completion signal (agent.send / agent.on) ([b9e83fd](https://github.com/conversabile/a2ui-svelte/commit/b9e83fd726f31a2c55738665f364e5f508c8e7a6))
* **agent:** add withoutAudio transport mask ([f25863d](https://github.com/conversabile/a2ui-svelte/commit/f25863d6d06d68eab94f405c937d558dbf00fb27))
* **agent:** default AgentDefinition.surfaces to every mounted surface ([53903bf](https://github.com/conversabile/a2ui-svelte/commit/53903bf372e625db81b96833be2ce671bbc57985))
* **agent:** implement optional subtitle-style transcription instead of last 2 message bubbles in Agent Shell ([3003b85](https://github.com/conversabile/a2ui-svelte/commit/3003b85fe386b69e4d3fad48923e7cd353ff4f9c))
* **core:** default toolResultSurfaceEcho to 'changed' ([da56d52](https://github.com/conversabile/a2ui-svelte/commit/da56d52c388ea24de342eb10f70661dbe641258f))
* **core:** track mounted surfaces in a global registry ([c91e36e](https://github.com/conversabile/a2ui-svelte/commit/c91e36ee99b8acf0b72640ba8bc700e0e2197fa1))
* expose a dev-only window.__a2ui handle for e2e tests ([ae71c14](https://github.com/conversabile/a2ui-svelte/commit/ae71c1432509b9025151b1b4ef79b2b294e3bd33))
* implement additional providers for agentic interaction ([2ee6fb5](https://github.com/conversabile/a2ui-svelte/commit/2ee6fb5c0f3a657e9654e46eaa8aac7dab2493c4))
* implement agent evaluation suite ([8263496](https://github.com/conversabile/a2ui-svelte/commit/82634962cf135cb1ba7a3cc37e357eee5b79dd61))
* rename VoiceShell as AgentShell, unify abstractions to support both text and voice models ([001b33b](https://github.com/conversabile/a2ui-svelte/commit/001b33bf1ad13f91005adcb603df242b3b864188))
* **testing:** add agentCall test helper that fails closed on tool errors ([03f2dbb](https://github.com/conversabile/a2ui-svelte/commit/03f2dbb988529d5a2bd0e69f095a8a78016b23cd))


### Bug Fixes

* **agent:** bump @anthropic-ai/sdk to 0.123.0 for browser bundling ([e049c40](https://github.com/conversabile/a2ui-svelte/commit/e049c404ffa3b16ed2820be60e00b283dfb8a53b))
* **agent:** defer live turn-complete until tool results are back ([cfa6a0a](https://github.com/conversabile/a2ui-svelte/commit/cfa6a0acd5b4e86f6107d59153da6d5ac1e92abf))
* **agent:** stop truncating and duplicating the model transcript ([9fc5e30](https://github.com/conversabile/a2ui-svelte/commit/9fc5e30a12b4768f94c40ddbe22ed74feef59409))
* **components:** make Button's `child` reactive and accept a children snippet ([6210b0b](https://github.com/conversabile/a2ui-svelte/commit/6210b0b3fbf9183adacf82edc5ffa62c54924b1f))
* **components:** register TextField update action when only an id is given ([9c0d792](https://github.com/conversabile/a2ui-svelte/commit/9c0d792eddf74b8a5ad8c3c12873a62c5627191e))
* **components:** report the resolved data-model key in update results ([eea5c7f](https://github.com/conversabile/a2ui-svelte/commit/eea5c7fac083186135522cc7d28ad297bbfe7b36))
* **components:** run Button onclick without an explicit action prop ([1b1e746](https://github.com/conversabile/a2ui-svelte/commit/1b1e7463ea01d7fc28ff36382c8ccf74a1a17a79))
* **core:** keep detached components buffered instead of rejecting the update ([c89be37](https://github.com/conversabile/a2ui-svelte/commit/c89be3709f2882a2f0d12144fe646826f24b7390))
* fix build warning in TextField.svelte ([1ee204d](https://github.com/conversabile/a2ui-svelte/commit/1ee204d02f2bc74e253e7e33807fd8333e82d7e4))
* fix CSS variable for app theming ([1ee95b1](https://github.com/conversabile/a2ui-svelte/commit/1ee95b170dfeb895e9794987355ed60877fd958c))
* guard CSS.escape and scrollIntoView for non-browser DOMs to enable testing through jsdom ([85baebf](https://github.com/conversabile/a2ui-svelte/commit/85baebfc018fe94254126bd24e98c61d0eeaba20))
* unregister surface tools on unmount ([8164944](https://github.com/conversabile/a2ui-svelte/commit/816494450b658855ef13aae5b1bba95271aaa68b))


### Refactors

* abstract agent logic from specific voice implementation ([9b968c4](https://github.com/conversabile/a2ui-svelte/commit/9b968c44e382c9d010414fee1dc0dde0c4663f7e))
* **agent:** rename AgentTransport to AgentModel ([d413ca4](https://github.com/conversabile/a2ui-svelte/commit/d413ca4871aa64c0176e452aa5d20d953002cfa5))
* **core:** register the generic tools once and build the echo in the Agent ([f0fa02e](https://github.com/conversabile/a2ui-svelte/commit/f0fa02e49bf36418a8844f187a793cc73d8368a8))
* **evals:** drop quiesce hacks and hand-rolled transport masks ([2e36fa5](https://github.com/conversabile/a2ui-svelte/commit/2e36fa5b91c20ec14a1a44f99a6885db4cef53b3))
* **evals:** fail pnpm eval without a key, add pnpm eval:hermetic ([8071d37](https://github.com/conversabile/a2ui-svelte/commit/8071d3711a78d7cbfae5814624512357228fc439))
* introduce neutral AgentTransport contract (WP1) ([8f4ae1a](https://github.com/conversabile/a2ui-svelte/commit/8f4ae1a4b5e94f8832838bc720061e354c65c6e2))
* make extensions global and rename toolResultExtras ([9ea06a6](https://github.com/conversabile/a2ui-svelte/commit/9ea06a63af42097f1696274229e17e8b81b20ca1))
* **renderer:** normalize every tool result on status success|error ([d117d00](https://github.com/conversabile/a2ui-svelte/commit/d117d000ceb0ac909249094551d1a400922a71cb))


### Performance

* **agent:** return a per-component surface delta instead of the whole tree ([40d810a](https://github.com/conversabile/a2ui-svelte/commit/40d810aa54ffa487b0e823d86a6610091f1c0de0))

### [0.0.3](https://github.com/conversabile/a2ui-svelte/compare/v0.0.2...v0.0.3) (2026-06-02)


### Features

* add "sync" mode to silently keep the agent up to date when the user interacts with the UI ([2438aee](https://github.com/conversabile/a2ui-svelte/commit/2438aee55d9df42134127e07c69c64e86a48c0c9))
* implement Strict mode for full A2UI v0.8 compatibility ([3353bd1](https://github.com/conversabile/a2ui-svelte/commit/3353bd12886ad06faf2b6e48ed7102c8d0f18fe6))


### Bug Fixes

* apply polling extension also to Dynamic Surfaces ([4d0bfc2](https://github.com/conversabile/a2ui-svelte/commit/4d0bfc28f425aa087e42f524da2acf702753c2f1))
* fix VoiceShell width ([0c0863e](https://github.com/conversabile/a2ui-svelte/commit/0c0863e9fd6a92d38a737b31a7949a7f80be971c))
* use standard versioning commit message ([887ec10](https://github.com/conversabile/a2ui-svelte/commit/887ec1093ca0356e1539b7b17c63122894d8c377))

### [0.0.2](https://github.com/conversabile/a2ui-svelte/compare/v0.0.1...v0.0.2) (2026-05-26)


### Features

* add authoring helpers to define custom components ([e0195a3](https://github.com/conversabile/a2ui-svelte/commit/e0195a330dc470a09be6380a583b8ec5db23bc52))
* add example application ([5ca3622](https://github.com/conversabile/a2ui-svelte/commit/5ca3622d8f190a0efab1b06b22f0c20dc7ded7d4))
* add remaining components to fulfill A2A spec v0.8 ([b7f6eb2](https://github.com/conversabile/a2ui-svelte/commit/b7f6eb246da3c50291fc1bde03f4a364194492d6))
* add skills for agentic coding ([648b70b](https://github.com/conversabile/a2ui-svelte/commit/648b70b7d28185f7bb524e7c21412b2905d8d10d))


### Bug Fixes

* fix button click actions in dynamic surfaces ([2287350](https://github.com/conversabile/a2ui-svelte/commit/22873505849a7e8d79cc86cf36cb41cd4c4b0ea1))
* fix text field interactions in dynamic surfaces ([0f208a6](https://github.com/conversabile/a2ui-svelte/commit/0f208a6433eb624b5ba97712ba616024c88f2938))


### Refactors

* split responsibilities of the GeminiLive component into transport, agent and shell ([4493045](https://github.com/conversabile/a2ui-svelte/commit/4493045))
* implement pluggable component catalogs ([25f4a96](https://github.com/conversabile/a2ui-svelte/commit/25f4a96))
* replace gemini-session with a callback pattern to decouple from Svelte state management ([cf113dc](https://github.com/conversabile/a2ui-svelte/commit/cf113dc))

## 0.0.1 (2026-05-10)

### Features

* add core framework, components, renderer and voice agent
