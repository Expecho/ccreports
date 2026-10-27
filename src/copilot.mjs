// Reads GitHub Copilot CLI session logs (~/.copilot/session-state/<id>/events.jsonl,
// also written by VS Code's Copilot agent) and returns the same normalized
// records as loadRecords() in src/loader.mjs, so every report works on them.
//
// Differences from Claude Code's transcripts that shape this loader:
//   - Token usage is logged per request (session.usage_record) only by recent
//     versions; older sessions only have per-model totals per run in
//     session.shutdown. Those become one record per run, agent and model, with
//     `requests` set and `aggregated` true (they carry no per-request context).
//     Sessions that never shut down cleanly have no token counts at all.
//   - Copilot's inputTokens include cache reads and writes; Claude's don't.
//   - Billing is in AI credits (nano-AIU; 1 AIU = $0.01) and premium requests.
//     A record's costUSD is its AI credits when any were billed; otherwise the
//     report prices it like a Claude Code request.
//
// The format is undocumented, so every field access is defensive.

import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import path from 'node:path';
import { FileAttribution, createCalibration, charsPerToken, resolveTokens } from './attribution.mjs';
import { shellCommands } from './shell.mjs';
import { errorLine, normalizeSkillName } from './loader.mjs';

const NANO_AIU_PER_USD = 1e11;
const SHELLS = { powershell: 'PowerShell', bash: 'Bash' };
const EDIT_TOOLS = new Set(['edit', 'create', 'apply_patch', 'write', 'str_replace_editor']);
const WEB_TOOLS = new Set(['web_search', 'web_fetch']);
const AGENT_TOOLS = new Set(['task']);
// Copilot logs no PR links of its own: PRs are found in the results of the calls that create them.
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
const createsPr = (raw, data, args) =>
  /create_pull_request/.test(data.mcpToolName ?? raw) || (SHELLS[raw] && /\bgh\s+pr\s+create\b/.test(String(args.command ?? '')));

/** Directories holding Copilot sessions, honoring COPILOT_HOME. */
export function defaultCopilotDirs() {
  const root = process.env.COPILOT_HOME || path.join(homedir(), '.copilot');
  return [path.join(root, 'session-state')];
}

