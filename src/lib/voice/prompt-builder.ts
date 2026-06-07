/**
 * Back-compat shim. The prompt-builder moved to the neutral agent layer in WP3
 * (`a2ui-svelte/agent`); this re-export keeps the historical
 * `a2ui-svelte/voice` import path working. New code should import from
 * `../agent/prompt-builder`.
 */
export * from "../agent/prompt-builder";
