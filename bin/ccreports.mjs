#!/usr/bin/env node
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadRecords, defaultProjectDirs } from '../src/loader.mjs';
import { loadCopilotRecords, defaultCopilotDirs, mergeData } from '../src/copilot.mjs';
import { loadCursorRecords, defaultCursorDirs } from '../src/cursor.mjs';
import { aggregate, parseDateArg, toJSON, REPORTS } from '../src/aggregate.mjs';
import { buildPeriodReport, buildSummary } from '../src/report.mjs';
import { FORMATS, toTerminal, toMarkdown, toCsv, toHtml } from '../src/formats.mjs';
import { loadPricingTable, createPricer } from '../src/pricing.mjs';
import { buildAdoption, PHASES, AUTONOMY_THRESHOLD } from '../src/adoption.mjs';
import { buildRecommendations } from '../src/recommendations.mjs';
import { openFile, FORMAT_EXTENSIONS } from '../src/open.mjs';
import { loadPlugins, pluginRows, pluginsJSON } from '../src/plugins.mjs';
import { VERSION } from '../src/version.mjs';

const HELP = `ccreports - Claude Code (and GitHub Copilot, Cursor) tool, skill, slash-command and token usage

Usage: ccreports [report] [options]

Reports:
  summary        Totals plus ranked tools, MCP servers, skills, commands, hooks, installed
                 plugins, subagents, models (default). Every report lists installed plugins.
  daily          One row per day
  weekly         One row per ISO week (starting Monday)
  monthly        One row per month
  session        One row per session
  project        One row per project (working directory)
  adoption       Adoption assessment: sessions by phase (chat, assisted, agent-first, multi-agent)
  recommendations  Best-practice recommendations based on your usage, with the cost at stake

Options:
      --source <src>     claude (default), copilot (GitHub Copilot CLI / VS Code agent),
                         cursor (Cursor CLI / editor agent; activity only, no tokens) or all
  -s, --since <date>     Include from this date (YYYYMMDD or YYYY-MM-DD)
  -u, --until <date>     Include up to and including this date
  -p, --project <text>   Only projects whose path contains <text> (case-insensitive)
  -b, --breakdown        Per-row tool / skill / command / agent sub-rows (period reports)
  -x, --shell            Programs run by Bash / PowerShell calls (summary tables, sub-rows in period reports)
  -a, --adoption         Append the adoption assessment to the report
  -r, --recommendations  Append best-practice recommendations to the report
  -n, --top <n>          Rows per ranked list (default 15 summary, 5 breakdown; 0 = all)
  -f, --format <fmt>     table (default), json, csv, markdown (md) or html
  -j, --json             Same as --format json
  -o, --output <file>    Write to a file instead of stdout (opened when run from a terminal)
      --open             Open the report in its associated app (a temp file without -o)
      --no-open          Don't open the file written with -o
      --order <asc|desc> Row order for period reports (default asc)
      --timezone <tz>    Timezone for date grouping (default: system)
      --no-cost          Skip cost estimates
      --offline          Use cached (or built-in) pricing; never fetch
      --no-subagents     Exclude subagent transcripts
      --compact          Hide cache token columns (table format)
      --no-color         Disable colors (also honors NO_COLOR)
      --dir <path>       Projects directory to scan (repeatable; default from CLAUDE_CONFIG_DIR or ~/.claude)
      --copilot-dir <path>  Copilot session-state directory (repeatable; default from COPILOT_HOME or ~/.copilot)
      --cursor-dir <path>   Cursor config directory (repeatable; default from CURSOR_CONFIG_DIR or ~/.cursor)
  -v, --version          Show the ccreports version
  -h, --help             Show this help
`;

