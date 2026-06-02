# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

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
