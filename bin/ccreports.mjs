#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadRecords, defaultProjectDirs } from '../src/loader.mjs';
import { aggregate, parseDateArg, toJSON, REPORTS } from '../src/aggregate.mjs';
import { renderPeriodReport, renderSummary, setColor } from '../src/render.mjs';
import { loadPricingTable, createPricer } from '../src/pricing.mjs';

const HELP = `ccreports - Claude Code tool, skill, slash-command and token usage

Usage: ccreports [report] [options]

Reports:
  summary        Totals plus ranked tools, MCP servers, skills, commands, models (default)
  daily          One row per day
  weekly         One row per ISO week (starting Monday)
  monthly        One row per month
  session        One row per session
  project        One row per project (working directory)

Options:
  -s, --since <date>     Include from this date (YYYYMMDD or YYYY-MM-DD)
  -u, --until <date>     Include up to and including this date
  -p, --project <text>   Only projects whose path contains <text> (case-insensitive)
  -b, --breakdown        Per-row tool / skill / command sub-rows (period reports)
  -n, --top <n>          Rows per ranked list (default 15 summary, 5 breakdown; 0 = all)
  -j, --json             Output JSON
      --order <asc|desc> Row order for period reports (default asc)
      --timezone <tz>    Timezone for date grouping (default: system)
      --no-cost          Skip cost estimates
      --offline          Use cached (or built-in) pricing; never fetch
      --no-subagents     Exclude subagent transcripts
      --compact          Hide cache token columns
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
      top: { type: 'string', short: 'n' },
      json: { type: 'boolean', short: 'j' },
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

setColor(!opts.json && !opts['no-color'] && !process.env.NO_COLOR && process.stdout.isTTY);

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

if (showCost && !opts.json) {
  if (pricingSource === 'builtin') {
    console.error('ccreports: pricing list unavailable, using built-in prices (may be out of date).');
  }
  const unpriced = [...result.totals.unpricedModels];
  if (unpriced.length) console.error(`ccreports: no price for ${unpriced.join(', ')}; counted as $0.`);
}

if (opts.json) {
  const meta = { report, since, until, pricingSource };
  const json =
    report === 'summary'
      ? { ...meta, totals: toJSON(result.totals) }
      : { ...meta, rows: result.buckets.map(toJSON), totals: toJSON(result.totals) };
  process.stdout.write(JSON.stringify(json, null, 2) + '\n');
} else {
  const compact = opts.compact || (process.stdout.isTTY && process.stdout.columns < 120);
  const renderOpts = { compact, showCost, breakdown: opts.breakdown, top, since, until, timeZone: opts.timezone };
  if (result.totals.sessions.size === 0) {
    console.log('No usage found for the selected filters.');
  } else if (report === 'summary') {
    console.log(renderSummary(result, renderOpts));
  } else {
    console.log(renderPeriodReport(report, result, renderOpts));
  }
}
