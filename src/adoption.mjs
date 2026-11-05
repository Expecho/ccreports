// Adoption assessment, modelled on GitHub Copilot's adoption cohorts: every
// session is placed in a phase by how it used Claude Code, and the phases are
// compared on PRs, tokens and cost. Built as a report document (src/report.mjs).

import { aggregate } from './aggregate.mjs';
import { money, share, average, sessionName } from './report.mjs';
import { INTENTS, classifyIntent, fileKind } from './intent.mjs';

export const PHASES = [
  { key: 'chat', title: 'Chat', description: 'Questions and exploration, no code changes' },
  { key: 'assisted', title: 'Phase 1 · Assisted', description: 'Claude edits code, you steer step by step' },
  { key: 'agent', title: 'Phase 2 · Agent-first', description: 'One agent works through tasks on its own' },
  { key: 'multi', title: 'Phase 3 · Multi-agent', description: 'Subagents, background agents or worktrees' },
];

// Tool calls per prompt you typed at which a session counts as agent-first.
export const AUTONOMY_THRESHOLD = 10;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const samePath = (p) => String(p).replace(/\\/g, '/').toLowerCase();
// Modes that run without asking per tool call: Claude Code's auto mode, Copilot's autopilot.
const AUTO_MODES = ['auto', 'autopilot'];

const SURFACES = {
  cli: 'CLI',
  'claude-desktop': 'Desktop app',
  'claude-vscode': 'VS Code',
  'claude-jetbrains': 'JetBrains',
  'sdk-cli': 'Agent SDK',
  'sdk-ts': 'Agent SDK',
  'sdk-py': 'Agent SDK',
  remote: 'Web',
  'copilot-cli': 'Copilot CLI',
  'copilot-vscode': 'Copilot in VS Code',
  'cursor-cli': 'Cursor CLI',
  'cursor-ide': 'Cursor editor',
};

/** Places one session's stats in a phase (first matching rule wins). */
export function classify(s) {
  // Phases 1-3 are about coding work; research with subagents is still chat.
  if (s.edits === 0 && s.prs === 0) return 'chat';
  if (s.subagentLaunches >= 2 || s.backgroundAgents > 0 || s.worktrees > 0 || s.agentMessages > 0) return 'multi';
  if (s.toolCalls / Math.max(s.prompts, 1) >= AUTONOMY_THRESHOLD) return 'agent';
  return 'assisted';
}

// Feature rows of the "Agent adoption" table: label, whether a session used it
// and, where only some sessions log it, which sessions the share is out of.
const FEATURES = [
  ['Code edits', (s) => s.edits > 0],
  ['Pull requests', (s) => s.prs > 0],
  ['Plan mode', (s) => s.planMode],
  ['Auto-approve', (s) => s.autoMode],
  ['Auto model', (s) => s.autoModel, (s) => s.modelChoice != null],
  ['Skills', (s) => s.skills > 0],
  ['Subagents', (s) => s.subagentLaunches > 0],
  ['Background agents', (s) => s.backgroundAgents > 0],
  ['Worktrees', (s) => s.worktrees > 0],
  ['Agent messaging', (s) => s.agentMessages > 0],
  ['MCP tools', (s) => s.mcpCalls > 0],
  ['Web search / fetch', (s) => s.webCalls > 0],
];

