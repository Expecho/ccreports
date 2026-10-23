// Runs as npm's "version" lifecycle script: copies the new package.json version
// into the Claude Code plugin manifest, so `npm version <x>` bumps both.
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const file = '.claude-plugin/plugin.json';
const plugin = JSON.parse(readFileSync(file, 'utf8'));
plugin.version = version;
writeFileSync(file, JSON.stringify(plugin, null, 2) + '\n');
console.log(`${file}: version ${version}`);
