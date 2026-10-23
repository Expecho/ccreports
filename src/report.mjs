// Builds format-neutral report documents from aggregated buckets. A document is
//   { title, sections: [{ title?, note?, columns, rows }] }
// where a column is { title, align, maxWidth?, clip?, wrap? } and a row is { cells, style? }
// (style 'total' or 'sub'). Cells are raw values - numbers, strings, money() or
// share() - so each output format (src/formats.mjs) decides how to print them.

import { ranked, MAIN_AGENT } from './aggregate.mjs';
import { commandCategory, OTHER_CATEGORY } from './shell.mjs';

export const money = (v, { approx = false } = {}) => ({ kind: 'usd', v: v || 0, approx });
export const approx = (v) => ({ kind: 'num', v: v || 0, approx: true });
export const share = (part, whole) => ({ kind: 'pct', v: whole ? part / whole : null });
export const average = (total, count) => ({ kind: 'avg', v: count ? total / count : null });

const right = (title) => ({ title, align: 'right' });
const left = (title, maxWidth) => ({ title, align: 'left', maxWidth });
// Long text: wraps in HTML, truncated in the terminal.
// Paths: at most 40 characters in every display format, keeping the end.
const path = (title) => ({ title, align: 'left', maxWidth: 40, clip: 'start' });
const wrapped = (title) => ({ title, align: 'left', maxWidth: 100, wrap: true });

/** Shell command categories by calls, Other last. */
const shellCategoryRows = (categories) =>
  ranked(categories, (c) => c.calls).sort((a, b) => (a[0] === OTHER_CATEGORY) - (b[0] === OTHER_CATEGORY));

/** 1234 -> "1.2K", 45100000 -> "45M". */
function shortNumber(n) {
  for (const [div, unit] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (n >= div) return `${(n / div).toFixed(n >= div * 10 ? 0 : 1)}${unit}`;
  }
  return String(Math.round(n));
}

/** "grep 8,956 (~45M) · head 7,579 (~30M) · +4 more": a category's programs, most used first. */
function categoryCommands(programs, category, limit, { counts = true } = {}) {
  const list = ranked(programs ?? new Map(), (p) => p.calls).filter(([name]) => commandCategory(name) === category);
  const shown = list
    .slice(0, limit)
    .map(([name, p]) => (counts ? `${name} ${p.calls.toLocaleString('en-US')} (~${shortNumber(p.tokens)})` : name));
  if (list.length > limit) shown.push(`+${list.length - limit} more`);
  return shown.join(counts ? ' · ' : ', ');
}

// sv-SE formats as "YYYY-MM-DD HH:mm".
const localTime = (timestamp, timeZone) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));

function tokenColumns({ compact, showCost }) {
  const cols = compact
    ? [right('Input'), right('Output'), right('Total Tokens')]
    : [right('Input'), right('Output'), right('Cache Create'), right('Cache Read'), right('Total Tokens')];
  if (showCost) cols.push(right('Cost (USD)'));
  return cols;
}

// Token cells of a breakdown item, keyed by column. `allInput` (every input-side
// token) is what the compact layout shows under Input.

/** Attributed tool/skill tokens: estimates, shown with "~". Results always arrive via the cache, so Input stays empty. */
function estimated(t) {
  if (!t) return null;
  return {
    input: '',
    output: approx(t.outputTokens),
    cacheCreate: approx(t.cacheWriteTokens),
    cacheRead: approx(t.cacheReadTokens),
    allInput: approx(t.cacheWriteTokens + t.cacheReadTokens),
    total: approx(t.tokens),
    cost: money(t.costUSD, { approx: true }),
  };
}

/** A subagent type's own requests: exact. */
function exact(a) {
  return {
    input: a.inputTokens,
    output: a.outputTokens,
    cacheCreate: a.cacheCreationTokens,
    cacheRead: a.cacheReadTokens,
    allInput: a.inputTokens + a.cacheCreationTokens + a.cacheReadTokens,
    total: a.totalTokens,
    cost: money(a.costUSD),
  };
}