/** Per-session stats for the sessions active in the selected range. */
export function sessionStats(data, { since, until, project, timeZone, pricer, intents, withSignals = false } = {}) {
  const { buckets } = aggregate(data, { report: 'session', since, until, project, timeZone, pricer });
  const inRange = new Set(buckets.map((b) => b.key));
  const counts = new Map();
  const changed = new Map(); // sessionId -> { files: Set<path>, newFiles: Set<path> }
  for (const t of data.tools) {
    if (!inRange.has(t.sessionId)) continue;
    if (t.editFiles || t.writeFile) {
      const ch = changed.get(t.sessionId) ?? { files: new Set(), newFiles: new Set() };
      for (const f of t.editFiles ?? []) ch.files.add(samePath(f));
      if (t.writeFile) {
        ch.files.add(samePath(t.writeFile));
        ch.newFiles.add(samePath(t.writeFile));
      }
      changed.set(t.sessionId, ch);
    }
    const c = counts.get(t.sessionId) ?? { edits: 0, backgroundAgents: 0, worktrees: 0, agentMessages: 0, mcpCalls: 0, webCalls: 0 };
    // edit / web: flags set by the GitHub Copilot loader, whose tools have other names.
    if (EDIT_TOOLS.has(t.name) || t.edit) c.edits += 1;
    if (t.background) c.backgroundAgents += 1;
    if (t.worktree) c.worktrees += 1;
    if (t.name === 'SendMessage') c.agentMessages += 1;
    if (t.name.startsWith('mcp__')) c.mcpCalls += 1;
    if (t.name === 'WebSearch' || t.name === 'WebFetch' || t.web) c.webCalls += 1;
    counts.set(t.sessionId, c);
  }
  const commandsBySession = new Map();
  for (const c of data.commands ?? []) {
    if (!inRange.has(c.sessionId)) continue;
    commandsBySession.set(c.sessionId, [...(commandsBySession.get(c.sessionId) ?? []), c.name]);
  }
  return buckets.map((b) => {
    const info = data.sessions.get(b.key);
    const s = {
      id: b.key,
      title: b.title,
      project: [...b.projects][0] ?? '',
      firstActivity: b.firstActivity,
      lastActivity: b.lastActivity,
      surface: SURFACES[info?.entrypoint] ?? info?.entrypoint ?? 'unknown',
      prompts: info?.prompts.size ?? 0,
      prs: info?.prs.size ?? 0,
      planMode: info?.modes?.has('plan') ?? false,
      autoMode: AUTO_MODES.some((m) => info?.modes?.has(m)),
      // The model picked for the session, where logged (Cursor's database); "default" is Cursor's Auto.
      modelChoice: info?.modelChoice ?? null,
      autoModel: info?.modelChoice === 'default',
      toolCalls: b.toolCalls,
      skills: b.skillCalls,
      subagentLaunches: b.subagentLaunches,
      totalTokens: b.totalTokens,
      costUSD: b.costUSD,
      ...(counts.get(b.key) ?? { edits: 0, backgroundAgents: 0, worktrees: 0, agentMessages: 0, mcpCalls: 0, webCalls: 0 }),
    };
    s.toolCallsPerPrompt = s.toolCalls / Math.max(s.prompts, 1);
    s.phase = classify(s);
    const ch = changed.get(b.key);
    const files = { code: 0, tests: 0, docs: 0, ops: 0, plans: 0 };
    for (const f of ch?.files ?? []) files[fileKind(f)] += 1;
    const signals = {
      title: data.titles?.get(b.key) ?? null,
      firstPrompt: info?.firstPrompt ?? null,
      branches: [...(info?.branches ?? [])],
      workMessages: [...(info?.workMessages?.values() ?? [])].flat(),
      commands: commandsBySession.get(b.key) ?? [],
      files,
      newFiles: ch?.newFiles.size ?? 0,
      edits: s.edits,
    };
    const { intent, evidence } = classifyIntent(signals);
    // An intent Claude assigned (--intents) replaces the rules' guess.
    const assigned = intents?.get(b.key);
    s.intent = assigned ?? intent;
    s.intentEvidence = assigned ? ['claude'] : evidence;
    if (withSignals) {
      // Every prompt typed in the session, in order (resumed copies counted once).
      const prompts = [...(info?.promptTexts?.values() ?? [])]
        .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))
        .map((p) => p.text);
      const { firstPrompt, ...rest } = signals;
      s.intentSignals = { ...rest, prompts: prompts.length ? prompts : firstPrompt ? [firstPrompt] : [], ruleIntent: intent, ruleEvidence: evidence };
    }
    return s;
  });
}

