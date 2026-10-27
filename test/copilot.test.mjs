import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadCopilotRecords, mergeData } from '../src/copilot.mjs';
import { aggregate } from '../src/aggregate.mjs';
import { createPricer, BUILTIN } from '../src/pricing.mjs';
import { sessionStats } from '../src/adoption.mjs';

const ev = (type, timestamp, data, extra = {}) => ({ type, data, id: `${type}-${timestamp}`, timestamp, ...extra });

// A session with per-request usage (recent Copilot versions).
const recent = [
  ev('session.start', '2026-10-01T10:00:00Z', { sessionId: 'c1', context: { cwd: '/work/app' } }),
  ev('user.message', '2026-10-01T10:00:01Z', { content: '/forge-plan add a button' }),
  ev('skill.invoked', '2026-10-01T10:00:01.5Z', { name: 'forge-plan', content: 'x'.repeat(240) }),
  ev('session.usage_record', '2026-10-01T10:00:02Z', {
    usage: {
      model: 'claude-sonnet-5.5',
      apiCallId: 'a1',
      inputTokens: 1100,
      outputTokens: 50,
      cacheReadTokens: 600,
      cacheWriteTokens: 400,
      cost: 1,
      copilotUsage: { totalNanoAiu: 2_000_000_000 },
    },
  }),
  ev('assistant.message', '2026-10-01T10:00:03Z', {
    messageId: 'm1',
    apiCallId: 'a1',
    model: 'claude-sonnet-5.5',
    outputTokens: 50,
    toolRequests: [
      { toolCallId: 't1', name: 'powershell', arguments: { command: 'git status; gh pr create --fill' } },
      { toolCallId: 't2', name: 'apply_patch', arguments: { patch: '...' } },
    ],
  }),
  ev('tool.execution_start', '2026-10-01T10:00:03Z', { toolCallId: 't1', toolName: 'powershell', arguments: { command: 'git status; gh pr create --fill' } }),
  ev('tool.execution_complete', '2026-10-01T10:00:04Z', {
    toolCallId: 't1',
    success: true,
    result: { content: 'https://github.com/acme/app/pull/7' },
  }),
  ev('tool.execution_start', '2026-10-01T10:00:04Z', { toolCallId: 't2', toolName: 'apply_patch', arguments: {} }),
  ev('tool.execution_complete', '2026-10-01T10:00:05Z', { toolCallId: 't2', success: true, result: { content: 'ok' } }),
  ev('tool.execution_start', '2026-10-01T10:00:06Z', {
    toolCallId: 't3',
    toolName: 'github-mcp-server-search_code',
    mcpServerName: 'github-mcp-server',
    mcpToolName: 'search_code',
    arguments: {},
  }),
  ev('hook.start', '2026-10-01T10:00:06Z', { hookInvocationId: 'h1', hookType: 'preToolUse' }),
  ev('hook.end', '2026-10-01T10:00:06.5Z', {
    hookInvocationId: 'h1',
    hookType: 'preToolUse',
    success: false,
    error: { message: "Error: Hook command failed with code 1\nStderr: Error: Cannot find module 'x'" },
  }),
  ev('session.shutdown', '2026-10-01T10:05:00Z', {
    // Ignored: the session has per-request usage records.
    modelMetrics: { 'claude-sonnet-5.5': { requests: { count: 1, cost: 1 }, usage: { inputTokens: 1100 } } },
  }),
];

