// Builds format-neutral report documents from aggregated buckets. A document is
//   { title, sections: [{ title?, note?, columns, rows }] }
// where a column is { title, align, maxWidth? } and a row is { cells, style? }
// (style 'total' or 'sub'). Cells are raw values - numbers, strings, money() or
// share() - so each output format (src/formats.mjs) decides how to print them.

import { ranked, MAIN_AGENT } from './aggregate.mjs';

export const money = (v) => ({ kind: 'usd', v: v || 0 });
export const share = (part, whole) => ({ kind: 'pct', v: whole ? part / whole : null });

const right = (title) => ({ title, align: 'right' });
const left = (title, maxWidth) => ({ title, align: 'left', maxWidth });

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

function tokenCells(b, { compact, showCost }) {
  const cells = compact
    ? [b.inputTokens, b.outputTokens, b.totalTokens]
    : [b.inputTokens, b.outputTokens, b.cacheCreationTokens, b.cacheReadTokens, b.totalTokens];
  if (showCost) cells.push(money(b.costUSD));
  return cells;
}

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
  const { breakdown, top, timeZone } = opts;
  const isSession = report === 'session';
  const lead = isSession
    ? [left('Session', 36), left('Project', 30), left('Last Activity')]
    : [left(PERIOD[report].title, report === 'project' ? 40 : undefined)];
  const columns = [...lead, left('Models', 28), ...tokenColumns(opts), ...COUNT_COLUMNS];
  const blankLead = lead.map(() => '');
  const emptyTokens = tokenColumns(opts).map(() => '');

  // Sub-row: label in the first column, count under Tools / Skills / Cmds / Agents.
  const subRow = (label, count, col) => {
    const counts = COUNT_COLUMNS.map(() => '');
    counts[col] = count;
    const subLead = [...blankLead];
    subLead[0] = label;
    return { cells: [...subLead, '', ...emptyTokens, ...counts], style: 'sub' };
  };

  const rows = [];
  for (const b of buckets) {
    const models = ranked(b.models, (m) => m.totalTokens).map(([m]) => shortModel(m));
    const leadCells = isSession
      ? [b.title ?? b.key.slice(0, 8), [...b.projects][0] ?? '', localTime(b.lastActivity, timeZone)]
      : [b.key];
    rows.push({ cells: [...leadCells, models.join(', '), ...tokenCells(b, opts), ...countCells(b)] });

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
      columns: [...tokenColumns(opts), right('Requests'), right('Sessions'), right('Projects'), ...COUNT_COLUMNS],
      rows: [
        {
          cells: [
            ...tokenCells(totals, opts),
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

  section('Tools', [left('Tool'), right('Calls'), right('Share')], ranked(totals.tools), ([name, count]) => [
    name,
    count,
    share(count, totals.toolCalls),
  ]);

  section('MCP servers', [left('Server'), right('Calls')], ranked(totals.mcpServers), ([name, count]) => [
    name,
    count,
  ]);

  section(
    'Skills',
    [left('Skill'), right('By model'), right('By user'), right('Total')],
    ranked(totals.skills, (s) => s.model + s.user),
    ([name, s]) => [name, s.model, s.user, s.model + s.user],
  );

  section('Slash commands', [left('Command'), right('Count')], ranked(totals.commands), ([name, count]) => [
    name,
    count,
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
        name === MAIN_AGENT ? '' : a.launches,
        a.requests,
        a.toolCalls,
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
