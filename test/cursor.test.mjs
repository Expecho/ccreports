import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadCursorRecords, parsePromptTime, decodeProjectDir } from '../src/cursor.mjs';
import { aggregate } from '../src/aggregate.mjs';
import { buildSummary } from '../src/report.mjs';
import { sessionStats } from '../src/adoption.mjs';

test('parsePromptTime reads Cursor prompt timestamps with their UTC offset', () => {
  assert.equal(parsePromptTime('Tuesday, Oct 27, 2026, 2:44 PM (UTC+1)'), '2026-10-27T13:44:00.000Z');
  assert.equal(parsePromptTime('Monday, Jan 5, 2026, 12:05 AM (UTC-5)'), '2026-01-05T05:05:00.000Z');
  assert.equal(parsePromptTime('Friday, Mar 6, 2026, 9:30 AM'), '2026-03-06T09:30:00.000Z');
  assert.equal(parsePromptTime('no time here'), null);
});

test('decodeProjectDir picks the separators that match existing folders', () => {
  const existing = new Set(['Z:\\Sources', 'Z:\\Sources\\Ibis.Calculeren.Shared', 'C:\\Users', 'C:\\Users\\PeterBons']);
  const exists = (p) => existing.has(p);
  assert.equal(decodeProjectDir('Z-Sources-Ibis-Calculeren-Shared', exists), 'Z:\\Sources\\Ibis.Calculeren.Shared');
  assert.equal(decodeProjectDir('C-Users-PeterBons', exists), 'C:\\Users\\PeterBons');
  assert.equal(decodeProjectDir('empty-window', exists), '(no folder)');
  assert.equal(decodeProjectDir('Q-gone-away', exists), 'Q-gone-away');
});

const user = (text) => ({ role: 'user', message: { content: [{ type: 'text', text } ] } });
const assistant = (...content) => ({ role: 'assistant', message: { content } });
const use = (name, input) => ({ type: 'tool_use', name, input });

// Recent format: timestamps, a skill attached with /github, dynamic tools.
const recent = [
  user('<timestamp>Tuesday, Oct 27, 2026, 2:44 PM (UTC+1)</timestamp>\n<user_query>\nplan a page\n</user_query>'),
  assistant(
    { type: 'text', text: 'Planning.' },
    use('CallDynamicTool', { namespace: 'cursor', toolName: 'SwitchMode', arguments: { target_mode_id: 'plan' } }),
    use('Read', { path: 'C:\\Users\\me\\.cursor\\skills\\browseros-neo\\SKILL.md' }),
    use('Read', { path: 'Z:\\Sources\\ccreports\\skills\\report\\SKILL.md' }), // a plugin's source, not a skill in use
    use('Shell', { command: 'git status; gh pr list' }),
    use('Write', { path: 'z:\\temp\\index.html', contents: '<p>hi</p>' }),
    use('CallDynamicTool', { namespace: 'github', toolName: 'search_code', arguments: {} }),
  ),
  { type: 'turn_ended', status: 'success' },
  user(
    '<manually_attached_skills>\nSkill Name: github\nPath: C:\\Users\\me\\.claude\\skills\\github\\SKILL.md\nSKILL.md content:\n...\n</manually_attached_skills>\n<timestamp>Tuesday, Oct 27, 2026, 2:50 PM (UTC+1)</timestamp>\n<user_query>\n/github\n</user_query>',
  ),
  assistant(use('Shell', { command: 'gh auth status' })),
];

// Older format: no timestamps, a /command whose skill the agent then reads.
const older = [
  user('<user_query>\n/create-a-text-file\n</user_query>'),
  assistant(use('Read', { path: 'Z:\\Sources\\Test\\.claude\\skills\\create-a-text-file\\SKILL.md' })),
  user('not a prompt: no user_query tag'),
];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ccreports-cursor-'));
  const transcript = async (project, id, lines) => {
    const dir = path.join(root, 'projects', project, 'agent-transcripts', id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n');
  };
  await transcript('C-Users-me', 'cli-1', recent);
  await transcript('empty-window', 'ide-1', older);
  // The CLI keeps its own metadata per session; the editor doesn't.
  await mkdir(path.join(root, 'chats', 'hash', 'cli-1'), { recursive: true });
  await writeFile(
    path.join(root, 'chats', 'hash', 'cli-1', 'meta.json'),
    JSON.stringify({ cwd: 'C:\\Users\\me', title: 'Page Plan' }),
  );
  return root;
}

test('loadCursorRecords reads prompts, tools, skills and commands from agent transcripts', async () => {
  const root = await fixture();
  try {
    const data = await loadCursorRecords({ dirs: [root] });
    assert.equal(data.files, 2);
    assert.equal(data.usage.length, 0);
    assert.equal(data.titles.get('cli-1'), 'Page Plan');

    const cli = data.sessions.get('cli-1');
    assert.equal(cli.entrypoint, 'cursor-cli');
    assert.equal(cli.prompts.size, 2);
    assert.deepEqual([...cli.modes], ['plan']);
    assert.equal(data.sessions.get('ide-1').entrypoint, 'cursor-ide');
    assert.equal(data.sessions.get('ide-1').prompts.size, 1);

    const names = data.tools.filter((t) => t.sessionId === 'cli-1').map((t) => t.name);
    assert.deepEqual(names, ['SwitchMode', 'Read', 'Read', 'Shell', 'Write', 'mcp__github__search_code', 'Shell']);
    const shell = data.tools.find((t) => t.name === 'Shell');
    assert.deepEqual(shell.shellCommands.map((c) => c.toLowerCase()), ['git', 'gh']);
    assert.equal(data.tools.find((t) => t.name === 'Write').edit, true);

    // Each record has the time of the prompt that started its turn.
    assert.equal(data.tools.find((t) => t.name === 'Write').timestamp, '2026-10-27T13:44:00.000Z');
    assert.equal(data.tools.at(-2).timestamp, '2026-10-27T13:50:00.000Z');
    assert.equal(data.tools.at(-2).project, 'C:\\Users\\me');

    assert.deepEqual(
      data.skills.map((s) => [s.sessionId, s.name, s.source]).sort(),
      [
        ['cli-1', 'browseros-neo', 'model'],
        ['cli-1', 'github', 'user'],
        ['ide-1', 'create-a-text-file', 'user'],
      ],
    );
    assert.deepEqual(data.commands.map((c) => c.name).sort(), ['/create-a-text-file', '/github']);
    assert.equal(data.events.length, 3); // one per prompt
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Cursor activity counts sessions without tokens, and reports drop token columns', async () => {
  const root = await fixture();
  try {
    const data = await loadCursorRecords({ dirs: [root] });
    const result = aggregate(data, {});
    assert.equal(result.totals.sessions.size, 2);
    assert.equal(result.totals.totalTokens, 0);

    const doc = buildSummary(result, { top: 15, showCost: false, tokens: false, product: 'Cursor' });
    assert.equal(doc.title, 'Cursor usage summary');
    assert.deepEqual(
      doc.sections[0].columns.map((c) => c.title),
      ['Sessions', 'Projects', 'Tools', 'Skills', 'Cmds', 'Agents'],
    );
    const tools = doc.sections.find((s) => s.title === 'Tools');
    assert.deepEqual(tools.columns.map((c) => c.title), ['Tool', 'Calls', 'Share']);

    const stats = sessionStats(data, {});
    assert.deepEqual(
      stats.map((s) => [s.id, s.surface, s.edits]).sort(),
      [
        ['cli-1', 'Cursor CLI', 1],
        ['ide-1', 'Cursor editor', 0],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
