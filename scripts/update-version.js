import fs from 'fs';

// Get current version from package.json
const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));
const version = pkg.version;

// Attempt to get last release date from CHANGELOG.md
let releaseDate = new Date().toISOString().split('T')[0]; // fallback to today
try {
	const changelog = fs.readFileSync('./CHANGELOG.md', 'utf-8');
	const dateMatch = changelog.match(/###?\s+\[?\d+\.\d+\.\d+\]?.*?\((\d{4}-\d{2}-\d{2})\)/);
	if (dateMatch) {
		releaseDate = dateMatch[1];
	}
} catch (e) {
	console.warn('Could not read CHANGELOG.md for release date.');
}

// Write to src/lib/version.json
const content = { version, releaseDate };
fs.writeFileSync('./src/lib/version.json', JSON.stringify(content, null, 2) + '\n');

// Write to stderr, not stdout: standard-version's `precommit` hook captures a
// script's stdout and uses it as the release commit message. Logging to stderr
// keeps the message visible without hijacking the "chore(release): x.y.z" commit.
console.error(`Updated version info: v${version} (${releaseDate})`);
