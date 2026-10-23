// Best-practice recommendations derived from the usage data. Each rule looks for
// one pattern, and only fires when the data clearly shows it; a recommendation
// carries its evidence and, where it can be priced, the cost at stake.

import { aggregate, recordFilter, MAIN_AGENT } from './aggregate.mjs';
import { sessionStats } from './adoption.mjs';

const LONG_CONTEXT = 200_000; // tokens of context per request
const PEAK_CONTEXT = 400_000; // a session peak worth calling out
const HEAVY_TOOL_SHARE = 0.1; // share of all tokens one tool's results may take
const EXPENSIVE_CALL = 200_000; // tokens per call for an outlier tool
const EXPLORATION_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
const PREMIUM_MODEL = /opus|fable|mythos/;
const CHEAPER_MODEL = 'claude-sonnet-5-5';
const MIN_HOOK_FAILURES = 10; // failures before a hook is called out

// Tool-specific advice for a tool whose results take a large share of tokens.
const TOOL_ADVICE = {
  Bash: 'Keep command output short: pipe through `head`, `tail` or `grep`, use quiet flags (`-q`, `--silent`), and show only failing tests. Every line of output stays in the context and is re-sent with each later request.',
  PowerShell:
    'Keep command output short: `Select-Object -First`, `Select-String`, quiet switches, and show only failing tests. Every line of output stays in the context and is re-sent with each later request.',
  Read: 'Find the right place with Grep first, then read that range (offset/limit) rather than whole files; let an Explore subagent scan large files and report back.',
  Write: 'Use Edit for changes to existing files instead of rewriting them with Write, and keep generated files small: the whole content is written as output tokens and then stays in the context.',
  Edit: 'Large replacements stay in the context; for sweeping rewrites, hand the work to a subagent so the main conversation only keeps the summary.',
  Agent: 'Ask subagents for short, structured answers (a list of findings, file paths) instead of long reports: their final message is what lands in your context.',
  Skill: 'Keep skills lean: put detailed instructions and examples in reference files the skill reads only when needed, since the whole SKILL.md is loaded into the context each time it runs.',
};
const DEFAULT_TOOL_ADVICE =
  'Its results are large: check whether the tool supports filters, fields or pagination, or call it from a subagent so only a summary reaches your conversation.';

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const pct = (v) => `${Math.round(v * 100)}%`;
const usd = (v) => `$${v.toFixed(2)}`;

/**
 * @returns {{ id, title, impact: 'high'|'medium'|'low', atStakeUSD: number|null, atStakeTokens?: number, evidence: string, advice: string }[]}
 */
