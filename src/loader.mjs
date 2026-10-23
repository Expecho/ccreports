// Reads Claude Code session transcripts (~/.claude/projects/**/*.jsonl) and
// extracts normalized usage, tool, skill and slash-command records.
//
// The transcript format is undocumented and changes between versions, so every
// field access here is defensive: unknown line types are ignored, missing fields
// fall back to sensible defaults.

import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import path from 'node:path';
import { FileAttribution, createCalibration, charsPerToken, resolveTokens } from './attribution.mjs';
import { SHELL_TOOLS, shellCommands } from './shell.mjs';

const SKILL_CONTENT_PREFIX = 'Base directory for this skill';
const COMMAND_RE = /<command-name>([^<]+)<\/command-name>/;
// "Task" is the tool's name in older Claude Code versions.
const AGENT_TOOLS = new Set(['Agent', 'Task']);

async function readAgentType(transcript) {
  try {
    const meta = JSON.parse(await readFile(transcript.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    return meta.agentType || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Directories that may hold a `projects` folder, honoring CLAUDE_CONFIG_DIR (comma-separated). */
export function defaultProjectDirs() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  const roots = env
    ? env.split(',').map((s) => s.trim()).filter(Boolean)
    : [path.join(homedir(), '.config', 'claude'), path.join(homedir(), '.claude')];
  return roots.map((root) => path.join(root, 'projects'));
}

/**
 * Skill names can carry a directory scope, e.g.
 * ".claude/worktrees/feature-x:execute-plan" -> "execute-plan".
 * Plugin prefixes ("anthropic-skills:docs") are kept.
 */
export function normalizeSkillName(name) {
  const n = String(name ?? '').trim().replace(/^\//, '');
  const i = n.lastIndexOf(':');
  if (i > 0 && /[\\/]/.test(n.slice(0, i))) return n.slice(i + 1);
  return n;
}

async function listTranscripts(dirs, { includeSubagents }) {
  const files = [];
  for (const dir of dirs) {
    try {
      if (!(await stat(dir)).isDirectory()) continue;
    } catch {
      continue;
    }
    const entries = await readdir(dir, { recursive: true });
    for (const rel of entries) {
      if (!rel.endsWith('.jsonl')) continue;
      const isSubagent = rel.split(/[\\/]/).includes('subagents');
      if (isSubagent && !includeSubagents) continue;
      files.push({ file: path.join(dir, rel), projectDir: rel.split(/[\\/]/)[0], isSubagent });
    }
  }
  return files;
}

/** The most telling line of a failed hook's stderr, e.g. "Error: Cannot find module '…'". */
export function errorLine(stderr) {
  const lines = String(stderr ?? '')
    .replace(/^Failed with non-blocking status code:\s*/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines.find((l) => /error|not found|no such file|cannot|denied/i.test(l)) ?? lines[0] ?? '';
  return line.length > 160 ? line.slice(0, 159) + '…' : line;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

/**
 * Load all records. Records are deduplicated globally because resumed and
 * forked sessions copy earlier history into new files, and one API response is
 * written as several lines (one per content block) sharing the same usage.
 */
export async function loadRecords({ dirs = defaultProjectDirs(), includeSubagents = true } = {}) {
  const usage = new Map(); // `${message.id}:${requestId}` -> record
  const tools = new Map(); // tool_use id -> record
  const skills = new Map(); // tool_use id | user-message uuid -> record
  const commands = new Map(); // user-message uuid -> record
  const hooks = new Map(); // attachment uuid -> record
  const titles = new Map(); // sessionId -> ai title
  // sessionId -> { entrypoint, prompts: Set<uuid>, prs: Set<url>, compactions: Set<uuid> } (adoption / recommendations)
  const sessions = new Map();
  const sessionInfo = (id) => {
    if (!sessions.has(id)) sessions.set(id, { entrypoint: null, prompts: new Set(), prs: new Set(), compactions: new Set() });
    return sessions.get(id);
  };
  const sessionStart = new Map(); // sessionId -> { rank, timestamp, cwd } of its earliest record
  // PowerShell commands are case-insensitive: one name per command, the first spelling seen.
  const psNames = new Map(); // lower-cased name -> spelling
  const psName = (name) => {
    if (!psNames.has(name.toLowerCase())) psNames.set(name.toLowerCase(), name);
    return psNames.get(name.toLowerCase());
  };
  const calibration = createCalibration();
  const attributed = []; // token-attribution items from every file

  const files = await listTranscripts(dirs, { includeSubagents });

  for (const { file, projectDir, isSubagent } of files) {
    let pendingCommand = null;
    const hookRuns = new Map(); // attachment uuid | `event:${event}` -> hook run in this file, for its context line
    // Records from a subagent transcript are tagged with its agent type
    // (from the sibling .meta.json); main-session records get null.
    const agent = isSubagent ? await readAgentType(file) : null;
    const attribution = new FileAttribution(calibration);
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });

    for await (const line of rl) {
      // Cheap prefilter: skip the (often large) line types we never use.
      if (
        !line.includes('"type":"assistant"') &&
        !line.includes('"type":"user"') &&
        !line.includes('"type":"ai-title"') &&
        !line.includes('"type":"pr-link"') &&
        !line.includes('"subtype":"compact_boundary"') &&
        !line.includes('"type":"hook_')
      ) {
        continue;
      }
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }

      if (d.type === 'ai-title') {
        if (d.sessionId && d.aiTitle) titles.set(d.sessionId, d.aiTitle);
        continue;
      }
      if (d.type === 'pr-link') {
        if (d.sessionId && d.prUrl) sessionInfo(d.sessionId).prs.add(d.prUrl);
        continue;
      }
      if (d.type === 'system') {
        if (d.subtype === 'compact_boundary') {
          attribution.compact();
          if (!agent && d.sessionId) sessionInfo(d.sessionId).compactions.add(d.uuid ?? d.timestamp);
        }
        continue;
      }

      const base = {
        timestamp: d.timestamp,
        sessionId: d.sessionId ?? d.session_id ?? path.basename(file, '.jsonl'),
        project: d.cwd || projectDir,
        agent,
      };
      if (!base.timestamp) continue;
      // A session's project is where it started: later records follow Claude into
      // subfolders (and subagents into worktrees), which would split one session
      // over several projects.
      if (d.cwd) {
        const start = sessionStart.get(base.sessionId);
        const rank = agent ? 1 : 0; // the main conversation's own records win
        if (!start || rank < start.rank || (rank === start.rank && base.timestamp < start.timestamp)) {
          sessionStart.set(base.sessionId, { rank, timestamp: base.timestamp, cwd: d.cwd });
        }
      }

      if (d.type === 'attachment') {
        const a = d.attachment;
        if (!a?.type?.startsWith('hook_')) continue;
        const event = a.hookEvent || String(a.hookName ?? '').split(':')[0] || 'unknown';
        if (a.type === 'hook_additional_context') {
          // Context a hook returned arrives as its own line after the run.
          const chars = (Array.isArray(a.content) ? a.content.join('\n') : String(a.content ?? '')).length;
          const run = hookRuns.get(d.parentUuid) ?? hookRuns.get(`event:${event}`);
          if (run) run.contextChars += chars;
          else hooks.set(d.uuid ?? `${file}:${base.timestamp}:${event}`, { ...base, event, command: a.hookName ?? event, outcome: 'context', run: false, durationMs: 0, contextChars: chars });
          continue;
        }
        const outcome = a.type.slice('hook_'.length); // success, non_blocking_error, blocking_error, ...
        const hook = {
          ...base,
          event,
          command: a.command || a.hookName || event,
          outcome,
          run: true,
          durationMs: a.durationMs ?? 0,
          // A blocking hook's stderr is fed back to the model.
          contextChars: outcome === 'blocking_error' ? String(a.stderr ?? '').length : 0,
        };
        if (outcome.endsWith('error')) hook.error = errorLine(a.stderr);
        hooks.set(d.uuid ?? `${file}:${base.timestamp}:${event}:${hook.command}`, hook);
        if (d.uuid) hookRuns.set(d.uuid, hook);
        hookRuns.set(`event:${event}`, hook);
        continue;
      }

      if (d.type === 'assistant') {
        const m = d.message ?? {};
        const u = m.usage;
        const key = m.id ? `${m.id}:${d.requestId ?? ''}` : d.uuid;
        if (u && m.model !== '<synthetic>') {
          const cacheCreation = u.cache_creation_input_tokens ?? 0;
          attribution.response(key, {
            context: (u.input_tokens ?? 0) + cacheCreation + (u.cache_read_input_tokens ?? 0),
            output: u.output_tokens ?? 0,
            model: m.model ?? 'unknown',
            cache1hShare: cacheCreation ? (u.cache_creation?.ephemeral_1h_input_tokens ?? 0) / cacheCreation : 0,
          });
          // Later lines of the same response carry the final usage, so overwrite.
          usage.set(key, {
            ...base,
            model: m.model ?? 'unknown',
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
            cacheCreation1hTokens: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
            // Price modifiers.
            speed: u.speed,
            inferenceGeo: u.inference_geo,
            webSearchRequests: u.server_tool_use?.web_search_requests ?? 0,
          });
        }
        for (const c of Array.isArray(m.content) ? m.content : []) {
          if (!c || (c.type !== 'tool_use' && c.type !== 'server_tool_use') || !c.name) continue;
          const id = c.id ?? `${d.uuid}:${c.name}`;
          const tool = { ...base, name: c.name };
          if (AGENT_TOOLS.has(c.name)) {
            tool.subagentType = c.input?.subagent_type || 'general-purpose';
            if (c.input?.run_in_background) tool.background = true;
          }
          if (c.input?.isolation === 'worktree' || c.name === 'EnterWorktree') tool.worktree = true;
          if (SHELL_TOOLS.has(c.name) && typeof c.input?.command === 'string') {
            const names = shellCommands(c.input.command, c.name);
            tool.shellCommands = c.name === 'PowerShell' ? names.map(psName) : names;
          }
          tools.set(id, tool);
          attribution.toolUse(key, id, JSON.stringify(c.input ?? {}).length, c.name === 'Skill');
          if (c.name === 'Skill' && c.input?.skill) {
            skills.set(id, { ...base, name: normalizeSkillName(c.input.skill), source: 'model' });
          }
        }
        continue;
      }

      // type === 'user'
      const content = d.message?.content;
      const text = textOf(content);
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type === 'tool_result') attribution.toolResult(block.tool_use_id, textOf(block.content).length);
      }
      const isSkillContent = text.startsWith(SKILL_CONTENT_PREFIX);
      if (pendingCommand) {
        // A slash command that maps to a skill is followed by the skill's content.
        if (isSkillContent) {
          const id = d.uuid ?? `${pendingCommand.id}:skill`;
          skills.set(id, { ...base, name: normalizeSkillName(pendingCommand.name), source: 'user' });
          attribution.skillContent(text.length, id);
        }
        pendingCommand = null;
      } else if (isSkillContent) {
        attribution.skillContent(text.length); // loaded by a Skill tool call
      }
      // Text from the user (not tool results, skill content or injected meta) ends a tool loop.
      if (text && !isSkillContent && !d.isMeta) {
        attribution.human();
        // Prompts a person sent - not agent-to-agent or task notifications, not subagent tasks.
        const origin = d.origin?.kind ?? 'human';
        if (!agent && !d.isSidechain && origin === 'human' && d.promptSource !== 'system') {
          sessionInfo(base.sessionId).prompts.add(d.uuid ?? `${file}:${base.timestamp}`);
        }
      }
      if (!agent && d.entrypoint) sessionInfo(base.sessionId).entrypoint ??= d.entrypoint;
      const match = COMMAND_RE.exec(text);
      if (match) {
        const name = '/' + normalizeSkillName(match[1]);
        const id = d.uuid ?? `${file}:${base.timestamp}`;
        commands.set(id, { ...base, name });
        pendingCommand = { id, name };
      }
    }
    attributed.push(...attribution.finish());
  }

  for (const map of [usage, tools, skills, commands, hooks]) {
    for (const rec of map.values()) rec.project = sessionStart.get(rec.sessionId)?.cwd ?? rec.project;
  }

  // Resumed sessions repeat earlier history in a new file; per record keep the
  // copy that saw the most later requests.
  resolveTokens(attributed, charsPerToken(calibration));
  const best = new Map();
  for (const item of attributed) {
    if (!best.has(item.id) || item.tokens.total > best.get(item.id).tokens.total) best.set(item.id, item);
  }
  for (const [id, item] of best) {
    const record = tools.get(id) ?? skills.get(id);
    if (record) record.tokens = item.tokens;
    if (tools.has(id) && skills.has(id)) skills.get(id).tokens = item.tokens; // model-invoked skill = its Skill call
  }

  // Hook context is counted once as it enters the context (no re-reads).
  const cpt = charsPerToken(calibration);
  for (const h of hooks.values()) h.contextTokens = Math.round(h.contextChars / cpt);

  return {
    sessions,
    charsPerToken: cpt,
    files: files.length,
    usage: [...usage.values()],
    tools: [...tools.values()],
    skills: [...skills.values()],
    commands: [...commands.values()],
    hooks: [...hooks.values()],
    titles,
  };
}
