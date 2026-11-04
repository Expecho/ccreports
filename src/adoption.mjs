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
// An edit is "without a Read" when its file wasn't read in this many tool calls
// before it (claude-session-analyzer's definition), and "without the file in
// view" when it also wasn't written or edited there: after a write or an edit
// the agent already knows the file's current content.
export const READ_WINDOW = 10;
const samePath = (p) => String(p).replace(/\\/g, '/').toLowerCase();
const emptyCounts = () => ({
  edits: 0,
  backgroundAgents: 0,
  worktrees: 0,
  agentMessages: 0,
  mcpCalls: 0,
  webCalls: 0,
  fileReads: 0,
  fileEdits: 0,
  editsWithoutRead: 0,
  editsWithoutView: 0,
});

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
  const recent = new Map(); // session + agent -> files its last READ_WINDOW tool calls read / wrote / edited
  for (const t of data.tools) {
    if (!inRange.has(t.sessionId)) continue;
    const c = counts.get(t.sessionId) ?? emptyCounts();
    // Reads and in-place edits, in call order per conversation (main or subagent).
    const ctx = `${t.sessionId}\0${t.agent ?? ''}`;
    const window = recent.get(ctx) ?? [];
    for (const file of t.editFiles ?? []) {
      const p = samePath(file);
      c.fileEdits += 1;
      if (!window.some((w) => w.read === p)) c.editsWithoutRead += 1;
      if (!window.some((w) => w.read === p || w.touched.includes(p))) c.editsWithoutView += 1;
    }
    if (t.readFile) c.fileReads += 1;
    window.push({
      read: t.readFile ? samePath(t.readFile) : null,
      touched: [...(t.editFiles ?? []), ...(t.writeFile ? [t.writeFile] : [])].map(samePath),
    });
    if (window.length > READ_WINDOW) window.shift();
    recent.set(ctx, window);
    // edit / web: flags set by the GitHub Copilot loader, whose tools have other names.
    if (EDIT_TOOLS.has(t.name) || t.edit) c.edits += 1;
    if (t.background) c.backgroundAgents += 1;
    if (t.worktree) c.worktrees += 1;
    if (t.name === 'SendMessage') c.agentMessages += 1;
    if (t.name.startsWith('mcp__')) c.mcpCalls += 1;
    if (t.name === 'WebSearch' || t.name === 'WebFetch' || t.web) c.webCalls += 1;
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
      // null where the product logs no interrupts (Cursor).
      interrupts: info?.interrupts ? info.interrupts.size : null,
      prs: info?.prs.size ?? 0,
      toolCalls: b.toolCalls,
      skills: b.skillCalls,
      subagentLaunches: b.subagentLaunches,
      totalTokens: b.totalTokens,
      costUSD: b.costUSD,
      ...(counts.get(b.key) ?? emptyCounts()),
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

/**
 * How sessions are driven: prompts per session, how much the agent reads before
 * it edits, and how often the user interrupts it.
 */
export function workingHabits(stats) {
  const sum = (list, f) => list.reduce((s, x) => s + f(x), 0);
  const prompted = stats.filter((s) => s.prompts > 0).map((s) => s.prompts);
  const logged = stats.filter((s) => s.interrupts != null);
  const fileReads = sum(stats, (s) => s.fileReads);
  const fileEdits = sum(stats, (s) => s.fileEdits);
  const editsWithoutRead = sum(stats, (s) => s.editsWithoutRead);
  const editsWithoutView = sum(stats, (s) => s.editsWithoutView);
  const interrupts = logged.length ? sum(logged, (s) => s.interrupts) : null;
  const loggedToolCalls = sum(logged, (s) => s.toolCalls);
  return {
    promptedSessions: prompted.length,
    avgPromptsPerSession: prompted.length ? sum(prompted, (n) => n) / prompted.length : null,
    medianPromptsPerSession: median(prompted),
    fileReads,
    fileEdits,
    readEditRatio: fileEdits ? fileReads / fileEdits : null,
    editsWithoutRead,
    editsWithoutReadShare: fileEdits ? editsWithoutRead / fileEdits : null,
    editsWithoutView,
    editsWithoutViewShare: fileEdits ? editsWithoutView / fileEdits : null,
    readWindow: READ_WINDOW,
    interrupts,
    interruptsPer1kToolCalls: interrupts != null && loggedToolCalls ? (interrupts / loggedToolCalls) * 1000 : null,
  };
}

const right = (title) => ({ title, align: 'right' });
const left = (title) => ({ title, align: 'left' });
const pct = (v) => `${Math.round(v * 100)}%`;

/** Written assessment lines. */
function assess(stats, byPhase, habits) {
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

  if (habits.fileEdits) {
    lines.push(
      `Read:Edit ratio ${habits.readEditRatio.toFixed(1)}; ${pct(habits.editsWithoutViewShare)} of edits changed a file not read, written or edited in the ${READ_WINDOW} tool calls before.`,
    );
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
        average(prs, list.length),
        list.length,
        share(list.length, stats.length),
        prs,
        average(sum(list, (s) => s.edits), list.length),
        m == null ? '' : average(m, 1),
        ...(opts.tokens !== false ? [list.length ? Math.round(sum(list, (s) => s.totalTokens) / list.length) : ''] : []),
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

  const habits = workingHabits(stats);
  const fmt = (n) => n.toLocaleString('en-US');
  const habitRows = [
    ...(habits.promptedSessions
      ? [
          { cells: ['Prompts per session (average)', average(habits.avgPromptsPerSession, 1), `${fmt(habits.promptedSessions)} sessions with a prompt`, ''] },
          { cells: ['Prompts per session (median)', average(habits.medianPromptsPerSession, 1), 'a far lower median than average: a few long sessions', ''] },
        ]
      : []),
    ...(habits.fileEdits
      ? [
          { cells: ['Read:Edit ratio', average(habits.fileReads, habits.fileEdits), `${fmt(habits.fileReads)} file reads, ${fmt(habits.fileEdits)} in-place edits`, 'good above 6, low below 2'] },
          {
            cells: [
              'Edits without a recent Read',
              share(habits.editsWithoutView, habits.fileEdits),
              `${fmt(habits.editsWithoutView)} edits to a file not read, written or edited in the ${READ_WINDOW} calls before; ${pct(habits.editsWithoutReadShare)} counting reads only`,
              'good below 10%, high above 25%',
            ],
          },
        ]
      : []),
    ...(habits.interrupts != null
      ? [
          {
            cells: [
              'User interrupts',
              habits.interrupts,
              habits.interruptsPer1kToolCalls == null ? '' : `${habits.interruptsPer1kToolCalls.toFixed(1)} per 1,000 tool calls`,
              'good below 1, high above 5 per 1,000',
            ],
          },
        ]
      : []),
  ];
  // The median row's note only applies when the two differ a lot.
  if (habits.promptedSessions && !(habits.avgPromptsPerSession >= 2 * habits.medianPromptsPerSession)) habitRows[1].cells[2] = '';

  const range = opts.since || opts.until ? ` (${opts.since ?? '…'} → ${opts.until ?? 'today'})` : '';
  return {
    title: `${opts.product ?? 'Claude Code'} adoption${range}`,
    summary: assess(stats, byPhase, habits),
    sections: [
      { title: 'Adoption cohorts', note: `sessions by how they used ${opts.product ?? 'Claude Code'}`, cards: true, columns: cohortColumns, rows: cohortRows },
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
      ...(habitRows.length
        ? [
            {
              title: 'Working habits',
              note: 'reference ranges from claude-session-analyzer',
              columns: [left('Metric'), right('Value'), left('Detail'), left('Reference')],
              rows: habitRows,
            },
          ]
        : []),
    ],
    habits,
    stats,
  };
}
