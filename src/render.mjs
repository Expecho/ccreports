// Terminal rendering: box-drawn tables in the style of ccusage.

import { ranked, MAIN_AGENT } from './aggregate.mjs';

let useColor = false;
export function setColor(enabled) {
  useColor = enabled;
}

const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  bold: paint('1'),
  dim: paint('2'),
  cyan: paint('36'),
  yellow: paint('33'),
  green: paint('32'),
};

// eslint-disable-next-line no-control-regex
const visible = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const n = (v) => (v ? Number(v).toLocaleString('en-US') : '0');
const usd = (v) => `$${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : '-');
const truncate = (s, max) => (s.length > max ? s.slice(0, max - 1) + '…' : s);
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

/**
 * @param columns [{ title, align: 'left' | 'right' }]
 * @param rows    arrays of cells; a row object { cells, style } may set 'total' or 'sub'
 */
export function table(columns, rows) {
  const norm = rows.map((r) => (Array.isArray(r) ? { cells: r } : r));
  const widths = columns.map((col, i) =>
    Math.max(visible(col.title).length, ...norm.map((r) => visible(r.cells[i] ?? '').length)),
  );
  const pad = (s, i) => {
    const str = String(s ?? '');
    const gap = ' '.repeat(widths[i] - visible(str).length);
    return columns[i].align === 'right' ? gap + str : str + gap;
  };
  const line = (l, m, r) => c.dim(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r);
  const row = (cells) => c.dim('│') + cells.map((s, i) => ` ${pad(s, i)} `).join(c.dim('│')) + c.dim('│');

  const out = [line('┌', '┬', '┐'), row(columns.map((col) => c.cyan(col.title))), line('├', '┼', '┤')];
  for (const r of norm) {
    if (r.style === 'total') out.push(line('├', '┼', '┤'));
    const styler = r.style === 'total' ? c.yellow : r.style === 'sub' ? c.dim : (s) => s;
    out.push(row(r.cells.map((s) => (s === '' || s == null ? '' : styler(s)))));
  }
  out.push(line('└', '┴', '┘'));
  return out.join('\n');
}

const right = (title) => ({ title, align: 'right' });
const left = (title) => ({ title, align: 'left' });

/** Token (+ optional cost) columns and cells, shared by all tables. */
function tokenColumns({ compact, showCost }) {
  const cols = compact
    ? [right('Input'), right('Output'), right('Total Tokens')]
    : [right('Input'), right('Output'), right('Cache Create'), right('Cache Read'), right('Total Tokens')];
  if (showCost) cols.push(right('Cost (USD)'));
  return cols;
}

function tokenCells(b, { compact, showCost }) {
  const cells = compact
    ? [n(b.inputTokens), n(b.outputTokens), n(b.totalTokens)]
    : [n(b.inputTokens), n(b.outputTokens), n(b.cacheCreationTokens), n(b.cacheReadTokens), n(b.totalTokens)];
  if (showCost) cells.push(usd(b.costUSD));
  return cells;
}

const COUNT_COLUMNS = [right('Tools'), right('Skills'), right('Cmds'), right('Agents')];
const countCells = (b) => [n(b.toolCalls), n(b.skillCalls), n(b.commandCount), n(b.subagentLaunches)];

function shortModel(model) {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

const PERIOD_TITLES = {
  daily: 'Date',
  weekly: 'Week',
  monthly: 'Month',
  project: 'Project',
};

/** daily / weekly / monthly / project / session table. */
export function renderPeriodReport(report, { buckets, totals }, opts) {
  const { breakdown, top, timeZone } = opts;
  const isSession = report === 'session';
  const lead = isSession
    ? [left('Session'), left('Project'), left('Last Activity')]
    : [left(PERIOD_TITLES[report])];
  const columns = [...lead, left('Models'), ...tokenColumns(opts), ...COUNT_COLUMNS];
  const blankLead = lead.map(() => '');
  const emptyTokens = tokenColumns(opts).map(() => '');

  // Sub-row: label in the first column, count under Tools / Skills / Cmds / Agents.
  const subRow = (label, count, col) => {
    const counts = COUNT_COLUMNS.map(() => '');
    counts[col] = n(count);
    const subLead = [...blankLead];
    subLead[0] = `  └ ${truncate(label, 40)}`;
    return { cells: [...subLead, '', ...emptyTokens, ...counts], style: 'sub' };
  };

  const rows = [];
  for (const b of buckets) {
    const models = ranked(b.models, (m) => m.totalTokens).map(([m]) => shortModel(m));
    const leadCells = isSession
      ? [
          truncate(b.title ?? b.key.slice(0, 8), 36),
          truncate([...b.projects][0] ?? '', 30),
          localTime(b.lastActivity, timeZone),
        ]
      : [report === 'project' ? truncate(b.key, 40) : b.key];
    rows.push([...leadCells, truncate(models.join(', '), 28), ...tokenCells(b, opts), ...countCells(b)]);

    if (breakdown) {
      const limit = top > 0 ? top : Infinity;
      for (const [name, count] of ranked(b.tools).slice(0, limit)) rows.push(subRow(`tool ${name}`, count, 0));
      for (const [name, s] of ranked(b.skills, (s) => s.model + s.user).slice(0, limit))
        rows.push(subRow(`skill ${name}`, s.model + s.user, 1));
      for (const [name, count] of ranked(b.commands).slice(0, limit)) rows.push(subRow(`cmd ${name}`, count, 2));
      const launched = [...b.agents].filter(([, a]) => a.launches > 0);
      for (const [name, a] of launched.sort((x, y) => y[1].launches - x[1].launches).slice(0, limit))
        rows.push(subRow(`agent ${name}`, a.launches, 3));
    }
  }

  const totalLead = [...blankLead];
  totalLead[0] = 'Total';
  rows.push({ cells: [...totalLead, '', ...tokenCells(totals, opts), ...countCells(totals)], style: 'total' });
  return table(columns, rows);
}

/** Summary: totals plus ranked tool / MCP / skill / command / subagent / model tables. */
export function renderSummary({ totals }, opts) {
  const { top, since, until, showCost } = opts;
  const out = [];
  const range = since || until ? ` (${since ?? '…'} → ${until ?? 'today'})` : '';
  out.push(c.bold(`Claude Code usage summary${range}`));
  out.push(
    table(
      [...tokenColumns(opts), right('Requests'), right('Sessions'), right('Projects'), ...COUNT_COLUMNS],
      [
        [
          ...tokenCells(totals, opts),
          n(totals.requests),
          n(totals.sessions.size),
          n(totals.projects.size),
          ...countCells(totals),
        ],
      ],
    ),
  );

  const section = (title, columns, entries, toCells) => {
    if (!entries.length) return;
    const shown = top > 0 ? entries.slice(0, top) : entries;
    const more = entries.length - shown.length;
    out.push('', c.bold(title) + (more > 0 ? c.dim(`  (top ${shown.length} of ${entries.length})`) : ''));
    out.push(table(columns, shown.map(toCells)));
  };
  const costCol = showCost ? [right('Cost (USD)')] : [];
  const costCell = (v) => (showCost ? [usd(v)] : []);

  section(
    'Tools',
    [left('Tool'), right('Calls'), right('Share')],
    ranked(totals.tools),
    ([name, count]) => [name, n(count), pct(count, totals.toolCalls)],
  );

  section('MCP servers', [left('Server'), right('Calls')], ranked(totals.mcpServers), ([name, count]) => [
    name,
    n(count),
  ]);

  section(
    'Skills',
    [left('Skill'), right('By model'), right('By user'), right('Total')],
    ranked(totals.skills, (s) => s.model + s.user),
    ([name, s]) => [name, n(s.model), n(s.user), n(s.model + s.user)],
  );

  section('Slash commands', [left('Command'), right('Count')], ranked(totals.commands), ([name, count]) => [
    name,
    n(count),
  ]);

  // Only worth showing when subagents were used at all.
  if (totals.subagentLaunches > 0 || [...totals.agents.keys()].some((k) => k !== MAIN_AGENT)) {
    section(
      'Subagents',
      [
        left('Type'),
        right('Launches'),
        right('Requests'),
        right('Tool calls'),
        right('Total Tokens'),
        ...costCol,
        right('Token share'),
      ],
      ranked(totals.agents, (a) => a.totalTokens),
      ([name, a]) => [
        name,
        name === MAIN_AGENT ? '' : n(a.launches),
        n(a.requests),
        n(a.toolCalls),
        n(a.totalTokens),
        ...costCell(a.costUSD),
        pct(a.totalTokens, totals.totalTokens),
      ],
    );
  }

  section(
    'Models',
    [left('Model'), right('Requests'), right('Total Tokens'), ...costCol, right('Share')],
    ranked(totals.models, (m) => m.totalTokens),
    ([name, m]) => [
      name,
      n(m.requests),
      n(m.totalTokens),
      ...costCell(m.costUSD),
      pct(m.totalTokens, totals.totalTokens),
    ],
  );

  return out.join('\n');
}
