// Model pricing from LiteLLM's public price list (the same source ccusage uses),
// cached locally for a day. Falls back to the cache, then to a small built-in
// table, so reports still work offline.

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;

// Snapshot of LiteLLM prices (USD per token), used only when nothing better is available.
const BUILTIN = {
  'claude-opus-5-5': {
    input_cost_per_token: 4e-6,
    output_cost_per_token: 2e-5,
    cache_creation_input_token_cost: 5e-6,
    cache_creation_input_token_cost_above_1hr: 8e-6,
    cache_read_input_token_cost: 2e-7,
  },
  'claude-sonnet-5-5': {
    input_cost_per_token: 2e-6,
    output_cost_per_token: 1e-5,
    cache_creation_input_token_cost: 2.5e-6,
    cache_creation_input_token_cost_above_1hr: 4e-6,
    cache_read_input_token_cost: 1e-7,
  },
  'claude-haiku-5-5': {
    input_cost_per_token: 1e-7,
    output_cost_per_token: 5e-7,
    cache_creation_input_token_cost: 1.25e-7,
    cache_creation_input_token_cost_above_1hr: 2e-7,
    cache_read_input_token_cost: 1e-8,
    input_cost_per_token_above_100k_tokens: 5e-7,
    output_cost_per_token_above_100k_tokens: 2.5e-6,
    cache_creation_input_token_cost_above_100k_tokens: 6.25e-7,
    cache_creation_input_token_cost_above_1hr_above_100k_tokens: 1e-6,
    cache_read_input_token_cost_above_100k_tokens: 5e-8,
  },
};

function cacheFile() {
  const base =
    process.env.XDG_CACHE_HOME ||
    (process.platform === 'win32' && process.env.LOCALAPPDATA) ||
    path.join(homedir(), '.cache');
  return path.join(base, 'ccreports', 'litellm-pricing.json');
}

async function readCache(file) {
  try {
    const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    return { table: JSON.parse(text), ageMs: Date.now() - info.mtimeMs };
  } catch {
    return null;
  }
}

/** Only Claude entries are kept; the full list is several MB. */
function claudeOnly(table) {
  return Object.fromEntries(Object.entries(table).filter(([k]) => k.includes('claude')));
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
      const table = claudeOnly(await res.json());
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

function candidates(model) {
  const plain = model.replace(/\[.*\]$/, ''); // "claude-opus-5-5[1m]"
  const undated = plain.replace(/-\d{8}$/, ''); // "claude-sonnet-4-5-20250929"
  return [...new Set([model, plain, undated, `anthropic/${plain}`, `anthropic/${undated}`, `anthropic.${undated}`])];
}

/** Long-context tier threshold from LiteLLM field names, e.g. "..._above_200k_tokens" -> 200000. */
function tierThreshold(entry) {
  for (const key of Object.keys(entry)) {
    const m = /^input_cost_per_token_above_(\d+)k_tokens$/.exec(key);
    if (m) return { threshold: Number(m[1]) * 1000, suffix: `_above_${m[1]}k_tokens` };
  }
  return null;
}

/**
 * Builds a function that prices one usage record in USD, or returns null when
 * the model has no known price.
 */
export function createPricer(table) {
  const memo = new Map();
  const lookup = (model) => {
    if (!memo.has(model)) {
      const key = candidates(model).find((k) => table[k]?.input_cost_per_token != null);
      memo.set(model, key ? table[key] : null);
    }
    return memo.get(model);
  };

  const pricer = (rec) => {
    const p = lookup(rec.model);
    if (!p) return null;
    const cache1h = rec.cacheCreation1hTokens ?? 0;
    const cache5m = rec.cacheCreationTokens - cache1h;

    // The whole request moves to the long-context tier once its full input
    // (fresh + cached) exceeds the threshold - not just the tokens above it.
    const tier = tierThreshold(p);
    const context = rec.inputTokens + rec.cacheCreationTokens + rec.cacheReadTokens;
    const long = tier && context > tier.threshold;
    const rate = (field) => (long ? p[field + tier.suffix] : undefined) ?? p[field];

    const input = rate('input_cost_per_token');
    const write5m = rate('cache_creation_input_token_cost') ?? input * 1.25;
    const write1h = rate('cache_creation_input_token_cost_above_1hr') ?? input * 2;
    const read = rate('cache_read_input_token_cost') ?? input * 0.1;
    return (
      rec.inputTokens * input +
      rec.outputTokens * rate('output_cost_per_token') +
      cache5m * write5m +
      cache1h * write1h +
      rec.cacheReadTokens * read
    );
  };
  pricer.isPriced = (model) => lookup(model) != null;
  return pricer;
}