// An older session: only per-run totals at shutdown, with a subagent.
const older = [
  ev('session.start', '2026-09-01T10:00:00Z', { sessionId: 'c2', context: { cwd: '/work/lib' } }),
  ev('user.message', '2026-09-01T10:00:01Z', { content: 'explain this repo' }),
  ev('user.message', '2026-09-01T10:00:01Z', { content: 'skill text', source: 'skill-forge-plan' }),
  ev('tool.execution_start', '2026-09-01T10:00:02Z', { toolCallId: 'k1', toolName: 'task', arguments: { agent_type: 'explore', mode: 'background' } }),
  ev('subagent.started', '2026-09-01T10:00:02Z', { agentType: 'explore', agentName: 'explore' }, { agentId: 'ag1' }),
  ev('tool.execution_start', '2026-09-01T10:00:03Z', { toolCallId: 'k2', toolName: 'view', arguments: {} }, { agentId: 'ag1' }),
  ev('session.shutdown', '2026-09-01T11:00:00Z', {
    agentMetrics: {
      main: { modelMetrics: { 'claude-sonnet-4.6': { requests: { count: 4, cost: 2 }, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 0 } } } },
      ag1: { agentName: 'explore', modelMetrics: { 'gpt-5.4': { requests: { count: 3, cost: 0 }, usage: { inputTokens: 300, outputTokens: 30 }, totalNanoAiu: 5_000_000_000 } } },
    },
  }),
];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ccreports-copilot-'));
  const write = async (id, events, yaml) => {
    await mkdir(path.join(root, id), { recursive: true });
    await writeFile(path.join(root, id, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\nnot json\n');
    if (yaml) await writeFile(path.join(root, id, 'workspace.yaml'), yaml);
  };
  await write('c1', recent, 'id: c1\nname: Add A Button\n');
  await write('c2', older);
  await writeFile(path.join(root, 'c2', 'vscode.metadata.json'), '{}');
  await mkdir(path.join(root, 'empty'));
  return root;
}

test('loadCopilotRecords normalizes usage, tools, skills, commands and hooks', async () => {
  const root = await fixture();
  try {
    const data = await loadCopilotRecords({ dirs: [root] });
    assert.equal(data.files, 2);
    assert.equal(data.titles.get('c1'), 'Add A Button');

    // Per-request record: input excludes the cached tokens; cost from AI credits.
    const c1 = data.usage.filter((u) => u.sessionId === 'c1');
    assert.equal(c1.length, 1);
    assert.deepEqual(
      [c1[0].inputTokens, c1[0].cacheReadTokens, c1[0].cacheCreationTokens, c1[0].premiumRequests, c1[0].costUSD],
      [100, 600, 400, 1, 0.02],
    );
    assert.equal(c1[0].project, '/work/app');

    // Shutdown totals: one record per agent and model, summing several requests.
    const c2 = data.usage.filter((u) => u.sessionId === 'c2');
    assert.deepEqual(
      c2.map((u) => [u.agent, u.model, u.requests, u.aggregated, u.inputTokens]),
      [
        [null, 'claude-sonnet-4.6', 4, true, 200],
        ['explore', 'gpt-5.4', 3, true, 300],
      ],
    );
    assert.equal(c2[0].costUSD, undefined); // nothing billed in AI credits: priced by the report

    const tool = (id) => data.tools.find((t) => t.sessionId === id.s && t.name === id.name);
    assert.deepEqual(tool({ s: 'c1', name: 'powershell' }).shellCommands, ['git', 'gh']);
    assert.equal(tool({ s: 'c1', name: 'apply_patch' }).edit, true);
    assert.ok(tool({ s: 'c1', name: 'mcp__github-mcp-server__search_code' }));
    const task = tool({ s: 'c2', name: 'task' });
    assert.deepEqual([task.subagentType, task.background], ['explore', true]);
    assert.equal(tool({ s: 'c2', name: 'view' }).agent, 'explore');

    assert.deepEqual(data.commands.map((c) => c.name), ['/forge-plan']);
    assert.deepEqual(data.skills.map((s) => [s.name, s.source]), [['forge-plan', 'user']]);

    assert.equal(data.hooks.length, 1);
    assert.equal(data.hooks[0].event, 'PreToolUse');
    assert.equal(data.hooks[0].outcome, 'non_blocking_error');
    assert.equal(data.hooks[0].error, "Error: Cannot find module 'x'");
    assert.equal(data.hooks[0].durationMs, 500);

    // Prompts exclude injected skill text; PRs come from `gh pr create` output.
    assert.equal(data.sessions.get('c1').prompts.size, 1);
    assert.equal(data.sessions.get('c2').prompts.size, 1);
    assert.deepEqual([...data.sessions.get('c1').prs], ['https://github.com/acme/app/pull/7']);
    assert.equal(data.sessions.get('c1').entrypoint, 'copilot-cli');
    assert.equal(data.sessions.get('c2').entrypoint, 'copilot-vscode');

    const sub = await loadCopilotRecords({ dirs: [root], includeSubagents: false });
    assert.ok(!sub.usage.some((u) => u.agent) && !sub.tools.some((t) => t.agent));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('aggregate uses billed Copilot cost, request counts and premium requests', async () => {
  const root = await fixture();
  try {
    const data = await loadCopilotRecords({ dirs: [root] });
    const pricer = createPricer(BUILTIN);
    const { totals } = aggregate(data, { pricer });
    assert.equal(totals.requests, 1 + 4 + 3);
    assert.equal(totals.premiumRequests, 1 + 2);
    // Sonnet 4.6 (dotted name) priced at API rates; gpt-5.4 billed 5 AIU = $0.05.
    const sonnet = (200 * 3 + 100 * 15 + 800 * 0.3) / 1e6;
    assert.ok(Math.abs(totals.costUSD - (0.02 + sonnet + 0.05)) < 1e-9);
    assert.equal(totals.unpricedModels.size, 0);
    // Context only from per-request records of the main session.
    assert.equal(totals.contextRequests, 1);
    assert.equal(totals.maxContextTokens, 1100);

    const stats = sessionStats(data, {});
    const c1 = stats.find((s) => s.id === 'c1');
    assert.deepEqual([c1.edits, c1.prs, c1.surface], [1, 1, 'Copilot CLI']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('mergeData combines sources', () => {
  const part = (id) => ({
    files: 1,
    usage: [{ sessionId: id }],
    tools: [],
    skills: [],
    commands: [],
    hooks: [],
    sessions: new Map([[id, {}]]),
    titles: new Map(),
  });
  const merged = mergeData(part('a'), part('b'));
  assert.equal(merged.files, 2);
  assert.equal(merged.usage.length, 2);
  assert.deepEqual([...merged.sessions.keys()], ['a', 'b']);
});

test('Copilot recommendations use Copilot advice and skip context for shutdown totals', async () => {
  const { recommend } = await import('../src/recommendations.mjs');
  const rec = (i, extra) => ({
    timestamp: `2026-10-0${1 + (i % 9)}T10:00:00Z`,
    sessionId: `s${i}`,
    project: '/work/app',
    agent: null,
    source: 'copilot',
    model: 'gpt-5.4',
    inputTokens: 1000,
    outputTokens: 100,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUSD: 1,
    ...extra,
  });
  const tokens = (total) => ({ total, outputTokens: 0, cacheWriteTokens: total, cacheReadTokens: 0, costUSD: 0.5 });
  const data = {
    // Shutdown totals with a huge summed context: not a long-context request.
    usage: Array.from({ length: 10 }, (_, i) => rec(i, { cacheReadTokens: 900_000, requests: 50, aggregated: true })),
    tools: Array.from({ length: 10 }, (_, i) => ({ ...rec(i), name: 'view', tokens: tokens(300_000) })),
    skills: [],
    commands: [],
    hooks: [],
    sessions: new Map(Array.from({ length: 10 }, (_, i) => [`s${i}`, { prompts: new Set([1]), prs: new Set(), compactions: new Set(), modes: new Set() }])),
    titles: new Map(),
  };
  const items = recommend(data, { source: 'copilot', pricer: Object.assign(() => 0, { isPriced: () => true }) });
  const ids = items.map((r) => r.id);
  assert.ok(!ids.includes('long-context'));
  assert.ok(!ids.includes('subagent-model'));
  const delegate = items.find((r) => r.id === 'delegate-exploration');
  assert.match(delegate.evidence, /0% of your sessions launched a subagent/);
  assert.match(delegate.advice, /`explore` agent/);
  assert.match(items.find((r) => r.id === 'heavy-tool:view').advice, /copilot-instructions\.md/);
  assert.ok(!items.some((r) => /CLAUDE|Claude/.test(r.advice)));
});
