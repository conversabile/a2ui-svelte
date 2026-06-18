import { env } from '$env/dynamic/private';

/**
 * Server-side provider key resolution for the example app.
 *
 * Keys come from `examples/minimal-app/.env` (copy `.env.template`). A value
 * still carrying its `fake-…` placeholder counts as **not configured** — so
 * copying the template verbatim doesn't light up providers that would then
 * fail at connect time. `$env/dynamic/private` (not `static`) so missing
 * keys don't break the build: every provider is optional.
 */
export type ProviderId = 'gemini' | 'anthropic' | 'openai' | 'deepgram' | 'hume';

function real(value: string | undefined): string | undefined {
	return value && !value.startsWith('fake-') ? value : undefined;
}

export const apiKey = {
	gemini: () => real(env.GEMINI_API_KEY),
	anthropic: () => real(env.ANTHROPIC_API_KEY),
	openai: () => real(env.OPENAI_API_KEY),
	deepgram: () => real(env.DEEPGRAM_API_KEY),
	hume: () => real(env.HUME_API_KEY),
	humeSecret: () => real(env.HUME_SECRET_KEY)
};

/** Which providers the model picker may offer (`true` = key configured). */
export function availability(): Record<ProviderId, boolean> {
	return {
		gemini: !!apiKey.gemini(),
		anthropic: !!apiKey.anthropic(),
		openai: !!apiKey.openai(),
		deepgram: !!apiKey.deepgram(),
		// Hume needs the key pair — the OAuth grant uses both.
		hume: !!(apiKey.hume() && apiKey.humeSecret())
	};
}
