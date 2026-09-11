/**
 * `a2ui-svelte/testing` — test-only inversions of production behaviour.
 *
 * Nothing else goes here: everything a test needs that an app could also use
 * lives in `./core` and `./agent`. An export earns this subpath only if it is
 * useless or harmful in a running app, which lets consumers lint the boundary
 * (`no-restricted-imports` on `a2ui-svelte/testing` outside `*.test.ts`).
 */

export { agentCall, agentClick, agentFill } from './agent-actor';