async function listSessions(dirs) {
  const sessions = [];
  for (const dir of dirs) {
    let entries;
    try {
      if (!(await stat(dir)).isDirectory()) continue;
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const file = path.join(dir, e.name, 'events.jsonl');
      try {
        await stat(file);
      } catch {
        continue;
      }
      sessions.push({ id: e.name, dir: path.join(dir, e.name), file });
    }
  }
  return sessions;
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** The `name:` line of workspace.yaml: the session's title. */
async function readTitle(dir) {
  try {
    const yaml = await readFile(path.join(dir, 'workspace.yaml'), 'utf8');
    const m = /^name:\s*(.+)$/m.exec(yaml);
    return m ? m[1].trim().replace(/^(['"])(.*)\1$/, '$2') : null;
  } catch {
    return null;
  }
}

/** Copilot token counts -> ccreports' (input without cached tokens). */
function tokens(u) {
  const cacheRead = u?.cacheReadTokens ?? 0;
  const cacheWrite = u?.cacheWriteTokens ?? 0;
  return {
    inputTokens: Math.max(0, (u?.inputTokens ?? 0) - cacheRead - cacheWrite),
    outputTokens: u?.outputTokens ?? 0,
    cacheCreationTokens: cacheWrite,
    cacheCreation1hTokens: 0,
    cacheReadTokens: cacheRead,
  };
}

const usd = (nanoAiu) => (nanoAiu > 0 ? nanoAiu / NANO_AIU_PER_USD : undefined);

const textLength = (result) =>
  typeof result === 'string' ? result.length : String(result?.content ?? result?.detailedContent ?? '').length;

/** "postToolUse" -> "PostToolUse", like Claude Code's hook events. */
const hookEvent = (type) => (type ? type[0].toUpperCase() + type.slice(1) : 'unknown');

export async function loadCopilotRecords({ dirs = defaultCopilotDirs(), includeSubagents = true } = {}) {
  const usage = [];
  const tools = new Map(); // toolCallId -> record
  const skills = new Map();
  const commands = new Map();
  const hooks = new Map();
  const titles = new Map();
  const sessions = new Map();
  const psNames = new Map();
  const psName = (name) => {
    if (!psNames.has(name.toLowerCase())) psNames.set(name.toLowerCase(), name);
    return psNames.get(name.toLowerCase());
  };
  const calibration = createCalibration();
  const attributed = []; // per session: { items, inputTokens } (inputTokens: all input incl. cache, null when unknown)

  const list = await listSessions(dirs);

  for (const { id, dir, file } of list) {
    const title = await readTitle(dir);
    if (title) titles.set(id, title);
    const info = {
      entrypoint: (await exists(path.join(dir, 'vscode.metadata.json'))) ? 'copilot-vscode' : 'copilot-cli',
      prompts: new Set(),
      prs: new Set(),
      compactions: new Set(),
      modes: new Set(), // interactive, plan, autopilot
    };
    sessions.set(id, info);

    let project = null;
    const agentTypes = new Map(); // agentId -> subagent type
    const attributions = new Map(); // agentId | '' -> FileAttribution (each agent has its own context)
    const attributionOf = (agentId) => {
      const key = agentId ?? '';
      if (!attributions.has(key)) attributions.set(key, new FileAttribution(calibration));
      return attributions.get(key);
    };
    const contexts = new Map(); // apiCallId -> context of that request (usage_record precedes the message)
    const hookRuns = new Map(); // hookInvocationId -> start event
    const prCalls = new Set(); // toolCallIds of calls that create a pull request
    const requests = []; // per-request usage records of this session
    const runs = []; // session.shutdown events
    let compactedBefore = false;
    let pendingCommand = null;
    let pendingSkillCall = null; // a `skill` tool call waiting for its skill.invoked

    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      // The large model.* and system.message events are never used.
      if (line.startsWith('{"type":"model.') || line.startsWith('{"type":"system.message"')) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const data = d.data ?? {};
      if (!d.timestamp) continue;
      const agent = d.agentId ? agentTypes.get(d.agentId) ?? 'unknown' : null;
      if (agent && !includeSubagents) continue;
      const base = () => ({ timestamp: d.timestamp, sessionId: id, project: project ?? dir, agent, source: 'copilot' });

      switch (d.type) {
        case 'session.start':
        case 'session.resume':
          project ??= data.context?.cwd ?? null;
          break;

        case 'session.mode_changed':
          if (data.newMode) info.modes.add(data.newMode);
          break;

        case 'subagent.started':
          if (d.agentId) agentTypes.set(d.agentId, data.agentType || data.agentName || 'general-purpose');
          break;

        case 'session.compaction_complete':
          if (data.success === false) break;
          attributionOf(d.agentId).compact();
          if (!d.agentId) {
            info.compactions.add(d.id ?? d.timestamp);
            compactedBefore = true;
          }
          break;

        case 'session.usage_record': {
          const u = data.usage ?? {};
          const t = tokens(u);
          if (u.apiCallId) contexts.set(u.apiCallId, t.inputTokens + t.cacheCreationTokens + t.cacheReadTokens);
          requests.push({
            ...base(),
            key: u.apiCallId ?? d.id,
            model: u.model ?? 'unknown',
            ...t,
            premiumRequests: u.cost ?? 0,
            costUSD: usd(u.copilotUsage?.totalNanoAiu),
            afterCompaction: compactedBefore,
          });
          compactedBefore = false;
          break;
        }

        case 'session.shutdown':
          runs.push(d);
          break;

        case 'assistant.message': {
          const key = data.messageId ?? d.id;
          const att = attributionOf(d.agentId);
          att.response(key, {
            context: contexts.get(data.apiCallId) ?? NaN,
            output: data.outputTokens ?? 0,
            model: data.model ?? 'unknown',
            cache1hShare: 0,
          });
          for (const r of Array.isArray(data.toolRequests) ? data.toolRequests : []) {
            if (r?.toolCallId) att.toolUse(key, r.toolCallId, JSON.stringify(r.arguments ?? {}).length, r.name === 'skill');
          }
          break;
        }

        case 'tool.execution_start': {
          const raw = data.toolName;
          if (!raw) break;
          const name = data.mcpServerName
            ? `mcp__${data.mcpServerName}__${data.mcpToolName ?? raw.replace(`${data.mcpServerName}-`, '')}`
            : raw;
          const tool = { ...base(), name };
          const args = data.arguments ?? {};
          if (AGENT_TOOLS.has(raw)) {
            tool.subagentType = args.agent_type || 'general-purpose';
            if (args.mode === 'background') tool.background = true;
          }
          if (EDIT_TOOLS.has(raw)) tool.edit = true;
          if (WEB_TOOLS.has(raw) || WEB_TOOLS.has(data.mcpToolName)) tool.web = true;
          if (SHELLS[raw] && typeof args.command === 'string') {
            const names = shellCommands(args.command, SHELLS[raw]);
            tool.shellCommands = SHELLS[raw] === 'PowerShell' ? names.map(psName) : names;
          }
          tools.set(data.toolCallId ?? d.id, tool);
          if (!d.agentId && createsPr(raw, data, args)) prCalls.add(data.toolCallId);
          if (raw === 'skill') pendingSkillCall = { id: data.toolCallId ?? d.id, agentId: d.agentId };
          break;
        }

        case 'tool.execution_complete': {
          if (data.toolCallId) attributionOf(d.agentId).toolResult(data.toolCallId, textLength(data.result));
          const url = prCalls.has(data.toolCallId) && data.success !== false && PR_URL.exec(JSON.stringify(data.result ?? ''));
          if (url) info.prs.add(url[0]);
          break;
        }

        case 'skill.invoked': {
          const name = normalizeSkillName(data.name);
          const att = attributionOf(d.agentId);
          const chars = String(data.content ?? '').length;
          const byUser =
            data.trigger === 'user-invoked' ||
            (data.trigger == null && pendingCommand?.name === `/${name}`);
          if (byUser) {
            const skillId = d.id ?? `${id}:${d.timestamp}:${name}`;
            skills.set(skillId, { ...base(), name, source: 'user' });
            att.skillContent(chars, skillId);
          } else {
            // Model-invoked: the record shares the id of its `skill` tool call, and so its tokens.
            const skillId = pendingSkillCall?.id ?? d.id;
            skills.set(skillId, { ...base(), name, source: 'model' });
            att.skillContent(chars);
          }
          pendingCommand = null;
          pendingSkillCall = null;
          break;
        }

        case 'user.message': {
          if (d.agentId) break; // a subagent's task
          if (data.agentMode) info.modes.add(data.agentMode);
          const src = data.source;
          if (src != null && src !== 'user') break; // skill content, instructions, memory
          const content = String(data.content ?? '');
          attributionOf(null).human();
          info.prompts.add(d.id ?? d.timestamp);
          const m = /^\/([\w:.-]+)/.exec(content.trim());
          pendingCommand = null;
          if (m) {
            const name = '/' + normalizeSkillName(m[1]);
            commands.set(d.id ?? `${id}:${d.timestamp}`, { ...base(), name });
            pendingCommand = { name };
          }
          break;
        }

        case 'hook.start':
          if (data.hookInvocationId) hookRuns.set(data.hookInvocationId, d);
          break;

        case 'hook.end': {
          const start = hookRuns.get(data.hookInvocationId);
          const event = hookEvent(data.hookType ?? start?.data?.hookType);
          const message = data.error?.message ?? '';
          // A hook that errors denies the tool call too, but it failed: only a
          // deliberate denial counts as blocking.
          const denied = JSON.stringify(data.output ?? '').includes('Denied');
          const outcome = data.success !== false ? 'success' : denied && !data.error ? 'blocking_error' : 'non_blocking_error';
          const hook = {
            ...base(),
            event,
            command: event,
            outcome,
            run: true,
            durationMs: start ? Math.max(0, Date.parse(d.timestamp) - Date.parse(start.timestamp)) : 0,
            contextChars: outcome === 'blocking_error' ? message.length : 0,
          };
          if (outcome.endsWith('error')) hook.error = errorLine(message.replace(/^Error:\s*Hook command failed[^\n]*\n(Stderr:\s*)?/, ''));
          hooks.set(data.hookInvocationId ?? d.id, hook);
          break;
        }
      }
    }

    // A session's project is where it started.
    if (project) {
      for (const map of [tools, skills, commands, hooks]) {
        for (const rec of map.values()) if (rec.sessionId === id) rec.project = project;
      }
    }

    const sessionUsageStart = usage.length;
    if (requests.length) {
      for (const { key, ...r } of requests) usage.push({ ...r, project: project ?? r.project });
    } else {
      // Per run, agent and model totals from each shutdown (each run counts from zero).
      for (const run of runs) {
        const data = run.data ?? {};
        const byAgent = data.agentMetrics ?? { main: { modelMetrics: data.modelMetrics } };
        for (const [agentId, metrics] of Object.entries(byAgent)) {
          const agent = agentId === 'main' ? null : metrics.agentName || agentTypes.get(agentId) || 'unknown';
          if (agent && !includeSubagents) continue;
          for (const [model, m] of Object.entries(metrics.modelMetrics ?? {})) {
            const count = m.requests?.count ?? 0;
            if (!count) continue;
            usage.push({
              timestamp: run.timestamp,
              sessionId: id,
              project: project ?? dir,
              agent,
              source: 'copilot',
              model,
              ...tokens(m.usage),
              requests: count,
              aggregated: true,
              premiumRequests: m.requests?.cost ?? 0,
              costUSD: usd(m.totalNanoAiu),
            });
          }
        }
      }
    }

    const own = usage.slice(sessionUsageStart);
    attributed.push({
      items: [...attributions.values()].flatMap((att) => att.finish()),
      inputTokens: own.length ? own.reduce((s, r) => s + r.inputTokens + r.cacheCreationTokens + r.cacheReadTokens, 0) : null,
      totalTokens: own.reduce((s, r) => s + r.inputTokens + r.outputTokens + r.cacheCreationTokens + r.cacheReadTokens, 0),
      // Billed cost, when every request of the session was billed in AI credits.
      costUSD: own.length && own.every((r) => r.costUSD != null) ? own.reduce((s, r) => s + r.costUSD, 0) : null,
    });
  }

  const cpt = charsPerToken(calibration);
  resolveTokens(attributed.flatMap((a) => a.items), cpt);
  for (const { items, inputTokens, totalTokens, costUSD } of attributed) {
    // Without the session's token counts the estimates have nothing to answer to.
    if (inputTokens == null) continue;
    // Few requests are measured, and Copilot trims old tool output from the
    // context, so the estimates can exceed what the session sent: scale them
    // down to at most its input.
    const estimated = items.reduce((s, i) => s + i.tokens.cacheWriteTokens + i.tokens.cacheReadTokens, 0);
    const f = estimated > inputTokens ? inputTokens / estimated : 1;
    for (const item of items) {
      const t = item.tokens;
      t.cacheWriteTokens = Math.round(t.cacheWriteTokens * f);
      t.cacheReadTokens = Math.round(t.cacheReadTokens * f);
      t.total = t.outputTokens + t.cacheWriteTokens + t.cacheReadTokens;
      // A share of what the session was billed, by tokens (else priced like Claude Code's).
      if (costUSD != null && totalTokens) t.costUSD = (costUSD * t.total) / totalTokens;
      const record = tools.get(item.id) ?? skills.get(item.id);
      if (record) record.tokens = t;
      if (tools.has(item.id) && skills.has(item.id)) skills.get(item.id).tokens = t;
    }
  }
  for (const h of hooks.values()) h.contextTokens = Math.round(h.contextChars / cpt);

  return {
    sessions,
    charsPerToken: cpt,
    files: list.length,
    usage,
    tools: [...tools.values()],
    skills: [...skills.values()],
    commands: [...commands.values()],
    hooks: [...hooks.values()],
    titles,
  };
}

/** Combines the records of several sources into one data set. */
export function mergeData(...parts) {
  const [first, ...rest] = parts;
  const out = {
    ...first,
    sessions: new Map(first.sessions),
    titles: new Map(first.titles),
    usage: [...first.usage],
    tools: [...first.tools],
    skills: [...first.skills],
    commands: [...first.commands],
    hooks: [...first.hooks],
  };
  for (const p of rest) {
    out.files += p.files;
    for (const k of ['usage', 'tools', 'skills', 'commands', 'hooks']) out[k].push(...p[k]);
    for (const [k, v] of p.sessions) out.sessions.set(k, v);
    for (const [k, v] of p.titles) out.titles.set(k, v);
  }
  return out;
}