function fail(message) {
  console.error(`ccreports: ${message}`);
  process.exit(1);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      since: { type: 'string', short: 's' },
      until: { type: 'string', short: 'u' },
      project: { type: 'string', short: 'p' },
      breakdown: { type: 'boolean', short: 'b' },
      shell: { type: 'boolean', short: 'x' },
      adoption: { type: 'boolean', short: 'a' },
      recommendations: { type: 'boolean', short: 'r' },
      top: { type: 'string', short: 'n' },
      format: { type: 'string', short: 'f' },
      json: { type: 'boolean', short: 'j' },
      output: { type: 'string', short: 'o' },
      open: { type: 'boolean' },
      'no-open': { type: 'boolean' },
      order: { type: 'string' },
      timezone: { type: 'string' },
      'no-subagents': { type: 'boolean' },
      'no-cost': { type: 'boolean' },
      offline: { type: 'boolean' },
      compact: { type: 'boolean' },
      'no-color': { type: 'boolean' },
      dir: { type: 'string', multiple: true },
      source: { type: 'string' },
      'copilot-dir': { type: 'string', multiple: true },
      'cursor-dir': { type: 'string', multiple: true },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (err) {
  fail(err.message);
}

const { values: opts, positionals } = parsed;
if (opts.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (opts.version) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const report = positionals[0] ?? 'summary';
if (!REPORTS.includes(report)) fail(`unknown report "${report}". Expected one of: ${REPORTS.join(', ')}`);
if (positionals.length > 1) fail(`unexpected argument "${positionals[1]}"`);
if (opts.order && !['asc', 'desc'].includes(opts.order)) fail('--order must be asc or desc');
const source = (opts.source ?? 'claude').toLowerCase();
if (!['claude', 'copilot', 'cursor', 'all'].includes(source)) fail('--source must be claude, copilot, cursor or all');

let format = opts.json ? 'json' : (opts.format ?? 'table').toLowerCase();
if (format === 'md') format = 'markdown';
if (!FORMATS.includes(format)) fail(`unknown format "${opts.format}". Expected one of: ${FORMATS.join(', ')}, md`);
if (opts.json && opts.format && opts.format !== 'json') fail('--json conflicts with --format');

let since, until, top;
try {
  since = parseDateArg(opts.since, '--since');
  until = parseDateArg(opts.until, '--until');
} catch (err) {
  fail(err.message);
}
if (opts.top !== undefined) {
  top = Number.parseInt(opts.top, 10);
  if (!Number.isInteger(top) || top < 0) fail('--top must be a non-negative integer');
} else {
  top = opts.breakdown || (opts.shell && report !== 'summary') ? 5 : 15;
}
if (opts.timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: opts.timezone });
  } catch {
    fail(`unknown timezone "${opts.timezone}"`);
  }
}

const toTTY = !opts.output && !opts.open && process.stdout.isTTY;

const includeSubagents = !opts['no-subagents'];
const dirs = opts.dir?.length ? opts.dir : defaultProjectDirs();
const copilotDirs = opts['copilot-dir']?.length ? opts['copilot-dir'] : defaultCopilotDirs();
const cursorDirs = opts['cursor-dir']?.length ? opts['cursor-dir'] : defaultCursorDirs();
const wants = (src) => source === src || source === 'all';
const claudeData = wants('claude') ? await loadRecords({ dirs, includeSubagents }) : null;
const copilotData = wants('copilot') ? await loadCopilotRecords({ dirs: copilotDirs, includeSubagents }) : null;
const cursorData = wants('cursor') ? await loadCursorRecords({ dirs: cursorDirs, includeSubagents }) : null;
const loaded = [claudeData, copilotData, cursorData].filter(Boolean);
const data = loaded.length > 1 ? mergeData(...loaded) : loaded[0];
if (data.files === 0) {
  const scanned = [...(claudeData ? dirs : []), ...(copilotData ? copilotDirs : []), ...(cursorData ? cursorDirs : [])];
  fail(`no ${source === 'claude' ? 'transcripts' : 'sessions'} found in: ${scanned.join(', ')}`);
}
const product = {
  claude: 'Claude Code',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor',
  all: 'Claude Code, GitHub Copilot and Cursor',
}[source];

// Cursor logs no token usage: its own reports leave out cost, and combined
// ones count its sessions in activity only.
const showCost = !opts['no-cost'] && source !== 'cursor';
if (source === 'all' && cursorData?.files) {
  console.error('ccreports: Cursor logs no token usage; its sessions count in activity (prompts, tools, skills) only.');
}
let pricer, pricingSource;
if (showCost) {
  const pricing = await loadPricingTable({ offline: opts.offline });
  pricer = createPricer(pricing.table);
  pricingSource = pricing.source;
}

const result = aggregate(data, { report, since, until, project: opts.project, timeZone: opts.timezone, pricer });
if (opts.order === 'desc') result.buckets.reverse();

// Warnings go to stderr so redirected output stays clean.
if (showCost) {
  if (pricingSource === 'builtin') {
    console.error('ccreports: Anthropic pricing page unavailable, using built-in prices (may be out of date).');
  }
  const unpriced = [...result.totals.unpricedModels];
  if (unpriced.length) console.error(`ccreports: no price for ${unpriced.join(', ')}; counted as $0.`);
}

// Installed plugins and what of each was used, in every report.
// (Claude Code plugins only.)
const plugins = claudeData ? pluginRows(await loadPlugins(dirs), result.totals, { project: opts.project }) : [];

