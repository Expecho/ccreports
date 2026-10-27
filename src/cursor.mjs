// Reads Cursor's agent transcripts (~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl),
// written by both the Cursor CLI and the agent in the Cursor editor, and
// returns the same normalized records as loadRecords() in src/loader.mjs.
//
// Cursor keeps token usage on its servers, so these logs have no usage, model
// or cost: Cursor sessions count in activity (prompts, tools, skills, commands,
// adoption) only. Other differences from Claude Code's transcripts:
//   - Lines carry no timestamps; prompts do (in a <timestamp> tag) in recent
//     versions. Every record gets the time of the prompt that started its turn,
//     or the transcript's modification time when the prompt has none.
//   - The project folder name is the working directory with every separator
//     turned into "-"; it is decoded against the folders that exist, or taken
//     from the CLI's own session metadata (~/.cursor/chats/<hash>/<id>/meta.json).
//   - A skill you invoke arrives as a <manually_attached_skills> block in your
//     message; a skill the agent picks itself is a Read of its SKILL.md.
//   - Tools Cursor loads on demand are called through CallDynamicTool; they are
//     counted under their own name (MCP tools as mcp__<server>__<tool>).
//
// The format is undocumented, so every field access is defensive.

import { createReadStream, existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import path from 'node:path';
import { shellCommands } from './shell.mjs';
import { normalizeSkillName } from './loader.mjs';

const EDIT_TOOLS = new Set(['Write', 'Edit', 'StrReplace', 'MultiEdit', 'Delete', 'ApplyPatch', 'EditNotebook']);
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch']);
const AGENT_TOOLS = new Set(['Task', 'Agent']);
// Cursor's Shell tool runs the platform's shell.
const SHELL = process.platform === 'win32' ? 'PowerShell' : 'Bash';
// A skill folder Cursor loads from: .cursor/skills, .cursor/skills-cursor (built in),
// .claude/skills, .agents/skills, ... in a project or the home directory. A
// SKILL.md elsewhere (a plugin's source, say) is read as a file, not used.
const SKILL_FILE = /[\\/]\.[\w-]+[\\/]skills(?:-cursor)?[\\/]([^\\/]+)[\\/]SKILL\.md$/i;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The Cursor config directory, honoring CURSOR_CONFIG_DIR. */
export function defaultCursorDirs() {
  return [process.env.CURSOR_CONFIG_DIR || path.join(homedir(), '.cursor')];
}

/** "Tuesday, Oct 27, 2026, 2:44 PM (UTC+1)" -> ISO timestamp, or null. */
export function parsePromptTime(text) {
  const m = /([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) (AM|PM)(?: \(UTC([+-]\d{1,2})(?::?(\d{2}))?\))?/.exec(
    String(text ?? ''),
  );
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]);
  if (month < 0) return null;
  let hour = Number(m[4]) % 12;
  if (m[6] === 'PM') hour += 12;
  const offset = m[7] ? Number(m[7]) * 60 + Math.sign(Number(m[7]) || 1) * Number(m[8] ?? 0) : 0;
  const utc = Date.UTC(Number(m[3]), month, Number(m[2]), hour, Number(m[5])) - offset * 60_000;
  return new Date(utc).toISOString();
}

/**
 * "Z-Sources-Ibis-Calculeren-Shared" -> "Z:\Sources\Ibis.Calculeren.Shared" when
 * that folder exists: each "-" is a separator, or part of a name (as "-", "."
 * or " "). Falls back to the folder name.
 */
export function decodeProjectDir(name, exists = existsSync) {
  if (name === 'empty-window') return '(no folder)';
  const m = /^([A-Za-z])-(.*)$/.exec(name);
  const [root, rest] = m ? [`${m[1].toUpperCase()}:\\`, m[2]] : ['/', name];
  const sep = m ? '\\' : '/';
  const parts = rest.split('-').filter(Boolean);
  // Depth-first over how the parts join up, checking each folder exists.
  const walk = (dir, i) => {
    if (i === parts.length) return dir;
    for (let j = parts.length; j > i; j--) {
      for (const glue of ['-', '.', ' ']) {
        const seg = parts.slice(i, j).join(glue);
        const next = dir.endsWith(sep) ? dir + seg : dir + sep + seg;
        if (exists(next)) {
          const found = walk(next, j);
          if (found) return found;
        }
        if (j - i === 1) break; // one part: no glue to vary
      }
    }
    return null;
  };
  return walk(root, 0) ?? name;
}

/** CLI sessions: id -> { cwd, title } from ~/.cursor/chats/<hash>/<id>/meta.json. */
async function readCliSessions(root) {
  const out = new Map();
  let hashes;
  try {
    hashes = await readdir(path.join(root, 'chats'));
  } catch {
    return out;
  }
  for (const hash of hashes) {
    let ids;
    try {
      ids = await readdir(path.join(root, 'chats', hash));
    } catch {
      continue;
    }
    for (const id of ids) {
      try {
        const meta = JSON.parse(await readFile(path.join(root, 'chats', hash, id, 'meta.json'), 'utf8'));
        out.set(id, { cwd: meta.cwd ?? null, title: meta.title ?? null });
      } catch {
        out.set(id, { cwd: null, title: null });
      }
    }
  }
  return out;
}