function subTokenCells(u, { compact, showCost }) {
  const cells = !u
    ? (compact ? ['', '', ''] : ['', '', '', '', ''])
    : compact
      ? [u.allInput, u.output, u.total]
      : [u.input, u.output, u.cacheCreate, u.cacheRead, u.total];
  if (showCost) cells.push(u ? u.cost : '');
  return cells;
}

function tokenCells(b, { compact, showCost }) {
  const cells = compact
    ? [b.inputTokens, b.outputTokens, b.totalTokens]
    : [b.inputTokens, b.outputTokens, b.cacheCreationTokens, b.cacheReadTokens, b.totalTokens];
  if (showCost) cells.push(money(b.costUSD));
  return cells;
}

// One session: its peak and average request. Several sessions: the largest
// peak, and the session peaks averaged.
const contextColumns = (perSession) =>
  perSession ? [right('Max Context'), right('Avg Context')] : [right('Max Context'), right('Avg Max Context')];
const contextCells = (b, perSession) =>
  perSession ? [b.maxContextTokens, b.avgContextTokens] : [b.maxContextTokens, b.avgSessionMaxContextTokens];

const COUNT_COLUMNS = [right('Tools'), right('Skills'), right('Cmds'), right('Agents')];
const countCells = (b) => [b.toolCalls, b.skillCalls, b.commandCount, b.subagentLaunches];

