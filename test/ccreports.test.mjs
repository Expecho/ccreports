import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadRecords, normalizeSkillName } from '../src/loader.mjs';
import { aggregate, parseDateArg, toJSON, MAIN_AGENT } from '../src/aggregate.mjs';
import { createPricer } from '../src/pricing.mjs';

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

test('aggregates daily with filters', async () => {
  const root = await fixture();
  try {
    const data = await loadRecords({ dirs: [root] });
    const daily = aggregate(data, { report: 'daily', timeZone: 'UTC' });
    assert.deepEqual(daily.buckets.map((b) => b.key), ['2026-10-01', '2026-10-02']);
    const [d1, d2] = daily.buckets.map(toJSON);
    assert.equal(d1.totalTokens, 1115);
    assert.equal(d1.toolCalls, 1);
    assert.deepEqual(d1.skills, { plan: { model: 0, user: 1, total: 1 } });
    assert.equal(d2.toolCalls, 4);
    assert.deepEqual(d2.mcpServers, { github: 1 });
    assert.equal(toJSON(daily.totals).totalTokens, 3 * 1115);

    const filtered = aggregate(data, { report: 'summary', since: '2026-10-02', timeZone: 'UTC' });
    assert.equal(filtered.totals.commandCount, 1);
    assert.equal(aggregate(data, { project: 'nomatch' }).totals.requests, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('attributes tokens and launches to subagent types', async () => {
  const root = await fixture();
  try {
    const data = await loadRecords({ dirs: [root] });
    const { totals } = aggregate(data, { timeZone: 'UTC' });
    const agents = toJSON(totals).agents;
    assert.equal(totals.subagentLaunches, 1);
    assert.deepEqual(agents.Explore, { launches: 1, requests: 1, toolCalls: 1, totalTokens: 1115, costUSD: 0 });
    assert.equal(agents[MAIN_AGENT].requests, 2);
    assert.equal(agents[MAIN_AGENT].toolCalls, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prices usage with 1h cache writes and long-context tiers', () => {
  const pricer = createPricer({
    'claude-test': {
      input_cost_per_token: 1,
      output_cost_per_token: 10,
      cache_creation_input_token_cost: 2,
      cache_creation_input_token_cost_above_1hr: 3,
      cache_read_input_token_cost: 0.5,
      input_cost_per_token_above_100k_tokens: 100,
      output_cost_per_token_above_100k_tokens: 1000,
    },
  });
  const rec = { model: 'claude-test', inputTokens: 1, outputTokens: 1, cacheCreationTokens: 3, cacheCreation1hTokens: 1, cacheReadTokens: 2 };
  // 1*1 + 1*10 + 2*2 (5m) + 1*3 (1h) + 2*0.5
  assert.equal(pricer(rec), 19);
  assert.equal(pricer({ ...rec, model: 'claude-test-20260101' }), 19); // dated id resolves
  // Context over 100k: input and output switch tier, fields without a tier keep base rate.
  const long = { ...rec, cacheReadTokens: 100_000 };
  assert.equal(pricer(long), 100 + 1000 + 4 + 3 + 50_000);
  assert.equal(pricer({ ...rec, model: 'gpt-x' }), null);
  assert.equal(pricer.isPriced('gpt-x'), false);
});