const median = (values) => {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

function weekStart(timestamp, timeZone) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(timestamp),
  );
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const right = (title) => ({ title, align: 'right' });
const left = (title) => ({ title, align: 'left' });
const pct = (v) => `${Math.round(v * 100)}%`;

/** Written assessment lines. */
function assess(stats, byPhase, features) {
  if (!stats.length) return [];
  const lines = [];
  const ranked = PHASES.map((p) => ({ ...p, n: byPhase.get(p.key).length })).sort((a, b) => b.n - a.n);
  const top = ranked[0];
  lines.push(`Most of your sessions are ${top.title} (${pct(top.n / stats.length)} of ${stats.length}).`);

  const agentic = stats.filter((s) => s.phase === 'agent' || s.phase === 'multi').length;
  lines.push(`${pct(agentic / stats.length)} of sessions work agent-first or with multiple agents.`);

  // Trend: earlier half of the sessions vs the recent half.
  if (stats.length >= 6) {
    const sorted = [...stats].sort((a, b) => (a.firstActivity < b.firstActivity ? -1 : 1));
    const half = Math.floor(sorted.length / 2);
    const agenticShare = (list) => list.filter((s) => s.phase === 'agent' || s.phase === 'multi').length / list.length;
    lines.push(
      `Agent-first or multi-agent: ${pct(agenticShare(sorted.slice(0, half)))} of your earlier sessions, ${pct(agenticShare(sorted.slice(half)))} of your recent ones.`,
    );
  }

  const perSession = (key, f) => {
    const list = byPhase.get(key);
    return list.length ? list.reduce((s, x) => s + f(x), 0) / list.length : null;
  };
  const coding = PHASES.filter((p) => p.key !== 'chat' && byPhase.get(p.key).length);
  if (coding.length >= 2) {
    const parts = coding.map((p) => `${p.title.replace(/^Phase \d · /, '')} ${perSession(p.key, (s) => s.prs).toFixed(2)}`);
    lines.push(`PRs per session: ${parts.join(', ')}.`);
  }

  const unused = features.filter(([, used]) => !stats.some(used)).map(([label]) => label.toLowerCase());
  if (unused.length) lines.push(`Not used in this period: ${unused.join(', ')}.`);
  return lines;
}