function shortModel(model) {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function rangeText({ since, until }) {
  return since || until ? ` (${since ?? '…'} → ${until ?? 'today'})` : '';
}

const PERIOD = {
  daily: { title: 'Date', name: 'daily' },
  weekly: { title: 'Week', name: 'weekly' },
  monthly: { title: 'Month', name: 'monthly' },
  session: { title: 'Session', name: 'per-session' },
  project: { title: 'Project', name: 'per-project' },
};

/** daily / weekly / monthly / session / project report. */
export function buildPeriodReport(report, { buckets, totals }, opts) {
  const { breakdown, shell, top, timeZone } = opts;
  const hasSubRows = breakdown || shell;
  const isSession = report === 'session';
  const lead = isSession
    ? [left('Session', 36), path('Project'), left('Last Activity')]
    : [report === 'project' ? path('Project') : left(PERIOD[report].title)];
  // A session row is always one session, so the per-session columns only make
  // sense for the other reports. Per Session is filled on breakdown sub-rows.
  const sessionColumns = isSession ? [] : [right('Sessions'), ...(hasSubRows ? [right('Per Session')] : [])];
  const sessionCells = (b) => (isSession ? [] : [b.sessions.size, ...(hasSubRows ? [''] : [])]);
  const columns = [
    ...lead,
    left('Models', 28),
    ...tokenColumns(opts),
    ...contextColumns(isSession),
    ...sessionColumns,
    ...COUNT_COLUMNS,
  ];
  const blankLead = lead.map(() => '');
  const emptyContext = contextColumns(isSession).map(() => '');

  // Sub-row: label in the first column, the item's tokens and cost under Total
  // Tokens / Cost, its count under Tools / Skills / Cmds / Agents, and the count
  // averaged over the row's sessions under Per Session.
  const subRow = (b, label, count, col, usage) => {
    const counts = COUNT_COLUMNS.map(() => '');
    counts[col] = count;
    const subLead = [...blankLead];
    subLead[0] = label;
    const perSession = isSession ? [] : ['', average(count, b.sessions.size)];
    return {
      cells: [...subLead, '', ...subTokenCells(usage, opts), ...emptyContext, ...perSession, ...counts],
      style: 'sub',
    };
  };

  const rows = [];
  for (const b of buckets) {
    const models = ranked(b.models, (m) => m.totalTokens).map(([m]) => shortModel(m));
    const leadCells = isSession
      ? [b.title ?? b.key.slice(0, 8), [...b.projects][0] ?? '', localTime(b.lastActivity, timeZone)]
      : [b.key];
    rows.push({
      cells: [
        ...leadCells,
        models.join(', '),
        ...tokenCells(b, opts),
        ...contextCells(b, isSession),
        ...sessionCells(b),
        ...countCells(b),
      ],
    });

    const limit = top > 0 ? top : Infinity;
    if (shell) {
      // Bash / PowerShell calls by purpose, with the programs run, counted under Tools.
      for (const [name, categories] of b.shellCategories)
        for (const [category, c] of shellCategoryRows(categories)) {
          const programs = categoryCommands(b.shellCommands.get(name), category, 3, { counts: false });
          rows.push(subRow(b, `[${name.toLowerCase()}] ${category}: ${programs}`, c.calls, 0, estimated(c)));
        }
    }
    if (breakdown) {
      for (const [name, count] of ranked(b.tools).slice(0, limit))
        rows.push(subRow(b, `[tool] ${name}`, count, 0, estimated(b.toolTokens.get(name))));
      for (const [name, s] of ranked(b.skills, (s) => s.model + s.user).slice(0, limit))
        rows.push(subRow(b, `[skill] ${name}`, s.model + s.user, 1, estimated(b.skillTokens.get(name))));
      for (const [name, count] of ranked(b.commands).slice(0, limit)) rows.push(subRow(b, `[cmd] ${name}`, count, 2));
      // Subagent tokens are exact: everything in that type's own transcripts.
      const launched = [...b.agents].filter(([, a]) => a.launches > 0);
      for (const [name, a] of launched.sort((x, y) => y[1].launches - x[1].launches).slice(0, limit))
        rows.push(subRow(b, `[agent] ${name}`, a.launches, 3, exact(a)));
    }
  }

  const totalLead = [...blankLead];
  totalLead[0] = 'Total';
  rows.push({
    cells: [
      ...totalLead,
      '',
      ...tokenCells(totals, opts),
      ...contextCells(totals, isSession),
      ...sessionCells(totals),
      ...countCells(totals),
    ],
    style: 'total',
  });

  return {
    title: `Claude Code ${PERIOD[report].name} usage${rangeText(opts)}`,
    sections: [{ columns, rows }],
  };
}

/** Summary: totals plus ranked tool / MCP / skill / command / subagent / model tables. */
export function buildSummary({ totals }, opts) {
  const { top, showCost } = opts;
  const sections = [
    {
      columns: [
        ...tokenColumns(opts),
        ...contextColumns(false),
        right('Requests'),
        right('Sessions'),
        right('Projects'),
        ...COUNT_COLUMNS,
      ],
      rows: [
        {
          cells: [
            ...tokenCells(totals, opts),
            ...contextCells(totals, false),
            totals.requests,
            totals.sessions.size,
            totals.projects.size,
            ...countCells(totals),
          ],
        },
      ],
    },
  ];

  const section = (title, columns, entries, toCells) => {
    if (!entries.length) return;
    const shown = top > 0 ? entries.slice(0, top) : entries;
    const note = shown.length < entries.length ? `top ${shown.length} of ${entries.length}` : undefined;
    sections.push({ title, note, columns, rows: shown.map((e) => ({ cells: toCells(e) })) });
  };
  const costCol = showCost ? [right('Cost (USD)')] : [];
  const costCell = (v) => (showCost ? [money(v)] : []);

  // Estimated tokens and cost attributed to each tool / server / skill: input
  // side (result in context + re-reads) and output (the input the model wrote).
  const estCols = [
    right('Input (est.)'),
    right('Output (est.)'),
    right('Tokens (est.)'),
    ...(showCost ? [right('Cost (est.)')] : []),
    right('Token share'),
  ];
  const estCells = (usage) => {
    const u = usage ?? { tokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costUSD: 0 };
    return [
      approx(u.cacheWriteTokens + u.cacheReadTokens),
      approx(u.outputTokens),
      approx(u.tokens),
      ...(showCost ? [money(u.costUSD, { approx: true })] : []),
      share(u.tokens, totals.totalTokens),
    ];
  };

  section(
    'Tools',
    [left('Tool'), right('Calls'), right('Share'), ...estCols],
    ranked(totals.tools),
    ([name, count]) => [name, count, share(count, totals.toolCalls), ...estCells(totals.toolTokens.get(name))],
  );

  section(
    'MCP servers',
    [left('Server'), right('Calls'), ...estCols],
    ranked(totals.mcpServers),
    ([name, count]) => [name, count, ...estCells(totals.mcpServerTokens.get(name))],
  );

  section(
    'Skills',
    [left('Skill'), right('By model'), right('By user'), right('Total'), ...estCols],
    ranked(totals.skills, (s) => s.model + s.user),
    ([name, s]) => [name, s.model, s.user, s.model + s.user, ...estCells(totals.skillTokens.get(name))],
  );

  // Programs run by Bash / PowerShell calls, grouped by purpose. Calls and
  // Share (of that tool's calls) count a call once per purpose.
  if (opts.shell) {
    for (const [name, categories] of totals.shellCategories) {
      const calls = totals.tools.get(name) ?? 0;
      const sessions = new Set([...categories.values()].flatMap((c) => [...c.sessions]));
      sections.push({
        title: `${name} commands`,
        note: `${calls.toLocaleString('en-US')} calls in ${sessions.size} sessions`,
        columns: [
          left('Purpose'),
          right('Calls'),
          right('Share'),
          right('Sessions'),
          ...estCols,
          wrapped('Commands (calls, ~tokens)'),
        ],
        rows: shellCategoryRows(categories).map(([category, c]) => ({
          cells: [
            category,
            c.calls,
            share(c.calls, calls),
            c.sessions.size,
            ...estCells(c),
            categoryCommands(totals.shellCommands.get(name), category, top > 0 ? top : Infinity),
          ],
        })),
      });
    }
  }

  section('Slash commands', [left('Command'), right('Count')], ranked(totals.commands), ([name, count]) => [
    name,
    count,
  ]);

  // Hook runs from the transcripts; Context is what the hook added (estimated, re-reads not counted).
  section(
    'Hooks',
    [
      left('Hook', 60),
      left('Events'),
      right('Runs'),
      right('Failed'),
      right('Failure rate'),
      right('Blocked'),
      right('Avg ms'),
      right('Total s'),
      right('Context (est.)'),
    ],
    ranked(totals.hooks, (h) => h.runs),
    ([name, h]) => [
      name,
      [...h.events].sort().join(', '),
      h.runs,
      h.errors,
      share(h.errors, h.runs),
      h.blocked,
      average(h.durationMs, h.runs),
      Math.round(h.durationMs / 1000),
      approx(h.contextTokens),
    ],
  );

  // Only worth showing when subagents were used at all.
  if (totals.subagentLaunches > 0 || [...totals.agents.keys()].some((k) => k !== MAIN_AGENT)) {
    section(
      'Subagents',
      [
        left('Type'),
        right('Launches'),
        right('Requests'),
        right('Tool calls'),
        right('Input'),
        right('Output'),
        right('Total Tokens'),
        ...costCol,
        right('Token share'),
      ],
      ranked(totals.agents, (a) => a.totalTokens),
      ([name, a]) => [
        name,
        name === MAIN_AGENT ? '' : a.launches,
        a.requests,
        a.toolCalls,
        a.inputTokens + a.cacheCreationTokens + a.cacheReadTokens,
        a.outputTokens,
        a.totalTokens,
        ...costCell(a.costUSD),
        share(a.totalTokens, totals.totalTokens),
      ],
    );
  }

  section(
    'Models',
    [left('Model'), right('Requests'), right('Total Tokens'), ...costCol, right('Share')],
    ranked(totals.models, (m) => m.totalTokens),
    ([name, m]) => [name, m.requests, m.totalTokens, ...costCell(m.costUSD), share(m.totalTokens, totals.totalTokens)],
  );

  return { title: `Claude Code usage summary${rangeText(opts)}`, sections };
}
