import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadRecords, normalizeSkillName } from '../src/loader.mjs';
import { aggregate, parseDateArg, toJSON, MAIN_AGENT } from '../src/aggregate.mjs';
import { createPricer, parsePricingPage, BUILTIN } from '../src/pricing.mjs';
import { buildPeriodReport, buildSummary } from '../src/report.mjs';

const base = { sessionId: 's1', cwd: '/work/app' };
const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 };

const assistant = (ts, id, requestId, content) => ({
  ...base,
  type: 'assistant',
  timestamp: ts,
  requestId,
  uuid: `${id}-${content.map((c) => c.id ?? c.type).join()}`,
  message: { id, model: 'claude-opus-5-5', role: 'assistant', usage, content },
});
const user = (ts, uuid, content) => ({ ...base, type: 'user', timestamp: ts, uuid, message: { role: 'user', content } });

const mainLines = [
  { type: 'ai-title', sessionId: 's1', aiTitle: 'Fixture session' },
  user('2026-10-01T10:00:00Z', 'u1', '<command-message>plan</command-message>\n<command-name>/plan</command-name>'),
  user('2026-10-01T10:00:01Z', 'u2', [{ type: 'text', text: 'Base directory for this skill: /work/app/.claude/skills/plan\n...' }]),
  // One API response split over two lines: usage must be counted once.
  assistant('2026-10-01T10:00:05Z', 'msg1', 'req1', [{ type: 'text', text: 'ok' }]),
  assistant('2026-10-01T10:00:05Z', 'msg1', 'req1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
  assistant('2026-10-02T09:00:00Z', 'msg2', 'req2', [
    { type: 'tool_use', id: 't2', name: 'Skill', input: { skill: '.claude/worktrees/x:decide' } },
    { type: 'tool_use', id: 't3', name: 'mcp__github__search', input: {} },
    { type: 'tool_use', id: 't5', name: 'Agent', input: { subagent_type: 'Explore', prompt: '...' } },
  ]),
  user('2026-10-02T09:01:00Z', 'u3', '<command-name>/clear</command-name>'),
  user('2026-10-02T09:01:01Z', 'u4', 'not a skill'),
];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ccreports-'));
  const proj = path.join(root, '-work-app');
  await mkdir(path.join(proj, 's1', 'subagents'), { recursive: true });
  await writeFile(path.join(proj, 's1.jsonl'), mainLines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n');
  // A resumed session repeats msg2 in another file: must not double count.
  await writeFile(path.join(proj, 's1-resumed.jsonl'), JSON.stringify(mainLines[5]) + '\n');
  await writeFile(
    path.join(proj, 's1', 'subagents', 'agent-a.jsonl'),
    JSON.stringify(assistant('2026-10-02T09:30:00Z', 'msg3', 'req3', [{ type: 'tool_use', id: 't4', name: 'Read', input: {} }])) + '\n',
  );
  await writeFile(
    path.join(proj, 's1', 'subagents', 'agent-a.meta.json'),
    JSON.stringify({ agentType: 'Explore', toolUseId: 't5' }),
  );
  return root;
}

test('normalizeSkillName strips directory scopes but keeps plugin prefixes', () => {
  assert.equal(normalizeSkillName('.claude/worktrees/feat:execute-plan'), 'execute-plan');
  assert.equal(normalizeSkillName('anthropic-skills:docs'), 'anthropic-skills:docs');
  assert.equal(normalizeSkillName('/plan'), 'plan');
});

test('parseDateArg accepts both formats', () => {
  assert.equal(parseDateArg('20261001', '--since'), '2026-10-01');
  assert.equal(parseDateArg('2026-10-01', '--since'), '2026-10-01');
  assert.throws(() => parseDateArg('2026-1', '--since'));
});

test('loads and deduplicates records', async () => {
  const root = await fixture();
  try {
    const data = await loadRecords({ dirs: [root] });
    assert.equal(data.usage.length, 3); // msg1, msg2, msg3 (subagent)
    assert.deepEqual(data.tools.map((t) => t.name).sort(), ['Agent', 'Bash', 'Read', 'Skill', 'mcp__github__search']);
    assert.equal(data.usage.find((u) => u.agent === 'Explore')?.timestamp, '2026-10-02T09:30:00Z');
    assert.deepEqual(
      data.skills.map((s) => `${s.name}:${s.source}`).sort(),
      ['decide:model', 'plan:user'],
    );
    assert.deepEqual(data.commands.map((c) => c.name).sort(), ['/clear', '/plan']);
    assert.equal(data.titles.get('s1'), 'Fixture session');

    const noSub = await loadRecords({ dirs: [root], includeSubagents: false });
    assert.equal(noSub.usage.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a session keeps the project it started in', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ccreports-'));
  try {
    const proj = path.join(root, '-work-app');
    await mkdir(proj, { recursive: true });
    const lines = [
      { ...user('2026-10-01T10:00:00Z', 'u1', 'hi'), cwd: '/work/app' },
      { ...assistant('2026-10-01T10:00:05Z', 'm1', 'r1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]), cwd: '/work/app/tests' },
    ];
    await writeFile(path.join(proj, 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const data = await loadRecords({ dirs: [root] });
    assert.deepEqual([...data.usage, ...data.tools].map((r) => r.project), ['/work/app', '/work/app']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('aggregates daily with filters', async () => {
  const root = await fixture();
  try {
    const data = await loadRecords({ dirs: [root] });
    const daily = aggregate(data, { report: 'daily', timeZone: 'UTC' });
    assert.deepEqual(daily.buckets.map((b) => b.key), ['2026-10-01', '2026-10-02']);
    const [d1, d2] = daily.buckets.map(toJSON);
    assert.equal(d1.totalTokens, 1115);
    assert.equal(d1.toolCalls, 1);
    const plan = d1.skills.plan;
    assert.deepEqual({ model: plan.model, user: plan.user, total: plan.total }, { model: 0, user: 1, total: 1 });
    // Typed skill: its content enters the next request (cache write) and is re-read once after.
    assert.ok(plan.cacheWriteTokens > 0);
    assert.equal(plan.cacheReadTokens, plan.cacheWriteTokens);
    assert.equal(plan.outputTokens, 0);
    assert.equal(plan.tokens, plan.cacheWriteTokens + plan.cacheReadTokens);
    assert.equal(d2.toolCalls, 4);
    assert.equal(d2.mcpServers.github.calls, 1);
    assert.equal(typeof d2.mcpServers.github.tokens, 'number');
    assert.equal(d2.tools.Bash, undefined); // Bash ran on day 1
    assert.equal(d1.tools.Bash.calls, 1);
    assert.equal(toJSON(daily.totals).totalTokens, 3 * 1115);

    const filtered = aggregate(data, { report: 'summary', since: '2026-10-02', timeZone: 'UTC' });
    assert.equal(filtered.totals.commandCount, 1);
    assert.equal(aggregate(data, { project: 'nomatch' }).totals.requests, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('period report shows sessions and per-session averages on breakdown rows', async () => {
  const root = await fixture();
  try {
    const data = await loadRecords({ dirs: [root] });
    const result = aggregate(data, { report: 'monthly', timeZone: 'UTC' });
    const { columns, rows } = buildPeriodReport('monthly', result, { breakdown: true, top: 0 }).sections[0];
    const col = (title) => columns.findIndex((c) => c.title === title);
    assert.equal(rows[0].cells[col('Sessions')], 1);
    const bash = rows.find((r) => r.cells[0] === '[tool] Bash');
    assert.deepEqual(bash.cells[col('Per Session')], { kind: 'avg', v: 1 });

    const plain = buildPeriodReport('monthly', result, {}).sections[0];
    assert.equal(plain.columns.some((c) => c.title === 'Per Session'), false);
    const session = buildPeriodReport('session', aggregate(data, { report: 'session' }), { breakdown: true }).sections[0];
    assert.equal(session.columns.some((c) => c.title === 'Sessions' || c.title === 'Per Session'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('context size: per-session peak, averages, subagents excluded', () => {
  const req = (sessionId, ctx, agent = null) => ({
    timestamp: '2026-10-01T10:00:00Z',
    sessionId,
    project: '/p',
    agent,
    model: 'm',
    inputTokens: 0,
    outputTokens: 50, // output is not part of the context
    cacheCreationTokens: 0,
    cacheReadTokens: ctx,
  });
  const data = {
    usage: [req('a', 100), req('a', 300), req('b', 500), req('b', 9999, 'Explore')],
    tools: [],
    skills: [],
    commands: [],
    titles: new Map(),
  };
  const { totals } = aggregate(data, { timeZone: 'UTC' });
  assert.equal(totals.maxContextTokens, 500);
  assert.equal(totals.avgSessionMaxContextTokens, 400); // (300 + 500) / 2
  assert.equal(totals.avgContextTokens, 300); // (100 + 300 + 500) / 3

  const sessions = aggregate(data, { report: 'session', timeZone: 'UTC' }).buckets.map(toJSON);
  const a = sessions.find((s) => s.key === 'a');
  assert.equal(a.maxContextTokens, 300);
  assert.equal(a.avgContextTokens, 200);
  assert.equal('sessionPeaks' in a, false);
});

test('attributes tokens and launches to subagent types', async () => {
  const root = await fixture();
  try {
    const data = await loadRecords({ dirs: [root] });
    const { totals } = aggregate(data, { timeZone: 'UTC' });
    const agents = toJSON(totals).agents;
    assert.equal(totals.subagentLaunches, 1);
    assert.deepEqual(agents.Explore, {
      launches: 1,
      requests: 1,
      toolCalls: 1,
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationTokens: 100,
      cacheReadTokens: 1000,
      totalTokens: 1115,
      costUSD: 0,
    });
    assert.equal(agents[MAIN_AGENT].requests, 2);
    assert.equal(agents[MAIN_AGENT].toolCalls, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prices usage at Claude API rates with tiers and modifiers', () => {
  // Prices per million tokens; tokens below are in millions to keep the math readable.
  const M = 1e6;
  const pricer = createPricer({
    'claude-test-1-0': {
      input: 1,
      cacheWrite5m: 2,
      cacheWrite1h: 3,
      cacheRead: 0.5,
      output: 10,
      fast: { input: 4, output: 40 },
      longContext: { threshold: 100 * M, input: 100, cacheWrite5m: 200, cacheWrite1h: 300, cacheRead: 50, output: 1000 },
    },
  });
  const rec = { model: 'claude-test-1-0', inputTokens: M, outputTokens: M, cacheCreationTokens: 3 * M, cacheCreation1hTokens: M, cacheReadTokens: 2 * M };
  // 1*1 + 1*10 + 2*2 (5m) + 1*3 (1h) + 2*0.5
  assert.equal(pricer(rec), 19);
  assert.equal(pricer({ ...rec, model: 'claude-test-1-0-20260101' }), 19); // dated id
  assert.equal(pricer({ ...rec, model: 'claude-1-0-test' }), 19); // legacy "claude-3-5-haiku" style id
  assert.equal(pricer({ ...rec, model: 'claude-test-1-0[1m]' }), 19);
  // Prompt over the threshold: every token at the higher prices.
  assert.equal(pricer({ ...rec, cacheReadTokens: 100 * M }), 100 + 1000 + 400 + 300 + 5000);
  // Fast: input 4, output 40, writes 1.25x / 2x fast input, read keeps the model's read ratio (0.5).
  assert.equal(pricer({ ...rec, speed: 'fast' }), 4 + 40 + 2 * 5 + 8 + 2 * 2);
  assert.ok(Math.abs(pricer({ ...rec, inferenceGeo: 'us' }) - 19 * 1.1) < 1e-9);
  assert.equal(pricer({ ...rec, webSearchRequests: 100 }), 20);
  assert.equal(pricer({ ...rec, model: 'gpt-x' }), null);
  assert.equal(pricer.isPriced('gpt-x'), false);
});

test('parses the pricing page tables', () => {
  const md = [
    '## Model pricing',
    '',
    '| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |',
    '| :-- | :-- | :-- | :-- | :-- | :-- |',
    '| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |',
    '| Claude Opus 4.8 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |',
    '| Claude Mythos 5.1 ([limited availability](https://example.com)) | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok | $50 / MTok |',
    '| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok<sup>2</sup> | $10 / MTok |',
    '| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |',
    '| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |',
    '',
    '## Cloud platform pricing',
    '| Claude Opus 5.5 | $99 / MTok | $99 / MTok | $99 / MTok | $99 / MTok | $99 / MTok |',
    '',
    '### Fast mode pricing',
    '| Model | Input | Output |',
    '| --- | --- | --- |',
    '| Claude Opus 5.5 | $8 USD / MTok | $40 USD / MTok |',
    '| Claude Opus 5 / Claude Opus 4.8 | $10 USD / MTok | $50 USD / MTok |',
  ].join('\n');
  const table = parsePricingPage(md);
  assert.deepEqual(Object.keys(table).sort(), [
    'claude-haiku-5-5',
    'claude-mythos-5-1',
    'claude-opus-4-8',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
  ]);
  assert.deepEqual(table['claude-opus-5-5'], { ...BUILTIN['claude-opus-5-5'] }); // other sections ignored
  assert.deepEqual(table['claude-opus-4-8'].fast, { input: 10, output: 50 });
  assert.deepEqual(table['claude-haiku-5-5'], BUILTIN['claude-haiku-5-5']);
  assert.throws(() => parsePricingPage('# Something else'));
});

test('reports hook runs, failures, duration and added context', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ccreports-'));
  try {
    const proj = path.join(root, '-work-app');
    await mkdir(proj, { recursive: true });
    const hook = (uuid, ts, attachment, parentUuid = null) => ({ ...base, type: 'attachment', uuid, parentUuid, timestamp: ts, attachment });
    const lines = [
      hook('h1', '2026-10-01T10:00:00Z', { type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', toolUseID: 'x', command: 'python start.py', durationMs: 900 }),
      hook('h2', '2026-10-01T10:00:00Z', { type: 'hook_additional_context', hookName: 'SessionStart', hookEvent: 'SessionStart', toolUseID: 'SessionStart', content: ['x'.repeat(400)] }, 'h1'),
      hook('h3', '2026-10-01T10:00:05Z', { type: 'hook_non_blocking_error', hookName: 'PreToolUse:Bash', hookEvent: 'PreToolUse', command: 'node guard.mjs', durationMs: 100, stderr: 'Failed with non-blocking status code: node:internal/x\r\n  throw err;\r\nError: Cannot find module \'guard.mjs\'\r\n' }),
      hook('h4', '2026-10-01T10:00:06Z', { type: 'hook_blocking_error', hookName: 'PreToolUse:Bash', hookEvent: 'PreToolUse', command: 'node guard.mjs', durationMs: 50, stderr: 'blocked: '.repeat(40) }),
      { type: 'system', subtype: 'stop_hook_summary', hookCount: 1, timestamp: '2026-10-01T10:00:07Z' },
    ];
    await writeFile(path.join(proj, 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    // A resumed session repeats the failed run: must not double count.
    await writeFile(path.join(proj, 's1-resumed.jsonl'), JSON.stringify(lines[2]) + '\n');
    const data = await loadRecords({ dirs: [root] });
    assert.equal(data.hooks.length, 3);

    const { totals } = aggregate(data, { timeZone: 'UTC' });
    assert.equal(totals.hookRuns, 3);
    const start = totals.hooks.get('python start.py');
    assert.equal(start.runs, 1);
    assert.ok(start.contextTokens > 0, 'additional context is linked to its run');
    const guard = totals.hooks.get('node guard.mjs');
    assert.deepEqual([guard.runs, guard.errors, guard.blocked, guard.durationMs], [2, 1, 1, 150]);
    assert.equal(guard.lastError, "Error: Cannot find module 'guard.mjs'");
    assert.ok(guard.contextTokens > 0, 'a blocking hook feeds its stderr to the model');
    assert.deepEqual(toJSON(totals).hooks['node guard.mjs'].events, ['PreToolUse']);

    const doc = buildSummary({ totals }, { top: 15, showCost: false });
    const section = doc.sections.find((s) => s.title === 'Hooks');
    assert.deepEqual(section.rows.map((r) => r.cells[0]), ['node guard.mjs', 'python start.py']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('session names are at most 35 characters in reports', async () => {
  const { sessionName, SESSION_NAME_MAX } = await import('../src/report.mjs');
  assert.equal(SESSION_NAME_MAX, 35);
  assert.equal(sessionName('Short title'), 'Short title');
  assert.equal(sessionName('x'.repeat(35)), 'x'.repeat(35));
  const long = sessionName('Investigate why the nightly build fails on Windows agents');
  assert.equal(long.length, 35);
  assert.equal(long, 'Investigate why the nightly build …');

  const rec = { timestamp: '2026-10-01T10:00:00Z', sessionId: 's1', project: '/p', agent: null, name: 'Bash' };
  const data = { usage: [], tools: [rec], skills: [], commands: [], hooks: [], titles: new Map([['s1', 'A'.repeat(50)]]) };
  const doc = buildPeriodReport('session', aggregate(data, { report: 'session' }), {});
  assert.equal(doc.sections[0].rows[0].cells[0], 'A'.repeat(34) + '…');
});
