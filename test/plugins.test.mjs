import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadPlugins, loadCopilotPlugins, pluginRows, pluginsJSON } from '../src/plugins.mjs';
import { buildSummary } from '../src/report.mjs';
import { toMarkdown } from '../src/formats.mjs';

async function configDir() {
  const root = await mkdtemp(path.join(tmpdir(), 'ccreports-plugins-'));
  const project = path.join(root, 'work', 'app');
  const cache = (name, version) => path.join(root, 'plugins', 'cache', 'market', name, version);
  await mkdir(path.join(cache('guard', '1.2.0'), 'hooks'), { recursive: true });
  await mkdir(path.join(project, '.claude'), { recursive: true });
  await mkdir(path.join(root, 'projects'));
  await writeFile(
    path.join(cache('guard', '1.2.0'), 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/guard.mjs"' }] }] } }),
  );
  const install = (scope, version, extra = {}) => ({ scope, version, installPath: cache(extra.name ?? 'x', version), lastUpdated: '2026-10-20T08:00:00.000Z', ...extra });
  await writeFile(
    path.join(root, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'guard@market': [install('user', '1.2.0', { name: 'guard' })],
        'kit@market': [install('user', '3.0.0'), install('project', 'abc123def456', { projectPath: project })],
        'idle@market': [install('local', '0.1.0', { projectPath: path.join(root, 'other') })],
      },
    }),
  );
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({ enabledPlugins: { 'guard@market': true, 'kit@market': false } }));
  await writeFile(path.join(project, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'kit@market': true } }));
  return { root, project, guardRoot: cache('guard', '1.2.0') };
}

test('installed plugins with version, scope, enabled state and usage', async () => {
  const { root, project, guardRoot } = await configDir();
  const plugins = await loadPlugins([path.join(root, 'projects')]);
  assert.equal(plugins.length, 4);

  const totals = {
    skills: new Map([['kit:plan', { model: 2, user: 1 }], ['plan', { model: 5, user: 0 }]]),
    commands: new Map([['/kit:plan', 1], ['/clear', 3]]),
    agents: new Map([['kit:reviewer', { launches: 4 }], ['Explore', { launches: 9 }]]),
    mcpServers: new Map([['plugin_kit_docs', 6], ['github', 2]]),
    hooks: new Map([[`node "${guardRoot}/guard.mjs"`, { runs: 7 }], ['other', { runs: 1 }]]),
  };
  const rows = pluginRows(plugins, totals);
  assert.deepEqual(
    rows.map((p) => [p.name, p.scope, p.version, p.enabled]),
    [
      ['kit', 'project', 'abc123def456', true], // enabled in the project's settings
      ['kit', 'user', '3.0.0', false],
      ['guard', 'user', '1.2.0', true],
      ['idle', 'local', '0.1.0', null], // not set in settings.local.json
    ],
  );
  assert.deepEqual(rows[0].usage, { skills: 3, commands: 1, agents: 4, mcpCalls: 6, hookRuns: 0, total: 14 });
  assert.equal(rows[2].usage.hookRuns, 7);
  assert.equal(rows[3].usage.total, 0);

  // --project keeps user installs and those of matching projects.
  assert.deepEqual(
    pluginRows(plugins, totals, { project: 'work' }).map((p) => `${p.name}/${p.scope}`),
    ['kit/project', 'kit/user', 'guard/user'],
  );
  assert.equal(pluginsJSON(rows)[0].installPath, undefined);
  assert.equal(pluginsJSON(rows)[0].projectPath, project);

  const empty = { tools: new Map(), mcpServers: new Map(), skills: new Map(), commands: new Map(), hooks: new Map(), agents: new Map(), models: new Map(), sessions: new Set(), projects: new Set(), toolTokens: new Map(), mcpServerTokens: new Map(), skillTokens: new Map(), shellCategories: new Map() };
  const md = toMarkdown(buildSummary({ totals: empty }, { top: 15, showCost: false, plugins: rows }));
  assert.match(md, /## Installed plugins/);
  assert.match(md, /\| guard \| market \| 1\.2\.0 \| user \| +\| yes \| 2026-10-20 \|/);
});

test('no plugin config means no plugins', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ccreports-plugins-'));
  assert.deepEqual(await loadPlugins([path.join(root, 'projects')]), []);
});

test('GitHub Copilot plugins: installs, enabled state and skills used with or without prefix', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ccreports-plugins-'));
  const cache = path.join(root, 'installed-plugins', 'market', 'dotnet');
  await mkdir(path.join(cache, 'skills', 'csharp-refactoring'), { recursive: true });
  await mkdir(path.join(root, 'session-state'));
  await writeFile(path.join(cache, 'plugin.json'), JSON.stringify({ name: 'dotnet', skills: ['./skills/'] }));
  await writeFile(
    path.join(root, 'config.json'),
    '// This file is managed automatically.\n' +
      JSON.stringify({
        installedPlugins: [
          { name: 'dotnet', marketplace: 'market', version: '0.2.4', installed_at: '2026-10-01T11:57:20Z', cache_path: cache, enabled: true },
          { name: 'off', marketplace: 'market', version: '1.0.0', enabled: true },
        ],
      }),
  );
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({ enabledPlugins: { 'off@market': false } }));
  const plugins = await loadCopilotPlugins([path.join(root, 'session-state')]);
  assert.deepEqual(
    plugins.map((p) => [p.id, p.version, p.enabled, p.product]),
    [
      ['dotnet@market', '0.2.4', true, 'GitHub Copilot'],
      ['off@market', '1.0.0', false, 'GitHub Copilot'], // settings.json wins over config.json
    ],
  );

  const totals = {
    skills: new Map([['csharp-refactoring', { model: 1, user: 1 }], ['dotnet:setup', { model: 0, user: 1 }], ['plan', { model: 3, user: 0 }]]),
    commands: new Map(),
    agents: new Map(),
    mcpServers: new Map(),
    hooks: new Map(),
  };
  const rows = pluginRows(plugins, totals);
  assert.equal(rows[0].usage.skills, 3);
  assert.equal(pluginsJSON(rows)[0].skillNames, undefined);

  // Plugins from two products get a Product column.
  const claude = { ...rows[1], product: 'Claude Code' };
  const empty = { tools: new Map(), mcpServers: new Map(), skills: new Map(), commands: new Map(), hooks: new Map(), agents: new Map(), models: new Map(), sessions: new Set(), projects: new Set(), toolTokens: new Map(), mcpServerTokens: new Map(), skillTokens: new Map(), shellCategories: new Map() };
  const md = toMarkdown(buildSummary({ totals: empty }, { top: 15, showCost: false, plugins: [rows[0], claude] }));
  assert.match(md, /\| Product \| Plugin \|/);
  assert.match(md, /\| GitHub Copilot \| dotnet \| market \| 0\.2\.4 \|/);
});
