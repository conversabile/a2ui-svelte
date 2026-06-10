/**
 * Minimal in-process result collector for the eval suite. Each scenario run
 * (one scenario × one profile) records a row; `printSummary()` renders a
 * fixed-width comparison table at the end of the file's test run and persists
 * the raw rows to `evals/results/` so runs can be diffed over time.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ScenarioRecord {
	scenario: string;
	profile: string;
	pass: boolean;
	notes: string[];
	requests: number;
	toolCalls: number;
	promptTokens: number;
	responseTokens: number;
	ms: number;
}

const records: ScenarioRecord[] = [];

export function record(r: ScenarioRecord): void {
	records.push(r);
}

function pad(s: string | number, w: number): string {
	return String(s).padEnd(w);
}
function padl(s: string | number, w: number): string {
	return String(s).padStart(w);
}

export function printSummary(title: string, fileTag: string): void {
	if (records.length === 0) return;

	const lines: string[] = [];
	lines.push('');
	lines.push(`══ ${title} ══`);
	lines.push(
		`${pad('scenario', 26)} ${pad('profile', 11)} ${pad('pass', 5)} ${padl('reqs', 5)} ${padl('tools', 6)} ${padl('inTok', 8)} ${padl('outTok', 7)} ${padl('ms', 7)}  notes`
	);
	for (const r of records) {
		lines.push(
			`${pad(r.scenario, 26)} ${pad(r.profile, 11)} ${pad(r.pass ? 'PASS' : 'FAIL', 5)} ${padl(r.requests, 5)} ${padl(r.toolCalls, 6)} ${padl(r.promptTokens, 8)} ${padl(r.responseTokens, 7)} ${padl(r.ms, 7)}  ${r.notes.join(' | ')}`
		);
	}

	// Per-profile aggregates: success rate + total billed input tokens.
	const profiles = [...new Set(records.map((r) => r.profile))];
	lines.push('');
	lines.push(`${pad('profile', 11)} ${padl('pass', 9)} ${padl('Σ inTok', 9)} ${padl('Σ outTok', 9)} ${padl('Σ ms', 8)}`);
	for (const p of profiles) {
		const rows = records.filter((r) => r.profile === p);
		const passed = rows.filter((r) => r.pass).length;
		const inTok = rows.reduce((s, r) => s + r.promptTokens, 0);
		const outTok = rows.reduce((s, r) => s + r.responseTokens, 0);
		const ms = rows.reduce((s, r) => s + r.ms, 0);
		lines.push(
			`${pad(p, 11)} ${padl(`${passed}/${rows.length}`, 9)} ${padl(inTok, 9)} ${padl(outTok, 9)} ${padl(ms, 8)}`
		);
	}
	lines.push('');

	// Vitest's default reporter can swallow hook-time console output — write
	// straight to stdout and persist an artifact.
	process.stdout.write(lines.join('\n') + '\n');

	const dir = path.resolve(__dirname, 'results');
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${fileTag}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
	fs.writeFileSync(file, JSON.stringify({ title, records }, null, 2));
	fs.writeFileSync(path.join(dir, `${fileTag}-latest.txt`), lines.join('\n'));
	process.stdout.write(`[evals] raw results written to ${file}\n`);
}