// Only the terminal table hides columns to fit the screen.
const compact = format === 'table' && (opts.compact || (toTTY && process.stdout.columns < 120));
const docOpts = {
  compact,
  showCost,
  breakdown: opts.breakdown,
  shell: opts.shell,
  top,
  since,
  until,
  timeZone: opts.timezone,
  project: opts.project,
  pricer,
  plugins,
  product,
  // No token usage at all (Cursor alone): reports leave out the token columns.
  tokens: data.usage.length > 0,
};

// The adoption assessment and recommendations: their own reports, or appended
// to another with --adoption / --recommendations.
const adoption = report === 'adoption' || opts.adoption ? buildAdoption(data, docOpts) : null;
// Recommendations per product: each names its own settings and commands, and
// is weighed against that product's own cost.
let advice = null;
if (report === 'recommendations' || opts.recommendations) {
  const parts = [
    ['claude', claudeData],
    ['copilot', copilotData],
    ['cursor', cursorData],
  ]
    .filter(([, d]) => d?.files)
    .map(([src, d]) => ({ src, doc: buildRecommendations(d, { ...docOpts, source: src }) }));
  advice =
    parts.length === 1
      ? { ...parts[0].doc, items: parts[0].doc.items.map((i) => ({ ...i, source: parts[0].src })) }
      : {
          title: `${product} recommendations`,
          summary: parts.filter((p) => !p.doc.items.length).map((p) => `${p.doc.title.replace(/ recommendations.*/, '')}: ${p.doc.summary[0]}`),
          sections: parts.flatMap((p) => p.doc.sections.map((s) => ({ ...s, title: p.doc.title }))),
          items: parts.flatMap((p) => p.doc.items.map((i) => ({ ...i, source: p.src }))),
        };
}

let output;
if (format === 'json') {
  const meta = { report, source, since, until, pricingSource, ccreportsVersion: VERSION };
  const adoptionJson = adoption && {
    summary: adoption.summary,
    phases: PHASES,
    autonomyThreshold: AUTONOMY_THRESHOLD,
    sessions: adoption.stats,
  };
  let json;
  if (report === 'adoption') {
    json = { ...meta, ...adoptionJson };
  } else if (report === 'recommendations') {
    json = { ...meta, recommendations: advice.items };
  } else if (report === 'summary') {
    json = { ...meta, totals: toJSON(result.totals), plugins: pluginsJSON(plugins) };
  } else {
    json = { ...meta, rows: result.buckets.map(toJSON), totals: toJSON(result.totals), plugins: pluginsJSON(plugins) };
  }
  if (adoptionJson && report !== 'adoption') json.adoption = adoptionJson;
  if (advice && report !== 'recommendations') json.recommendations = advice.items;
  output = JSON.stringify(json, null, 2) + '\n';
} else if (result.totals.sessions.size === 0) {
  fail('no usage found for the selected filters.');
} else {
  const own = { adoption, recommendations: advice }[report];
  let doc = own ?? (report === 'summary' ? buildSummary(result, docOpts) : buildPeriodReport(report, result, docOpts));
  // Appended parts: their summary lines on top, their sections after the report's own.
  for (const part of [adoption, advice]) {
    if (!part || part === doc) continue;
    doc = { ...doc, summary: [...(doc.summary ?? []), ...part.summary], sections: [...doc.sections, ...part.sections] };
  }
  output = {
    table: () => toTerminal(doc, { color: toTTY && !opts['no-color'] && !process.env.NO_COLOR, version: VERSION }) + '\n',
    markdown: () => toMarkdown(doc, { version: VERSION }),
    csv: () => toCsv(doc),
    html: () => toHtml(doc, { pricingSource, version: VERSION, copilot: !!copilotData }),
  }[format]();
}

// Opening the file: --open forces it (to a temp file when there is no -o),
// --no-open prevents it, and by default a file written with -o opens when run
// from a terminal - not from scripts, CI or an agent.
const open = opts.open || (!opts['no-open'] && opts.output && process.stderr.isTTY && !process.env.CI);
let file = opts.output;
if (!file && open) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ccreports-'));
  file = path.join(dir, `${report}${FORMAT_EXTENSIONS[format]}`);
}

if (file) {
  // Excel only reads a CSV as UTF-8 when it starts with a byte order mark.
  await writeFile(file, format === 'csv' ? '﻿' + output : output);
  console.error(`ccreports: wrote ${file}`);
  if (open) {
    const error = await openFile(file);
    if (error) console.error(`ccreports: could not open ${file}: ${error}`);
  }
} else {
  process.stdout.write(output);
}