/** The adoption report document. */
export function buildAdoption(data, opts) {
  const { showCost, timeZone } = opts;
  const stats = sessionStats(data, opts);
  const byPhase = new Map(PHASES.map((p) => [p.key, stats.filter((s) => s.phase === p.key)]));
  const sum = (list, f) => list.reduce((s, x) => s + f(x), 0);
  // Cursor's logs don't record auto-run, so its reports leave auto mode out.
  const logsAuto = opts.product !== 'Cursor';
  // Only Cursor logs the model you picked: the row shows when some session has it.
  const logsModelChoice = stats.some((s) => s.modelChoice != null);
  const features = FEATURES.filter(
    ([label]) => (logsAuto || label !== 'Auto-approve') && (logsModelChoice || label !== 'Auto model'),
  ).map(([label, ...rest]) => [label === 'Auto model' && opts.product !== 'Cursor' ? 'Auto model (Cursor)' : label, ...rest]);

  // Cohorts: one card per phase.
  // Column order matters for the HTML cards: title, subtitle, headline figure.
  const cohortColumns = [
    left('Phase'),
    left('How'),
    right('Of sessions'),
    right('Sessions'),
    right('PRs per session'),
    right('PRs'),
    right('Edits per session'),
    right('Median tool calls per prompt'),
    right('Plan mode'),
    ...(logsAuto ? [right('Auto-approve')] : []),
    ...(opts.tokens !== false ? [right('Tokens per session')] : []),
    ...(showCost ? [right('Cost per session')] : []),
  ];
  // The phase descriptions name Claude; other products' reports say "the agent".
  const agentName = (opts.product ?? 'Claude Code') === 'Claude Code' ? 'Claude' : 'The agent';
  const cohortRows = PHASES.map((p) => {
    const list = byPhase.get(p.key);
    const prs = sum(list, (s) => s.prs);
    const m = median(list.map((s) => s.toolCallsPerPrompt));
    return {
      cells: [
        p.title,
        p.description.replace(/^Claude\b/, agentName),
        share(list.length, stats.length),
        list.length,
        average(prs, list.length),
        prs,
        average(sum(list, (s) => s.edits), list.length),
        m == null ? '' : average(m, 1),
        share(list.filter((s) => s.planMode).length, list.length),
        ...(logsAuto ? [share(list.filter((s) => s.autoMode).length, list.length)] : []),
        ...(opts.tokens !== false ? [list.length ? Math.round(sum(list, (s) => s.totalTokens) / list.length) : ''] : []),
        ...(showCost ? [list.length ? money(sum(list, (s) => s.costUSD) / list.length) : ''] : []),
      ],
    };
  });

  // Phase mix per week (by the week a session started).
  const weekMap = new Map();
  for (const s of stats) {
    const key = weekStart(s.firstActivity, timeZone);
    const w = weekMap.get(key) ?? { key, total: 0, prs: 0, plan: 0, auto: 0, phases: Object.fromEntries(PHASES.map((p) => [p.key, 0])) };
    w.total += 1;
    w.prs += s.prs;
    if (s.planMode) w.plan += 1;
    if (s.autoMode) w.auto += 1;
    w.phases[s.phase] += 1;
    weekMap.set(key, w);
  }
  const weeks = [...weekMap.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  const weekRows = weeks.map((w) => ({
    cells: [
      w.key,
      w.total,
      ...PHASES.map((p) => share(w.phases[p.key], w.total)),
      share(w.plan, w.total),
      ...(logsAuto ? [share(w.auto, w.total)] : []),
      w.prs,
    ],
  }));

  // Usage by surface.
  const surfaces = new Map();
  for (const s of stats) {
    const e = surfaces.get(s.surface) ?? { sessions: 0, prs: 0 };
    e.sessions += 1;
    e.prs += s.prs;
    surfaces.set(s.surface, e);
  }
  const surfaceRows = [...surfaces]
    .sort((a, b) => b[1].sessions - a[1].sessions)
    .map(([name, e]) => ({ cells: [name, e.sessions, share(e.sessions, stats.length), e.prs] }));

  const featureRows = features.map(([label, used, logged]) => {
    const n = stats.filter(used).length;
    return { cells: [label, n, share(n, logged ? stats.filter(logged).length : stats.length)] };
  });

  // What sessions were for: one row per intent seen, the most common first, Other last.
  const byIntent = INTENTS.map((i) => ({ ...i, list: stats.filter((s) => s.intent === i.key) }))
    .filter((i) => i.list.length)
    .sort((a, b) => (a.key === 'other') - (b.key === 'other') || b.list.length - a.list.length);
  const intentRows = byIntent.map(({ title, description, list }) => ({
    cells: [
      title,
      description,
      list.length,
      share(list.length, stats.length),
      sum(list, (s) => s.prs),
      average(sum(list, (s) => s.edits), list.length),
      ...(opts.tokens !== false ? [Math.round(sum(list, (s) => s.totalTokens) / list.length)] : []),
      ...(showCost ? [money(sum(list, (s) => s.costUSD) / list.length)] : []),
    ],
  }));
  const summary = assess(stats, byPhase, features);
  const named = byIntent.filter((i) => i.key !== 'other').slice(0, 3);
  if (named.length) summary.push(`By intent: ${named.map((i) => `${i.title.toLowerCase()} ${pct(i.list.length / stats.length)}`).join(', ')}.`);

  const range = opts.since || opts.until ? ` (${opts.since ?? '…'} → ${opts.until ?? 'today'})` : '';
  return {
    title: `${opts.product ?? 'Claude Code'} adoption${range}`,
    summary,
    sections: [
      { title: 'Adoption cohorts', note: `sessions by how they used ${opts.product ?? 'Claude Code'}`, cards: true, columns: cohortColumns, rows: cohortRows },
      {
        title: 'Phase mix per week',
        note: 'by the week a session started',
        columns: [
          left('Week'),
          right('Sessions'),
          ...PHASES.map((p) => right(p.title)),
          right('Plan mode'),
          ...(logsAuto ? [right('Auto-approve')] : []),
          right('PRs'),
        ],
        rows: weekRows,
      },
      {
        title: 'Agent adoption',
        note: `share of sessions using each capability${logsModelChoice ? '; Auto model: of the sessions that log the model picked' : ''}`,
        columns: [left('Capability'), right('Sessions'), right('Share of sessions')],
        rows: featureRows,
      },
      {
        title: 'Usage by surface',
        columns: [left('Surface'), right('Sessions'), right('Share of sessions'), right('PRs')],
        rows: surfaceRows,
      },
      {
        title: 'Session intent',
        note: intentNote(stats),
        columns: [
          left('Intent'),
          left('What'),
          right('Sessions'),
          right('Share of sessions'),
          right('PRs'),
          right('Edits per session'),
          ...(opts.tokens !== false ? [right('Tokens per session')] : []),
          ...(showCost ? [right('Cost per session')] : []),
        ],
        rows: intentRows,
      },
    ],
    stats,
  };
}

function intentNote(stats) {
  const byClaude = stats.filter((s) => s.intentEvidence?.includes('claude')).length;
  if (!byClaude) return 'what sessions were for, from commits, titles, branches, prompts and changed files';
  if (byClaude === stats.length) return 'what sessions were for, as classified by Claude';
  return `what sessions were for: ${byClaude} of ${stats.length} classified by Claude, the rest by rules`;
}

/**
 * Intents assigned outside ccreports (by Claude, through the skill), from JSON:
 * { "<session id>": "<intent>" }, [{ id, intent }] or { sessions: [{ id, intent }] }.
 * Intents are keys or titles from INTENTS. Returns { intents: Map, unknown: [values] }.
 */
export function parseIntents(json) {
  const byName = new Map(INTENTS.flatMap((i) => [[i.key, i.key], [i.title.toLowerCase(), i.key]]));
  const list = Array.isArray(json)
    ? json
    : Array.isArray(json?.sessions)
      ? json.sessions
      : Object.entries(json ?? {}).map(([id, intent]) => ({ id, intent }));
  const intents = new Map();
  const unknown = [];
  for (const { id, intent } of list) {
    const key = byName.get(String(intent ?? '').trim().toLowerCase());
    if (id && key) intents.set(id, key);
    else if (id) unknown.push(String(intent));
  }
  return { intents, unknown };
}

/**
 * The `intents` report: one row per session with its intent and the evidence.
 * In JSON (see bin) each session also carries the signals, for Claude to classify.
 */
export function buildIntents(data, opts) {
  const stats = sessionStats(data, { ...opts, withSignals: true });
  const title = (key) => INTENTS.find((i) => i.key === key)?.title ?? key;
  const sorted = [...stats].sort((a, b) => (a.firstActivity < b.firstActivity ? -1 : 1));
  const range = opts.since || opts.until ? ` (${opts.since ?? '…'} → ${opts.until ?? 'today'})` : '';
  return {
    title: `${opts.product ?? 'Claude Code'} session intent${range}`,
    summary: [],
    sections: [
      {
        title: 'Sessions',
        note: intentNote(stats),
        columns: [left('Session'), left('Started'), left('Intent'), left('Evidence'), right('Edits'), right('PRs')],
        rows: sorted.map((s) => ({
          cells: [
            sessionName(s.title ?? s.id.slice(0, 8)),
            String(s.firstActivity).slice(0, 10),
            title(s.intent),
            s.intentEvidence.join(', '),
            s.edits,
            s.prs,
          ],
        })),
      },
    ],
    stats,
  };
}
