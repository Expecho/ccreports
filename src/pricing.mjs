// Model pricing from Anthropic's official Claude API pricing page, parsed and
// cached locally for a day. Falls back to the cache, then to a built-in
// snapshot of the same page, so reports still work offline.

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;

// Modifiers from the same page (not in its model table).
const US_INFERENCE_MULTIPLIER = 1.1; // inference_geo "us", Claude 4.6+ models
const WEB_SEARCH_USD_PER_SEARCH = 10 / 1000;

// Snapshot of the pricing page (USD per million tokens), used only when the
// page can't be fetched or parsed.
const p = (input, cacheWrite5m, cacheWrite1h, cacheRead, output) => ({
  input,
  cacheWrite5m,
  cacheWrite1h,
  cacheRead,
  output,
});
export const BUILTIN = {
  'claude-fable-5-1': p(10, 12.5, 20, 0.25, 50),
  'claude-mythos-5-1': p(10, 12.5, 20, 0.25, 50),
  'claude-fable-5': p(10, 12.5, 20, 1, 50),
  'claude-mythos-5': p(10, 12.5, 20, 1, 50),
  'claude-opus-5-5': { ...p(4, 5, 8, 0.2, 20), fast: { input: 8, output: 40 } },
  'claude-opus-5': { ...p(5, 6.25, 10, 0.5, 25), fast: { input: 10, output: 50 } },
  'claude-opus-4-8': { ...p(5, 6.25, 10, 0.5, 25), fast: { input: 10, output: 50 } },
  'claude-opus-4-7': p(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-6': p(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-5': p(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-1': p(15, 18.75, 30, 1.5, 75),
  'claude-opus-4': p(15, 18.75, 30, 1.5, 75),
  'claude-sonnet-5-5': p(2, 2.5, 4, 0.1, 10),
  'claude-sonnet-5': p(2, 2.5, 4, 0.2, 10),
  'claude-sonnet-4-6': p(3, 3.75, 6, 0.3, 15),
  'claude-sonnet-4-5': p(3, 3.75, 6, 0.3, 15),
  'claude-sonnet-4': p(3, 3.75, 6, 0.3, 15),
  'claude-haiku-5-5': { ...p(0.1, 0.125, 0.2, 0.01, 0.5), longContext: { threshold: 100_000, ...p(0.5, 0.625, 1, 0.05, 2.5) } },
  'claude-haiku-4-5': p(1, 1.25, 2, 0.1, 5),
  'claude-haiku-3-5': p(0.8, 1, 1.6, 0.08, 4),
};

/** "Claude Opus 5.5 ([limited availability](...))" -> "claude-opus-5-5" */
function modelIdFromName(name) {
  return name
    .replace(/\(.*$/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s.]+/g, '-');
}

const dollars = (cell) => {
  const m = /\$\s*([\d.,]+)/.exec(cell);
  return m ? Number(m[1].replace(/,/g, '')) : NaN;
};

function tableRows(markdown, heading) {
  const start = markdown.indexOf(heading);
  if (start < 0) return [];
  const rest = markdown.slice(start + heading.length);
  const end = rest.search(/\n#{2,3} /);
  return (end < 0 ? rest : rest.slice(0, end))
    .split('\n')
    .filter((l) => /^\|\s*Claude/.test(l))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
}

/**
 * Parses the "Model pricing" and "Fast mode pricing" tables of the pricing page.
 * Throws when the page no longer looks like it did, so callers fall back.
 */
export function parsePricingPage(markdown) {
  const table = {};
  for (const cells of tableRows(markdown, '## Model pricing')) {
    if (cells.length < 6) continue;
    const prices = p(...[1, 2, 3, 4, 5].map((i) => dollars(cells[i])));
    if (Object.values(prices).some(Number.isNaN)) continue;
    const id = modelIdFromName(cells[0]);
    // Haiku 5.5 has two rows: "(for prompts up to 100,000 tokens)" / "(... over 100,000 tokens)".
    const tier = /prompts (up to|over) ([\d,]+) tokens/.exec(cells[0]);
    if (tier?.[1] === 'over') {
      table[id] = { ...table[id], longContext: { threshold: Number(tier[2].replace(/,/g, '')), ...prices } };
    } else {
      table[id] = { ...prices, ...(table[id]?.longContext && { longContext: table[id].longContext }) };
    }
  }
  for (const cells of tableRows(markdown, '### Fast mode pricing')) {
    const fast = { input: dollars(cells[1]), output: dollars(cells[2]) };
    if (Number.isNaN(fast.input) || Number.isNaN(fast.output)) continue;
    // "Claude Opus 5 / Claude Opus 4.8" covers two models.
    for (const name of cells[0].split('/')) {
      const id = modelIdFromName(name);
      if (table[id]) table[id].fast = fast;
    }
  }
  if (!table['claude-opus-5-5'] || Object.keys(table).length < 5) {
    throw new Error('pricing page format not recognized');
  }
  return table;
}

function cacheFile() {
  const base =
    process.env.XDG_CACHE_HOME ||
    (process.platform === 'win32' && process.env.LOCALAPPDATA) ||
    path.join(homedir(), '.cache');
  return path.join(base, 'ccreports', 'anthropic-pricing.json');
}

async function readCache(file) {
  try {
    const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    return { table: JSON.parse(text), ageMs: Date.now() - info.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{ source: 'live' | 'cache' | 'builtin', table: object }>}
 */
export async function loadPricingTable({ offline = false } = {}) {
  const file = cacheFile();
  const cached = await readCache(file);
  if (cached && (offline || cached.ageMs < MAX_CACHE_AGE_MS)) return { source: 'cache', table: cached.table };
  if (!offline) {
    try {
      const res = await fetch(PRICING_URL, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const table = parsePricingPage(await res.text());
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(table));
      return { source: 'live', table };
    } catch {
      // fall through to stale cache / builtin
    }
  }
  if (cached) return { source: 'cache', table: cached.table };
  return { source: 'builtin', table: BUILTIN };
}

/** Pricing-table keys to try for a model id as it appears in the transcripts. */
function candidates(model) {
  const plain = model.replace(/\[.*\]$/, ''); // "claude-opus-5-5[1m]"
  const undated = plain.replace(/-\d{8}$/, ''); // "claude-haiku-4-5-20251001"
  const legacy = undated.replace(/^claude-(\d+)-(\d+)-([a-z]+)$/, 'claude-$3-$1-$2'); // "claude-3-5-haiku"
  return [...new Set([plain, undated, legacy])];
}

/**
 * Builds a function that prices one usage record in USD, or returns null when
 * the model has no known price.
 */
export function createPricer(table) {
  const memo = new Map();
  const lookup = (model) => {
    if (!memo.has(model)) {
      const key = candidates(model).find((k) => table[k]);
      memo.set(model, key ? table[key] : null);
    }
    return memo.get(model);
  };

  const pricer = (rec) => {
    const base = lookup(rec.model);
    if (!base) return null;

    // A Haiku 5.5 request over the threshold pays the higher prices for all of
    // its tokens; the prompt length counts cache reads and writes too.
    const prompt = rec.inputTokens + rec.cacheCreationTokens + rec.cacheReadTokens;
    let rates = base.longContext && prompt > base.longContext.threshold ? base.longContext : base;

    // Fast mode replaces input/output prices; cache multipliers apply on top.
    if (rec.speed === 'fast' && base.fast) {
      const readRatio = rates.cacheRead / rates.input;
      rates = {
        input: base.fast.input,
        output: base.fast.output,
        cacheWrite5m: base.fast.input * 1.25,
        cacheWrite1h: base.fast.input * 2,
        cacheRead: base.fast.input * readRatio,
      };
    }

    const cache1h = rec.cacheCreation1hTokens ?? 0;
    const cache5m = rec.cacheCreationTokens - cache1h;
    let tokens =
      (rec.inputTokens * rates.input +
        rec.outputTokens * rates.output +
        cache5m * rates.cacheWrite5m +
        cache1h * rates.cacheWrite1h +
        rec.cacheReadTokens * rates.cacheRead) /
      1e6;
    if (rec.inferenceGeo === 'us') tokens *= US_INFERENCE_MULTIPLIER;
    return tokens + (rec.webSearchRequests ?? 0) * WEB_SEARCH_USD_PER_SEARCH;
  };
  pricer.isPriced = (model) => lookup(model) != null;
  return pricer;
}
