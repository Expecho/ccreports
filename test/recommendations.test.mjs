import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommend, buildRecommendations } from '../src/recommendations.mjs';
import { createPricer, BUILTIN } from '../src/pricing.mjs';
import { toMarkdown, toCsv, toHtml, toTerminal } from '../src/formats.mjs';

const pricer = createPricer(BUILTIN);

function usage(sessionId, context, { agent = null, model = 'claude-opus-5-5', minute = 0, cacheWrite = 0 } = {}) {
  return {
    timestamp: `2026-10-05T10:${String(minute).padStart(2, '0')}:00Z`,
    sessionId,
    project: '/p',
    agent,
    model,
    inputTokens: 0,
    outputTokens: 1_000,
    cacheCreationTokens: cacheWrite,
    cacheReadTokens: context - cacheWrite,
  };
}

const tool = (sessionId, name, total, agent = null) => ({
  timestamp: '2026-10-05T10:00:00Z',
  sessionId,
  project: '/p',
  agent,
  name,
  tokens: { total, outputTokens: 0, cacheWriteTokens: total, cacheReadTokens: 0, model: 'claude-opus-5-5', cache1hShare: 0, promptTokens: 1000 },
});

const session = (compactions = 0) => ({
  entrypoint: 'cli',
  prompts: new Set(['p']),
  prs: new Set(),
  compactions: new Set(Array.from({ length: compactions }, (_, i) => `c${i}`)),
});

function data({ usage: u, tools = [], sessions }) {
  return { usage: u, tools, skills: [], commands: [], titles: new Map(), sessions };
}

test('flags long contexts, a heavy tool, premium subagents and compaction', () => {
  const d = data({
    usage: [
      usage('a', 20_000, { minute: 0 }),
      usage('a', 500_000, { minute: 1 }), // long context
      usage('b', 300_000, { minute: 2 }),
      usage('b', 600_000, { agent: 'general-purpose', minute: 3, cacheWrite: 600_000 }), // premium subagent: $3 on Opus, $1.50 on Sonnet
      usage('b', 50_000, { agent: 'fork', minute: 4 }), // forks can't change model
      usage('c', 10_000, { minute: 5 }),
    ],
    tools: [tool('a', 'Bash', 400_000), tool('a', 'Edit', 1_000), tool('b', 'Edit', 1_000), tool('c', 'Edit', 1_000)],
    sessions: new Map([
      ['a', session(1)],
      ['b', session(1)],
      ['c', session(1)],
    ]),
  });
  const recs = recommend(d, { pricer, timeZone: 'UTC' });
  const byId = Object.fromEntries(recs.map((r) => [r.id, r]));

  assert.ok(byId['long-context']);
  assert.match(byId['long-context'].evidence, /2 sessions peaked above 400k|1 session peaked above 400k/);
  assert.equal(byId['long-context'].impact, 'high');

  assert.ok(byId['heavy-tool:Bash']);
  assert.match(byId['heavy-tool:Bash'].advice, /head/);
  assert.equal(byId['heavy-tool:Edit'], undefined);

  assert.ok(byId['subagent-model']);
  assert.match(byId['subagent-model'].evidence, /general-purpose/);
  assert.doesNotMatch(byId['subagent-model'].evidence, /fork/);
  assert.ok(byId['subagent-model'].atStakeUSD > 0);

  assert.match(byId.compaction.evidence, /3 of 3 sessions hit compaction/);

  // Most impact first.
  const order = { high: 0, medium: 1, low: 2 };
  for (let i = 1; i < recs.length; i++) assert.ok(order[recs[i - 1].impact] <= order[recs[i].impact]);
});

test('detects prompt-cache rebuilds in the middle of a session', () => {
  const u = [usage('a', 60_000, { minute: 0, cacheWrite: 60_000 })]; // the first request always writes
  for (let m = 1; m <= 4; m++) u.push(usage('a', 100_000, { minute: m * 10, cacheWrite: 90_000 }));
  const recs = recommend(data({ usage: u, sessions: new Map([['a', session()]]) }), { pricer, timeZone: 'UTC' });
  const rebuild = recs.find((r) => r.id === 'cache-rebuilds');
  assert.ok(rebuild);
  assert.match(rebuild.evidence, /^4 times/);
});

test('without prices, impact follows the share of tokens', () => {
  const d = data({
    usage: [usage('a', 500_000), usage('a', 20_000, { minute: 1 })],
    sessions: new Map([['a', session()]]),
  });
  const [long] = recommend(d, { timeZone: 'UTC' });
  assert.equal(long.id, 'long-context');
  assert.equal(long.atStakeUSD, null);
  assert.equal(long.impact, 'high');
  assert.match(long.evidence, /of your tokens/);
});

test('a clean period gets no recommendations', () => {
  const d = data({ usage: [usage('a', 20_000)], tools: [tool('a', 'Edit', 100)], sessions: new Map([['a', session()]]) });
  const doc = buildRecommendations(d, { pricer, timeZone: 'UTC' });
  assert.equal(doc.items.length, 0);
  assert.equal(doc.sections.length, 0);
  assert.match(doc.summary[0], /No clear improvement/);
});

test('recommendations render in every format', () => {
  const doc = {
    title: 'R',
    sections: [
      {
        title: 'Recommendations',
        items: [{ id: 'x', title: 'Keep it short', impact: 'high', atStakeUSD: 12.5, evidence: 'Lots, of <context>.', advice: 'Use `/clear`.' }],
      },
    ],
  };
  assert.match(toTerminal(doc), /1\. Keep it short {2}\[high impact · \$12\.50 at stake\]\n {3}Evidence: Lots/);
  assert.match(toMarkdown(doc), /### 1\. Keep it short\n\n_high impact · \$12\.50 at stake_\n\n\*\*Evidence:\*\* Lots/);
  assert.match(toCsv(doc), /^#,Recommendation,Impact,At stake \(USD\),Evidence,Advice\n1,Keep it short,high,12\.5000,"Lots, of <context>\.",Use `\/clear`\.\n$/);
  const html = toHtml(doc);
  assert.match(html, /<li class="rec high">/);
  assert.match(html, /Lots, of &lt;context&gt;\./);
  assert.match(html, /Use <code>\/clear<\/code>\./);
});

test('flags hooks that keep failing', () => {
  const hook = (i, outcome) => ({
    timestamp: '2026-10-05T10:00:00Z',
    sessionId: 'a',
    project: '/p',
    agent: null,
    event: 'PreToolUse',
    command: 'node .claude/hooks/guard.mjs',
    outcome,
    run: true,
    durationMs: 100,
    contextTokens: 0,
    error: outcome === 'non_blocking_error' ? "Error: Cannot find module 'guard.mjs'" : undefined,
  });
  const d = data({ usage: [usage('a', 20_000)], sessions: new Map([['a', session()]]) });
  d.hooks = [...Array.from({ length: 12 }, (_, i) => hook(i, 'non_blocking_error')), hook(12, 'success')];
  const rec = recommend(d, { pricer, timeZone: 'UTC' }).find((r) => r.id === 'failing-hooks');
  assert.ok(rec);
  assert.match(rec.evidence, /failed 12 of 13 runs \(Error: Cannot find module 'guard\.mjs'\)/);

  d.hooks = d.hooks.slice(0, 5); // too few failures to call out
  assert.equal(recommend(d, { pricer, timeZone: 'UTC' }).some((r) => r.id === 'failing-hooks'), false);
});
