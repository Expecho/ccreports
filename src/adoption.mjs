// Adoption assessment, modelled on GitHub Copilot's adoption cohorts: every
// session is placed in a phase by how it used Claude Code, and the phases are
// compared on PRs, tokens and cost. Built as a report document (src/report.mjs).

import { aggregate } from './aggregate.mjs';
import { money, share, average } from './report.mjs';

export const PHASES = [
  { key: 'chat', title: 'Chat', description: 'Questions and exploration, no code changes' },
  { key: 'assisted', title: 'Phase 1 · Assisted', description: 'Claude edits code, you steer step by step' },
  { key: 'agent', title: 'Phase 2 · Agent-first', description: 'One agent works through tasks on its own' },
  { key: 'multi', title: 'Phase 3 · Multi-agent', description: 'Subagents, background agents or worktrees' },
];

// Tool calls per prompt you typed at which a session counts as agent-first.
export const AUTONOMY_THRESHOLD = 10;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const SURFACES = {
  cli: 'CLI',
  'claude-desktop': 'Desktop app',
  'claude-vscode': 'VS Code',
  'claude-jetbrains': 'JetBrains',
  'sdk-cli': 'Agent SDK',
  'sdk-ts': 'Agent SDK',
  'sdk-py': 'Agent SDK',
  remote: 'Web',
};

/** Places one session's stats in a phase (first matching rule wins). */
export function classify(s) {
  // Phases 1-3 are about coding work; research with subagents is still chat.
  if (s.edits === 0 && s.prs === 0) return 'chat';
  if (s.subagentLaunches >= 2 || s.backgroundAgents > 0 || s.worktrees > 0 || s.agentMessages > 0) return 'multi';
  if (s.toolCalls / Math.max(s.prompts, 1) >= AUTONOMY_THRESHOLD) return 'agent';
  return 'assisted';
}

// Feature rows of the "Agent adoption" table: label and whether a session used it.
const FEATURES = [
  ['Code edits', (s) => s.edits > 0],
  ['Pull requests', (s) => s.prs > 0],
  ['Skills', (s) => s.skills > 0],
  ['Subagents', (s) => s.subagentLaunches > 0],
  ['Background agents', (s) => s.backgroundAgents > 0],
  ['Worktrees', (s) => s.worktrees > 0],
  ['Agent messaging', (s) => s.agentMessages > 0],
  ['MCP tools', (s) => s.mcpCalls > 0],
  ['Web search / fetch', (s) => s.webCalls > 0],
];

/** Per-session stats for the sessions active in the selected range. */
export function sessionStats(data, { since, until, project, timeZone, pricer } = {}) {
  const { buckets } = aggregate(data, { report: 'session', since, until, project, timeZone, pricer });
  const inRange = new Set(buckets.map((b) => b.key));
  const counts = new Map();
  for (const t of data.tools) {
    if (!inRange.has(t.sessionId)) continue;
    const c = counts.get(t.sessionId) ?? { edits: 0, backgroundAgents: 0, worktrees: 0, agentMessages: 0, mcpCalls: 0, webCalls: 0 };
    if (EDIT_TOOLS.has(t.name)) c.edits += 1;
    if (t.background) c.backgroundAgents += 1;
    if (t.worktree) c.worktrees += 1;
    if (t.name === 'SendMessage') c.agentMessages += 1;
    if (t.name.startsWith('mcp__')) c.mcpCalls += 1;
    if (t.name === 'WebSearch' || t.name === 'WebFetch') c.webCalls += 1;
    counts.set(t.sessionId, c);
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
      toolCalls: b.toolCalls,
      skills: b.skillCalls,
      subagentLaunches: b.subagentLaunches,
      totalTokens: b.totalTokens,
      costUSD: b.costUSD,
      ...(counts.get(b.key) ?? { edits: 0, backgroundAgents: 0, worktrees: 0, agentMessages: 0, mcpCalls: 0, webCalls: 0 }),
    };
    s.toolCallsPerPrompt = s.toolCalls / Math.max(s.prompts, 1);
    s.phase = classify(s);
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
function assess(stats, byPhase) {
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

  const unused = FEATURES.filter(([, used]) => !stats.some(used)).map(([label]) => label.toLowerCase());
  if (unused.length) lines.push(`Not used in this period: ${unused.join(', ')}.`);
  return lines;
}

/** The adoption report document. */
export function buildAdoption(data, opts) {
  const { showCost, timeZone } = opts;
  const stats = sessionStats(data, opts);
  const byPhase = new Map(PHASES.map((p) => [p.key, stats.filter((s) => s.phase === p.key)]));
  const sum = (list, f) => list.reduce((s, x) => s + f(x), 0);

  // Cohorts: one card per phase.
  // Column order matters for the HTML cards: title, subtitle, headline figure.
  const cohortColumns = [
    left('Phase'),
    left('How'),
    right('PRs per session'),
    right('Sessions'),
    right('Share of sessions'),
    right('PRs'),
    right('Edits per session'),
    right('Median tool calls per prompt'),
    right('Tokens per session'),
    ...(showCost ? [right('Cost per session')] : []),
  ];
  const cohortRows = PHASES.map((p) => {
    const list = byPhase.get(p.key);
    const prs = sum(list, (s) => s.prs);
    const m = median(list.map((s) => s.toolCallsPerPrompt));
    return {
      cells: [
        p.title,
        p.description,
        average(prs, list.length),
        list.length,
        share(list.length, stats.length),
        prs,
        average(sum(list, (s) => s.edits), list.length),
        m == null ? '' : average(m, 1),
        list.length ? Math.round(sum(list, (s) => s.totalTokens) / list.length) : '',
        ...(showCost ? [list.length ? money(sum(list, (s) => s.costUSD) / list.length) : ''] : []),
      ],
    };
  });

  // Phase mix per week (by the week a session started).
  const weekMap = new Map();
  for (const s of stats) {
    const key = weekStart(s.firstActivity, timeZone);
    const w = weekMap.get(key) ?? { key, total: 0, prs: 0, phases: Object.fromEntries(PHASES.map((p) => [p.key, 0])) };
    w.total += 1;
    w.prs += s.prs;
    w.phases[s.phase] += 1;
    weekMap.set(key, w);
  }
  const weeks = [...weekMap.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  const weekRows = weeks.map((w) => ({
    cells: [w.key, w.total, ...PHASES.map((p) => share(w.phases[p.key], w.total)), w.prs],
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

  const featureRows = FEATURES.map(([label, used]) => {
    const n = stats.filter(used).length;
    return { cells: [label, n, share(n, stats.length)] };
  });

  const range = opts.since || opts.until ? ` (${opts.since ?? '…'} → ${opts.until ?? 'today'})` : '';
  return {
    title: `Claude Code adoption${range}`,
    summary: assess(stats, byPhase),
    sections: [
      { title: 'Adoption cohorts', note: 'sessions by how they used Claude Code', cards: true, columns: cohortColumns, rows: cohortRows },
      {
        title: 'Phase mix per week',
        note: 'by the week a session started',
        columns: [left('Week'), right('Sessions'), ...PHASES.map((p) => right(p.title)), right('PRs')],
        rows: weekRows,
      },
      {
        title: 'Agent adoption',
        note: 'share of sessions using each capability',
        columns: [left('Capability'), right('Sessions'), right('Share of sessions')],
        rows: featureRows,
      },
      {
        title: 'Usage by surface',
        columns: [left('Surface'), right('Sessions'), right('Share of sessions'), right('PRs')],
        rows: surfaceRows,
      },
    ],
    stats,
  };
}
