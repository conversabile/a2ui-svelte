/**
 * Drive the UI as the agent does — but throw where production swallows.
 *
 * `toolRegistry.execute` never throws: an unknown tool comes back as
 * `{ error }`, a failing element as `{ results: [{ status: 'error' }] }`.
 * That is right in production — the model needs the failure as a tool result
 * so it can recover — and wrong in a test, where a typo'd element id would
 * resolve quietly and surface three lines later as an unrelated assertion
 * failure.
 */

import { toolRegistry } from '../core/registries/tool-registry';

/**
 * Call any registered tool and throw unless every result item succeeded.
 * Returns the whole result object, so `expect(await agentClick('save-btn'))
 * .toMatchObject({ … })` still works.
 *
 * The check is negative (`status !== 'success'`), never `status === 'error'`:
 * the day a tool grows a `'rejected'` status, a positive check turns every
 * affected test green while the feature is broken. Every tool emits exactly
 * `'success'` or `'error'` — the prompt promises the model that, and
 * `builtin-tools.test.ts` drives every registered tool to prove it.
 */
export async function agentCall(
	name: string,
	args: Record<string, any> = {}
): Promise<Record<string, any>> {
	const result = await toolRegistry.execute(name, args);
	if (result?.error) throw new Error(`Tool "${name}" failed: ${result.error}`);
	for (const r of result?.results ?? [])
		if (r?.status !== 'success')
			throw new Error(`${name} did not succeed: ${JSON.stringify(r)}`);
	return result;
}

/** Click a button by component id, as the agent would. */
export const agentClick = (id: string) => agentCall('click_button', { element_id: id });

/** Set a value-bearing component by component id, as the agent would. */
export const agentFill = (id: string, value: string) =>
	agentCall('update_text_field', { element_id: id, value });
