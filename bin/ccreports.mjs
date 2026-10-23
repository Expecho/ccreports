#!/usr/bin/env node
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadRecords, defaultProjectDirs } from '../src/loader.mjs';
import { aggregate, parseDateArg, toJSON, REPORTS } from '../src/aggregate.mjs';
import { buildPeriodReport, buildSummary } from '../src/report.mjs';
import { FORMATS, toTerminal, toMarkdown, toCsv, toHtml } from '../src/formats.mjs';
import { loadPricingTable, createPricer } from '../src/pricing.mjs';
import { buildAdoption, PHASES, AUTONOMY_THRESHOLD } from '../src/adoption.mjs';
import { buildRecommendations } from '../src/recommendations.mjs';
import { openFile, FORMAT_EXTENSIONS } from '../src/open.mjs';

const HELP = `ccreports - Claude Code tool, skill, slash-command and token usage

Usage: ccreports [report] [options]

Reports:
  summary        Totals plus ranked tools, MCP servers, skills, commands, hooks, subagents, models (default)
  daily          One row per day
  weekly         One row per ISO week (starting Monday)
  monthly        One row per month
  session        One row per session
  project        One row per project (working directory)
  adoption       Adoption assessment: sessions by phase (chat, assisted, agent-first, multi-agent)
  recommendations  Best-practice recommendations based on your usage, with the cost at stake

Options:
  -s, --since <date>     Include from this date (YYYYMMDD or YYYY-MM-DD)
  -u, --until <date>     Include up to and including this date
  -p, --project <text>   Only projects whose path contains <text> (case-insensitive)
  -b, --breakdown        Per-row tool / skill / command / agent sub-rows (period reports)
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

const report = positionals[0] ?? 'summary';
if (!REPORTS.includes(report)) fail(`unknown report "${report}". Expected one of: ${REPORTS.join(', ')}`);
if (positionals.length > 1) fail(`unexpected argument "${positionals[1]}"`);
if (opts.order && !['asc', 'desc'].includes(opts.order)) fail('--order must be asc or desc');

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
  top = opts.breakdown ? 5 : 15;
}
if (opts.timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: opts.timezone });
  } catch {
    fail(`unknown timezone "${opts.timezone}"`);
  }
}

const toTTY = !opts.output && !opts.open && process.stdout.isTTY;

const dirs = opts.dir?.length ? opts.dir : defaultProjectDirs();
const data = await loadRecords({ dirs, includeSubagents: !opts['no-subagents'] });
if (data.files === 0) fail(`no transcripts found in: ${dirs.join(', ')}`);

const showCost = !opts['no-cost'];
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

// Only the terminal table hides columns to fit the screen.
const compact = format === 'table' && (opts.compact || (toTTY && process.stdout.columns < 120));
const docOpts = {
  compact,
  showCost,
  breakdown: opts.breakdown,
  top,
  since,
  until,
  timeZone: opts.timezone,
  project: opts.project,
  pricer,
};

// The adoption assessment and recommendations: their own reports, or appended
// to another with --adoption / --recommendations.
const adoption = report === 'adoption' || opts.adoption ? buildAdoption(data, docOpts) : null;
const advice = report === 'recommendations' || opts.recommendations ? buildRecommendations(data, docOpts) : null;

let output;
if (format === 'json') {
  const meta = { report, since, until, pricingSource };
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
    json = { ...meta, totals: toJSON(result.totals) };
  } else {
    json = { ...meta, rows: result.buckets.map(toJSON), totals: toJSON(result.totals) };
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
    table: () => toTerminal(doc, { color: toTTY && !opts['no-color'] && !process.env.NO_COLOR }) + '\n',
    markdown: () => toMarkdown(doc),
    csv: () => toCsv(doc),
    html: () => toHtml(doc, { pricingSource }),
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