async function listTranscripts(root) {
  const files = [];
  let projects;
  try {
    projects = await readdir(path.join(root, 'projects'), { withFileTypes: true });
  } catch {
    return files;
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = path.join(root, 'projects', p.name, 'agent-transcripts');
    let ids;
    try {
      ids = await readdir(dir);
    } catch {
      continue;
    }
    for (const id of ids) {
      const file = path.join(dir, id, `${id}.jsonl`);
      try {
        files.push({ id, projectDir: p.name, file, mtime: (await stat(file)).mtime.toISOString() });
      } catch {
        // a folder without its transcript
      }
    }
  }
  return files;
}

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');

/** A dynamic tool call counts under the tool it calls. */
function toolName(c) {
  if (c.name !== 'CallDynamicTool' || !c.input?.toolName) return c.name;
  const ns = c.input.namespace;
  return !ns || ns === 'cursor' ? c.input.toolName : `mcp__${ns}__${c.input.toolName}`;
}

export async function loadCursorRecords({ dirs = defaultCursorDirs(), includeSubagents = true } = {}) {
  const tools = [];
  const skills = [];
  const commands = [];
  const events = []; // one per prompt: activity without tokens
  const titles = new Map();
  const sessions = new Map();
  const psNames = new Map();
  const psName = (name) => {
    if (!psNames.has(name.toLowerCase())) psNames.set(name.toLowerCase(), name);
    return psNames.get(name.toLowerCase());
  };
  const decoded = new Map(); // project folder name -> path
  let fileCount = 0;

  for (const root of dirs) {
    const cli = await readCliSessions(root);
    for (const { id, projectDir, file, mtime } of await listTranscripts(root)) {
      fileCount += 1;
      const meta = cli.get(id);
      if (!decoded.has(projectDir)) decoded.set(projectDir, decodeProjectDir(projectDir));
      const project = meta?.cwd || decoded.get(projectDir);
      if (meta?.title) titles.set(id, meta.title);
      const info = {
        entrypoint: meta ? 'cursor-cli' : 'cursor-ide',
        prompts: new Set(),
        prs: new Set(),
        compactions: new Set(),
        modes: new Set(),
      };
      sessions.set(id, info);

      let timestamp = null; // of the current turn's prompt
      let turn = 0;
      let pendingCommand = null; // a /command typed this turn, waiting for its skill read
      const base = () => ({ timestamp: timestamp ?? mtime, sessionId: id, project, agent: null, source: 'cursor' });

      const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of rl) {
        let d;
        try {
          d = JSON.parse(line);
        } catch {
          continue;
        }
        const content = d.message?.content;

        if (d.role === 'user') {
          const text = textOf(content);
          const query = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text);
          if (!query) continue; // not something the user typed
          turn += 1;
          timestamp = parsePromptTime(/<timestamp>([^<]+)<\/timestamp>/.exec(text)?.[1]) ?? timestamp;
          info.prompts.add(turn);
          events.push(base());
          pendingCommand = null;
          const cmd = /^\/([\w:.-]+)/.exec(query[1]);
          if (cmd) {
            const name = '/' + normalizeSkillName(cmd[1]);
            commands.push({ ...base(), name });
            pendingCommand = name;
          }
          // Skills the user attached (typed as /name or picked in the editor).
          const attached = /<manually_attached_skills>([\s\S]*?)<\/manually_attached_skills>/.exec(text)?.[1] ?? '';
          for (const m of attached.matchAll(/^Skill Name:\s*(.+?)\s*$/gm)) {
            skills.push({ ...base(), name: normalizeSkillName(m[1]), source: 'user' });
            pendingCommand = null; // its content is attached: no read follows
          }
          continue;
        }

        if (d.role !== 'assistant') continue;
        for (const c of Array.isArray(content) ? content : []) {
          if (c?.type !== 'tool_use' || !c.name) continue;
          const name = toolName(c);
          const input = (c.name === 'CallDynamicTool' ? c.input?.arguments : c.input) ?? {};
          const tool = { ...base(), name };
          if (AGENT_TOOLS.has(name)) {
            if (!includeSubagents) continue;
            tool.subagentType = input.subagent_type || input.subagentType || 'general-purpose';
            if (input.run_in_background || input.background) tool.background = true;
          }
          if (EDIT_TOOLS.has(name)) tool.edit = true;
          if (WEB_TOOLS.has(name)) tool.web = true;
          if (name === 'Shell' && typeof input.command === 'string') {
            const names = shellCommands(input.command, SHELL);
            tool.shellCommands = SHELL === 'PowerShell' ? names.map(psName) : names;
          }
          if (name === 'SwitchMode' && input.target_mode_id) info.modes.add(input.target_mode_id);
          if (name === 'CreatePlan') info.modes.add('plan');
          tools.push(tool);
          // The agent loads a skill by reading its SKILL.md.
          const skill = name === 'Read' && SKILL_FILE.exec(String(input.path ?? ''))?.[1];
          if (skill) {
            const byUser = pendingCommand === `/${skill}`;
            skills.push({ ...base(), name: normalizeSkillName(skill), source: byUser ? 'user' : 'model' });
            if (byUser) pendingCommand = null;
          }
        }
      }
    }
  }

  return {
    sessions,
    charsPerToken: null,
    files: fileCount,
    usage: [],
    tools,
    skills,
    commands,
    hooks: [],
    events,
    titles,
  };
}
