// Reads the Cursor editor's own database (<user dir>/globalStorage/state.vscdb),
// which keeps chats the agent transcripts don't have (those from before Cursor
// wrote transcripts) and, for every chat, the model you picked and its mode.
//
// The database is SQLite, read with node:sqlite (Node 22.13+). On older Node it
// is skipped. Only metadata is read: per chat its mode, chosen model, title and
// workspace; per message its type, time and the name and command of a tool call.
// Chat text and tool results are never read out. Token counts are left out:
// Cursor fills them in for too few messages to add up.
//
// The format is undocumented, so every field access is defensive.

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Cursor's user data directory (with globalStorage/ and workspaceStorage/), honoring CURSOR_USER_DIR. */
export function defaultCursorUserDirs() {
  if (process.env.CURSOR_USER_DIR) return [process.env.CURSOR_USER_DIR];
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  return [path.join(base, 'Cursor', 'User')];
}

let sqlite; // the node:sqlite module, null when unavailable
/** node:sqlite without its ExperimentalWarning, or null on Node versions without it. */
export async function loadSqlite() {
  if (sqlite !== undefined) return sqlite;
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...args) => {
    const type = typeof args[0] === 'string' ? args[0] : args[0]?.type;
    if (type === 'ExperimentalWarning' && /SQLite/i.test(String(warning?.message ?? warning))) return;
    return emit.call(process, warning, ...args);
  };
  try {
    sqlite = await import('node:sqlite');
  } catch {
    sqlite = null;
  } finally {
    process.emitWarning = emit;
  }
  return sqlite;
}

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

function open(file) {
  if (!existsSync(file)) return null;
  try {
    return new sqlite.DatabaseSync(file, { readOnly: true });
  } catch {
    return null; // locked or not a database
  }
}

/** "file:///z%3A/Sources/App" -> "z:\Sources\App" (a path on this platform). */
function folderPath(uri) {
  try {
    const p = fileURLToPath(uri);
    return /^[a-z]:/.test(p) ? p[0].toUpperCase() + p.slice(1) : p;
  } catch {
    return null;
  }
}

/** composerId -> project folder, from each workspace's own state.vscdb. */
async function workspaceProjects(userDir) {
  const out = new Map();
  const root = path.join(userDir, 'workspaceStorage');
  let dirs;
  try {
    dirs = await readdir(root);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    const workspace = parse(await readFile(path.join(root, dir, 'workspace.json'), 'utf8').catch(() => ''));
    const project = workspace?.folder ? folderPath(workspace.folder) : '(no folder)';
    const db = open(path.join(root, dir, 'state.vscdb'));
    if (!db) continue;
    try {
      const row = db.prepare("select value from ItemTable where key = 'composer.composerData'").get();
      for (const c of parse(row?.value)?.allComposers ?? []) if (c?.composerId) out.set(c.composerId, project);
    } catch {
      // no ItemTable
    } finally {
      db.close();
    }
  }
  return out;
}

/**
 * Chats in Cursor's database: composerId -> { title, mode, model, project,
 * messages: [{ type: 'user' | 'assistant', timestamp, tool?: { name, command? } }] },
 * or null when node:sqlite is unavailable. Missing databases give an empty map.
 */
export async function readCursorState(userDirs) {
  if (!userDirs.length) return new Map();
  if (!(await loadSqlite())) return null;
  const chats = new Map();
  for (const userDir of userDirs) {
    const db = open(path.join(userDir, 'globalStorage', 'state.vscdb'));
    if (!db) continue;
    const projects = await workspaceProjects(userDir);
    try {
      const rows = (prefix) => db.prepare('select key, value from cursorDiskKV where key like ?').all(`${prefix}%`);
      for (const { key, value } of rows('composerData:')) {
        const c = parse(value);
        const id = key.slice('composerData:'.length);
        if (!c) continue;
        chats.set(id, {
          title: c.name || null,
          mode: c.unifiedMode ?? null, // agent, chat (Ask), plan, ...
          model: c.modelConfig?.modelName ?? null, // "default" is Auto
          project: projects.get(id) ?? null,
          createdAt: typeof c.createdAt === 'number' ? new Date(c.createdAt).toISOString() : null,
          order: (c.fullConversationHeadersOnly ?? []).map((h) => h?.bubbleId),
          messages: new Map(),
        });
      }
      // Messages are stored as bubbleId:<composerId>:<bubbleId>.
      const select = db.prepare(
        `select key, json_extract(value, '$.type') type, json_extract(value, '$.createdAt') createdAt,
                json_extract(value, '$.toolFormerData.name') tool, json_extract(value, '$.toolFormerData.rawArgs') args
         from cursorDiskKV where key like 'bubbleId:%'`,
      );
      for (const r of select.all()) {
        const [, composerId, bubbleId] = String(r.key).split(':');
        const chat = chats.get(composerId);
        if (!chat || (r.type !== 1 && r.type !== 2)) continue;
        const message = { type: r.type === 1 ? 'user' : 'assistant', timestamp: r.createdAt ?? null };
        if (r.tool) {
          message.tool = { name: r.tool };
          const command = parse(r.args)?.command;
          if (typeof command === 'string') message.tool.command = command;
        }
        chat.messages.set(bubbleId, message);
      }
    } catch {
      // not the table layout this reader knows
    } finally {
      db.close();
    }
  }
  // Messages in conversation order; the ones not in the order list after, by time.
  for (const chat of chats.values()) {
    const ordered = chat.order.filter((id) => chat.messages.has(id)).map((id) => chat.messages.get(id));
    const listed = new Set(chat.order);
    const rest = [...chat.messages].filter(([id]) => !listed.has(id)).map(([, m]) => m);
    rest.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    chat.messages = [...ordered, ...rest];
    delete chat.order;
  }
  return chats;
}