export function recommend(data, opts = {}) {
  const { pricer } = opts;
  const inRange = recordFilter(opts);
  const usage = data.usage.filter(inRange);
  if (!usage.length) return [];
  const { totals } = aggregate(data, { ...opts, report: 'summary' });
  const stats = sessionStats(data, opts);
  const costOf = (rec) => (pricer ? pricer(rec) ?? 0 : 0);
  const totalCost = totals.costUSD;
  const recs = [];
  // Money where we can price it, else a share of tokens.
  const stake = (cost, tokens) => (pricer ? usd(cost) : `${tok(tokens)} tokens`);

  // 1. Long contexts: every request re-sends the whole conversation.
  {
    let longCost = 0;
    let longTokens = 0;
    for (const r of usage) {
      const context = r.inputTokens + r.cacheCreationTokens + r.cacheReadTokens;
      if (context > LONG_CONTEXT) {
        longCost += costOf(r);
        longTokens += context + r.outputTokens;
      }
    }
    const share = pricer ? longCost / (totalCost || 1) : longTokens / (totals.totalTokens || 1);
    const peaks = [...totals.sessionPeaks.values()];
    const bigSessions = peaks.filter((p) => p > PEAK_CONTEXT).length;
    if (share >= 0.25 && peaks.length) {
      recs.push({
        id: 'long-context',
        title: 'Keep conversations short',
        atStakeUSD: pricer ? longCost : null,
        atStakeTokens: longTokens,
        evidence: `${pct(share)} of your ${pricer ? 'cost' : 'tokens'} (${stake(longCost, longTokens)}) came from requests carrying more than ${tok(LONG_CONTEXT)} tokens of context; ${bigSessions} session${bigSessions === 1 ? '' : 's'} peaked above ${tok(PEAK_CONTEXT)} (largest ${tok(Math.max(...peaks))}).`,
        advice:
          'Start a new session, or `/clear`, when you switch tasks, and `/compact` with a hint of what to keep when a long task has to continue. Each request re-sends the whole context, so a turn at 400k tokens costs about ten times one at 40k.',
      });
    }
  }

  // 2-3. Tools whose results take a large share of all tokens, or cost a lot per
  // call: one recommendation each, most tokens first, at most four.
  const heavyTools = [...totals.toolTokens]
    .filter(([name, t]) => {
      const calls = totals.tools.get(name) ?? 0;
      return t.tokens > 0 && calls > 0 && (t.tokens / (totals.totalTokens || 1) >= HEAVY_TOOL_SHARE || t.tokens / calls >= EXPENSIVE_CALL);
    })
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, 4);
  for (const [name, t] of heavyTools) {
    const calls = totals.tools.get(name);
    const share = t.tokens / (totals.totalTokens || 1);
    recs.push({
      id: `heavy-tool:${name}`,
      title: TOOL_ADVICE[name] ? `Trim what ${name} puts into the context` : `Rein in ${name}'s large results`,
      atStakeUSD: pricer ? t.costUSD : null,
      atStakeTokens: t.tokens,
      evidence: `${name}: ${fmt(calls)} call${calls === 1 ? '' : 's'}, ~${tok(t.tokens)} tokens (${pct(share)} of all tokens${pricer ? `, ~${usd(t.costUSD)}` : ''}), ~${tok(t.tokens / calls)} per call including re-reads.`,
      advice: TOOL_ADVICE[name] ?? DEFAULT_TOOL_ADVICE,
    });
  }

  // 4. Exploration in the main conversation while subagents are little used.
  {
    let tokens = 0;
    for (const t of data.tools) {
      if (t.agent || !EXPLORATION_TOOLS.has(t.name) || !t.tokens || !inRange(t)) continue;
      tokens += t.tokens.total;
    }
    // The tool totals include subagents' calls; prorate their cost to the main conversation's share.
    const exploreTotals = [...EXPLORATION_TOOLS].map((n) => totals.toolTokens.get(n)).filter(Boolean);
    const allTokens = exploreTotals.reduce((s, t) => s + t.tokens, 0);
    const allCost = exploreTotals.reduce((s, t) => s + t.costUSD, 0);
    const cost = allTokens ? (allCost * tokens) / allTokens : 0;
    const share = tokens / (totals.totalTokens || 1);
    const main = totals.agents.get(MAIN_AGENT)?.totalTokens ?? 0;
    const subagentShare = 1 - main / (totals.totalTokens || 1);
    if (share >= 0.12 && subagentShare < 0.25) {
      recs.push({
        id: 'delegate-exploration',
        title: 'Delegate codebase exploration to subagents',
        atStakeUSD: pricer ? cost : null,
        atStakeTokens: tokens,
        evidence: `Reading and searching files in your main conversation took ~${tok(tokens)} tokens (${pct(share)} of all), while subagents handled ${pct(subagentShare)} of your tokens.`,
        advice:
          'Ask Claude to use an Explore subagent for "find where…" and "how does … work" questions: it reads in its own context and returns a summary, so the file contents never stay in your main conversation.',
      });
    }
  }

  // 5. Subagents on a premium model: reprice their requests on Sonnet.
  if (pricer) {
    const byType = new Map();
    for (const r of usage) {
      // Forks share the parent's context and model, so they can't run on another one.
      if (!r.agent || r.agent === 'fork' || !PREMIUM_MODEL.test(r.model)) continue;
      const cost = costOf(r);
      const cheaper = pricer({ ...r, model: CHEAPER_MODEL }) ?? cost;
      const e = byType.get(r.agent) ?? { model: r.model, cost: 0, savings: 0 };
      e.cost += cost;
      e.savings += cost - cheaper;
      byType.set(r.agent, e);
    }
    const savings = [...byType.values()].reduce((s, e) => s + e.savings, 0);
    const subagentCost = [...totals.agents].filter(([k]) => k !== MAIN_AGENT).reduce((s, [, a]) => s + a.costUSD, 0);
    if (savings >= 1 && savings >= 0.1 * subagentCost) {
      const top = [...byType].sort((a, b) => b[1].cost - a[1].cost).slice(0, 4);
      recs.push({
        id: 'subagent-model',
        title: 'Run routine subagents on a cheaper model',
        atStakeUSD: savings,
        evidence: `Subagents on ${[...new Set(top.map(([, e]) => e.model))].join(' / ')}: ${top.map(([type, e]) => `${type} ${usd(e.cost)}`).join(', ')}. The same requests on Claude Sonnet 5.5 would have cost about ${usd(savings)} less.`,
        advice:
          'Set `model: sonnet` in the definition of your own agents that do routine work (`.claude/agents/<name>.md`), or `model: haiku` for search-only agents such as scouts. For built-in agents like general-purpose, ask Claude to delegate with a cheaper model (the Agent tool takes one). Keep the most capable model for agents that need deep reasoning.',
      });
    }
  }

  // 6. Sessions that ran into auto-compaction.
  {
    const compacted = stats.filter((s) => (data.sessions.get(s.id)?.compactions.size ?? 0) > 0);
    const count = compacted.reduce((s, x) => s + data.sessions.get(x.id).compactions.size, 0);
    if (compacted.length >= 3 || (stats.length && compacted.length / stats.length >= 0.1 && compacted.length >= 1)) {
      recs.push({
        id: 'compaction',
        title: 'Split long tasks before the context fills up',
        atStakeUSD: null,
        evidence: `${compacted.length} of ${stats.length} sessions hit compaction (${count} time${count === 1 ? '' : 's'} in total).`,
        advice:
          'Compaction replaces the conversation with a summary and loses detail. Break big work into tasks that fit one session, `/clear` between them, or run `/compact` yourself at a natural break with instructions on what to keep.',
      });
    }
  }

  // 7. Context re-sent without a cache hit in the middle of a session.
  if (pricer) {
    const bySession = new Map();
    for (const r of usage) {
      if (r.agent) continue;
      const list = bySession.get(r.sessionId) ?? [];
      list.push(r);
      bySession.set(r.sessionId, list);
    }
    let rebuilds = 0;
    let cost = 0;
    let tokens = 0;
    for (const list of bySession.values()) {
      list.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
      for (const r of list.slice(1)) {
        const context = r.inputTokens + r.cacheCreationTokens + r.cacheReadTokens;
        if (context < 50_000 || r.cacheCreationTokens < 0.5 * context) continue;
        rebuilds += 1;
        tokens += r.cacheCreationTokens;
        cost += pricer({ ...r, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, webSearchRequests: 0 }) ?? 0;
      }
    }
    if (cost >= 0.05 * totalCost && rebuilds >= 3) {
      recs.push({
        id: 'cache-rebuilds',
        title: 'Avoid rebuilding the prompt cache',
        atStakeUSD: cost,
        evidence: `${rebuilds} times a session re-sent its context without a cache hit (${tok(tokens)} tokens written to the cache, ${usd(cost)}), typically after a long pause or a model switch.`,
        advice:
          'Prompt caches expire after a pause and are kept per model. Avoid switching models in the middle of a conversation, and when you return after a break to something unrelated, `/clear` first rather than paying to rebuild a large context.',
      });
    }
  }

  // 8. Mostly step-by-step coding.
  {
    const coding = stats.filter((s) => s.phase !== 'chat');
    const assisted = coding.filter((s) => s.phase === 'assisted');
    if (coding.length >= 5 && assisted.length / coding.length >= 0.3) {
      const median = (list) => {
        const v = list.map((s) => s.toolCallsPerPrompt).sort((a, b) => a - b);
        return v.length ? v[Math.floor(v.length / 2)] : 0;
      };
      const agentic = coding.filter((s) => s.phase !== 'assisted');
      recs.push({
        id: 'autonomy',
        title: 'Hand over whole tasks',
        atStakeUSD: null,
        evidence: `${pct(assisted.length / coding.length)} of your coding sessions are step by step (median ${median(assisted).toFixed(1)} tool calls per prompt${agentic.length ? `, against ${median(agentic).toFixed(1)} in agent-first sessions` : ''}).`,
        advice:
          'Describe the whole task up front - goal, constraints and how to verify it - and let Claude run. Use plan mode for bigger changes, and turn workflows you repeat into skills.',
      });
    }
  }

  // 9. Capabilities that would help but are rarely used.
  if (stats.length >= 10) {
    const share = (f) => stats.filter(f).length / stats.length;
    const background = share((s) => s.backgroundAgents > 0);
    const worktrees = share((s) => s.worktrees > 0);
    if (background < 0.1 && worktrees < 0.1) {
      recs.push({
        id: 'parallel',
        title: 'Run independent work in parallel',
        atStakeUSD: null,
        evidence: `Background agents appear in ${pct(background)} and worktrees in ${pct(worktrees)} of your sessions.`,
        advice:
          'Let long-running or independent tasks run as background agents while you keep working, and use worktrees (`isolation: "worktree"`) when several agents change code at the same time.',
      });
    }
    const skills = share((s) => s.skills > 0);
    if (skills < 0.1) {
      recs.push({
        id: 'skills',
        title: 'Turn recurring workflows into skills',
        atStakeUSD: null,
        evidence: `Skills were used in ${pct(skills)} of your sessions.`,
        advice:
          'Capture the instructions you keep repeating (how to test, release, review or plan in this repo) as a skill, so Claude follows them every time without you typing them out.',
      });
    }
  }

  // 10. Hooks that keep failing: they run on every matching event and do nothing.
  {
    const failing = [...totals.hooks]
      .filter(([, h]) => h.errors >= MIN_HOOK_FAILURES && h.errors / h.runs >= 0.5)
      .sort((a, b) => b[1].errors - a[1].errors);
    if (failing.length) {
      const errors = failing.reduce((s, [, h]) => s + h.errors, 0);
      const seconds = failing.reduce((s, [, h]) => s + h.durationMs, 0) / 1000;
      const shown = failing
        .slice(0, 3)
        .map(([cmd, h]) => `\`${cmd}\` failed ${fmt(h.errors)} of ${fmt(h.runs)} runs${h.lastError ? ` (${h.lastError})` : ''}`);
      recs.push({
        id: 'failing-hooks',
        title: 'Fix or remove hooks that keep failing',
        atStakeUSD: null,
        evidence: `${failing.length} hook${failing.length === 1 ? '' : 's'} failed ${fmt(errors)} times (${Math.round(seconds)}s spent): ${shown.join('; ')}${failing.length > 3 ? '; …' : ''}.`,
        advice:
          'A failing hook gives none of the protection it was added for. Use absolute paths (`"$CLAUDE_PROJECT_DIR"/.claude/hooks/…`) so hooks still resolve when Claude works in a subfolder, check that the interpreter (python, node) is on PATH, and run `/hooks` to review or remove stale ones.',
      });
    }
  }

  // Impact: by the share of cost at stake (of tokens without prices); workflow advice without an amount is low.
  for (const r of recs) {
    const share =
      pricer && r.atStakeUSD != null && totalCost
        ? r.atStakeUSD / totalCost
        : !pricer && r.atStakeTokens != null && totals.totalTokens
          ? r.atStakeTokens / totals.totalTokens
          : null;
    r.impact = share == null ? 'low' : share >= 0.15 ? 'high' : share >= 0.05 ? 'medium' : 'low';
  }
  const order = { high: 0, medium: 1, low: 2 };
  return recs.sort((a, b) => order[a.impact] - order[b.impact] || (b.atStakeUSD ?? 0) - (a.atStakeUSD ?? 0));
}

/** The recommendations as a report document. */
export function buildRecommendations(data, opts) {
  const items = recommend(data, opts);
  const range = opts.since || opts.until ? ` (${opts.since ?? '…'} → ${opts.until ?? 'today'})` : '';
  return {
    title: `Claude Code recommendations${range}`,
    summary: items.length ? [] : ['No clear improvement found in this period - your usage already follows the patterns checked.'],
    sections: items.length
      ? [{ title: 'Recommendations', note: 'most impact first; amounts at stake overlap', items }]
      : [],
    items,
  };
}
