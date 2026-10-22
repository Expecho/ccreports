import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, buildAdoption, AUTONOMY_THRESHOLD } from '../src/adoption.mjs';
import { toHtml, toMarkdown } from '../src/formats.mjs';

const stats = (over) => ({
  edits: 0,
  prs: 0,
  toolCalls: 0,
  prompts: 1,
  subagentLaunches: 0,
  backgroundAgents: 0,
  worktrees: 0,
  agentMessages: 0,
  ...over,
});

test('classify: chat, assisted, agent-first, multi-agent', () => {
  assert.equal(classify(stats({ toolCalls: 40 })), 'chat'); // lots of reading, no changes
  assert.equal(classify(stats({ subagentLaunches: 5 })), 'chat'); // research with subagents is still chat
  assert.equal(classify(stats({ prs: 1 })), 'assisted'); // a PR counts as code work
  assert.equal(classify(stats({ edits: 3, toolCalls: 9, prompts: 1 })), 'assisted');
  assert.equal(classify(stats({ edits: 3, toolCalls: AUTONOMY_THRESHOLD * 2, prompts: 2 })), 'agent');
  assert.equal(classify(stats({ edits: 3, toolCalls: 30, prompts: 0 })), 'agent'); // no typed prompts: per 1
  assert.equal(classify(stats({ edits: 1, subagentLaunches: 1 })), 'assisted'); // one subagent isn't multi-agent
  assert.equal(classify(stats({ edits: 1, subagentLaunches: 2 })), 'multi');
  assert.equal(classify(stats({ edits: 1, backgroundAgents: 1 })), 'multi');
  assert.equal(classify(stats({ edits: 1, worktrees: 1 })), 'multi');
});

function fixture() {
  const t = (sessionId, name, i, extra = {}) => ({ timestamp: `2026-10-0${i}T10:00:00Z`, sessionId, project: '/p', agent: null, name, ...extra });
  const u = (sessionId, i) => ({
    timestamp: `2026-10-0${i}T10:00:00Z`,
    sessionId,
    project: '/p',
    agent: null,
    model: 'claude-opus-5-5',
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  });
  const session = (entrypoint, prompts, prs = []) => ({ entrypoint, prompts: new Set(prompts), prs: new Set(prs) });
  return {
    usage: [u('chat', 1), u('assist', 2), u('agent', 3), u('multi', 4)],
    tools: [
      t('chat', 'Read', 1),
      t('assist', 'Edit', 2),
      ...Array.from({ length: 12 }, (_, i) => t('agent', i ? 'Bash' : 'Write', 3)),
      t('multi', 'Edit', 4),
      t('multi', 'Agent', 4, { subagentType: 'Explore', background: true }),
    ],
    skills: [],
    commands: [],
    titles: new Map([['agent', 'Agent session']]),
    sessions: new Map([
      ['chat', session('cli', ['p1'])],
      ['assist', session('cli', ['p1', 'p2'], ['https://example.com/pr/1'])],
      ['agent', session('claude-vscode', ['p1'], ['https://example.com/pr/2', 'https://example.com/pr/3'])],
      ['multi', session('cli', ['p1'])],
    ]),
  };
}

test('buildAdoption: cohorts, weekly mix, capabilities, surfaces and summary', () => {
  const doc = buildAdoption(fixture(), { timeZone: 'UTC', showCost: false });
  assert.deepEqual(
    Object.fromEntries(doc.stats.map((s) => [s.id, s.phase])),
    { chat: 'chat', assist: 'assisted', agent: 'agent', multi: 'multi' },
  );
  const [cohorts, weekly, capabilities, surfaces] = doc.sections;
  assert.equal(cohorts.cards, true);
  const agentRow = cohorts.rows[2].cells;
  assert.equal(agentRow[0], 'Phase 2 · Agent-first');
  assert.deepEqual(agentRow[2], { kind: 'avg', v: 2 }); // PRs per session
  assert.equal(agentRow[3], 1); // sessions
  assert.deepEqual(weekly.rows.map((r) => r.cells[0]), ['2026-09-28']); // Oct 1-4, 2026 is Thu-Sun of one week
  assert.equal(weekly.rows[0].cells[1], 4);
  const used = Object.fromEntries(capabilities.rows.map((r) => [r.cells[0], r.cells[1]]));
  assert.equal(used['Background agents'], 1);
  assert.equal(used['Pull requests'], 2);
  assert.deepEqual(surfaces.rows.map((r) => r.cells[0]), ['CLI', 'VS Code']);
  assert.ok(doc.summary.some((l) => l.startsWith('PRs per session: Assisted 1.00, Agent-first 2.00, Multi-agent 0.00')));
  assert.ok(doc.summary.some((l) => l.includes('Not used in this period') && l.includes('worktrees')));
});

test('adoption renders as cards in HTML and as tables in Markdown', () => {
  const doc = buildAdoption(fixture(), { timeZone: 'UTC', showCost: false });
  const html = toHtml(doc);
  assert.equal((html.match(/<div class="card">/g) ?? []).length, 4);
  assert.match(html, /<h3>Phase 3 · Multi-agent<\/h3>/);
  assert.match(html, /<ul class="summary"><li>Most of your sessions are/);
  const md = toMarkdown(doc);
  assert.match(md, /^# Claude Code adoption\n\n- Most of your sessions/);
  assert.match(md, /## Adoption cohorts/);
});
