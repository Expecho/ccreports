// Installed Claude Code plugins (<config dir>/plugins/installed_plugins.json),
// whether each is enabled (the enabledPlugins setting of its scope), and how
// often the transcripts used what it provides.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

async function readJSON(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The settings file that holds a scope's enabledPlugins. */
function settingsFile(root, install) {
  if (install.scope === 'user' || !install.projectPath) return path.join(root, 'settings.json');
  const name = install.scope === 'local' ? 'settings.local.json' : 'settings.json';
  return path.join(install.projectPath, '.claude', name);
}

/** Hook commands a plugin declares, as written (with ${CLAUDE_PLUGIN_ROOT}). */
async function hookCommands(installPath) {
  const commands = new Set();
  if (!installPath) return commands;
  const manifest = await readJSON(path.join(installPath, '.claude-plugin', 'plugin.json'));
  const files = [await readJSON(path.join(installPath, 'hooks', 'hooks.json'))];
  if (manifest?.hooks && typeof manifest.hooks === 'object') files.push(manifest);
  for (const file of files) {
    for (const groups of Object.values(file?.hooks ?? {})) {
      for (const group of Array.isArray(groups) ? groups : []) {
        for (const hook of group?.hooks ?? []) if (typeof hook?.command === 'string') commands.add(hook.command);
      }
    }
  }
  return commands;
}

/**
 * Installed plugins, one entry per install (a plugin can be installed for the
 * user and for projects). `dirs` are the projects directories; the plugin
 * config sits next to them.
 */
export async function loadPlugins(dirs) {
  const roots = [...new Set(dirs.map((d) => path.dirname(path.resolve(d))))];
  const plugins = [];
  const settings = new Map();
  const enabledIn = async (file) => {
    if (!settings.has(file)) settings.set(file, (await readJSON(file))?.enabledPlugins ?? {});
    return settings.get(file);
  };
  for (const root of roots) {
    const installed = await readJSON(path.join(root, 'plugins', 'installed_plugins.json'));
    for (const [id, value] of Object.entries(installed?.plugins ?? {})) {
      const at = id.lastIndexOf('@');
      const name = at > 0 ? id.slice(0, at) : id;
      const marketplace = at > 0 ? id.slice(at + 1) : '';
      // Version 1 of the file had one install per plugin; version 2 a list.
      for (const install of Array.isArray(value) ? value : [value]) {
        if (!install || typeof install !== 'object') continue;
        const enabled = (await enabledIn(settingsFile(root, install)))[id];
        plugins.push({
          id,
          name,
          marketplace,
          version: install.version ?? '',
          scope: install.scope ?? 'user',
          projectPath: install.projectPath ?? null,
          enabled: typeof enabled === 'boolean' ? enabled : null,
          installedAt: install.installedAt ?? null,
          lastUpdated: install.lastUpdated ?? null,
          installPath: install.installPath ?? null,
          hookCommands: await hookCommands(install.installPath),
        });
      }
    }
  }
  return plugins;
}

const sum = (map, match, valueOf = (v) => v) =>
  [...map].reduce((n, [key, value]) => (match(key) ? n + valueOf(value) : n), 0);

/**
 * What a plugin's skills, commands, subagents, MCP servers and hooks were used
 * in an aggregated bucket. Usage is per plugin, not per install.
 */
export function pluginUsage(plugin, totals) {
  const prefix = `${plugin.name}:`;
  const roots = plugin.installPath ? [plugin.installPath, plugin.installPath.replace(/\\/g, '/')] : [];
  const hooks = new Set(
    [...plugin.hookCommands].flatMap((c) => [c, ...roots.map((r) => c.replaceAll('${CLAUDE_PLUGIN_ROOT}', r))]),
  );
  const usage = {
    skills: sum(totals.skills, (k) => k.startsWith(prefix), (s) => s.model + s.user),
    commands: sum(totals.commands, (k) => k.replace(/^\//, '').startsWith(prefix)),
    agents: sum(totals.agents, (k) => k.startsWith(prefix), (a) => a.launches),
    // Claude Code names a plugin's MCP servers plugin_<plugin>_<server>.
    mcpCalls: sum(totals.mcpServers, (k) => k.startsWith(`plugin_${plugin.name}_`)),
    hookRuns: sum(totals.hooks, (k) => hooks.has(k), (h) => h.runs),
  };
  usage.total = usage.skills + usage.commands + usage.agents + usage.mcpCalls + usage.hookRuns;
  return usage;
}

/** Installs with their usage, filtered to a --project, most used first. */
export function pluginRows(plugins, totals, { project } = {}) {
  const needle = project?.toLowerCase();
  return plugins
    .filter((p) => !needle || !p.projectPath || p.projectPath.toLowerCase().includes(needle))
    .map((p) => ({ ...p, usage: pluginUsage(p, totals) }))
    .sort((a, b) => b.usage.total - a.usage.total || a.id.localeCompare(b.id) || a.scope.localeCompare(b.scope));
}

/** JSON form of pluginRows. */
export const pluginsJSON = (rows) => rows.map(({ hookCommands, installPath, ...p }) => p);
