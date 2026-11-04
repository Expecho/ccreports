import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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

// Cursor's database: one chat that also has a transcript, one without, and a draft.
async function userDir() {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = await mkdtemp(path.join(tmpdir(), 'ccreports-cursor-user-'));
  const project = path.join(dir, 'App');
  const ws = path.join(dir, 'workspaceStorage', 'abc');
  await mkdir(path.join(dir, 'globalStorage'), { recursive: true });
  await mkdir(ws, { recursive: true });
  await mkdir(project);
  await writeFile(path.join(ws, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(project).href }));
  const wdb = new DatabaseSync(path.join(ws, 'state.vscdb'));
  wdb.exec('create table ItemTable (key text, value text)');
  wdb.prepare('insert into ItemTable values (?, ?)').run('composer.composerData', JSON.stringify({ allComposers: [{ composerId: 'old-1' }] }));
  wdb.close();

  const db = new DatabaseSync(path.join(dir, 'globalStorage', 'state.vscdb'));
  db.exec('create table cursorDiskKV (key text, value text)');
  const put = (key, value) => db.prepare('insert into cursorDiskKV values (?, ?)').run(key, JSON.stringify(value));
  put('composerData:ide-1', { unifiedMode: 'agent', modelConfig: { modelName: 'claude-4.5-opus-high-thinking' } });
  put('composerData:old-1', {
    name: 'Fix the build',
    unifiedMode: 'plan',
    modelConfig: { modelName: 'default' },
    createdAt: Date.parse('2025-12-06T11:00:00Z'),
    fullConversationHeadersOnly: [{ bubbleId: 'b1' }, { bubbleId: 'b2' }, { bubbleId: 'b3' }],
  });
  put('composerData:draft', { unifiedMode: 'agent', modelConfig: { modelName: 'default' } });
  put('bubbleId:old-1:b3', { type: 2, createdAt: '2025-12-06T11:00:09Z', toolFormerData: { name: 'run_terminal_cmd', rawArgs: JSON.stringify({ command: 'git status' }) } });
  put('bubbleId:old-1:b1', { type: 1, createdAt: '2025-12-06T11:00:02Z', text: 'never read' });
  put('bubbleId:old-1:b2', { type: 2, createdAt: '2025-12-06T11:00:08Z', toolFormerData: { name: 'search_replace', rawArgs: '{}' } });
  db.close();
  return dir;
}

test("Cursor's database adds model choice and mode, and chats without a transcript", async (t) => {
  try {
    await import('node:sqlite');
  } catch {
    return t.skip('node:sqlite needs Node 22.13+');
  }
  const root = await fixture();
  const dir = await userDir();
  try {
    const data = await loadCursorRecords({ dirs: [root], userDirs: [dir] });
    assert.equal(data.stateSkipped, false);
    assert.equal(data.files, 3); // two transcripts + one chat from the database; the draft is skipped
    assert.equal(data.sessions.has('draft'), false);

    // A chat with a transcript keeps its activity and gains model choice and mode.
    const ide = data.sessions.get('ide-1');
    assert.equal(ide.modelChoice, 'claude-4.5-opus-high-thinking');
    assert.deepEqual([...ide.modes], ['agent']);

    const old = data.sessions.get('old-1');
    assert.equal(old.entrypoint, 'cursor-ide');
    assert.equal(old.prompts.size, 1);
    assert.equal(old.modelChoice, 'default');
    assert.deepEqual([...old.modes], ['plan']);
    assert.equal(data.titles.get('old-1'), 'Fix the build');
    const tools = data.tools.filter((x) => x.sessionId === 'old-1');
    assert.deepEqual(tools.map((x) => [x.name, x.timestamp]), [
      ['search_replace', '2025-12-06T11:00:08Z'],
      ['run_terminal_cmd', '2025-12-06T11:00:09Z'],
    ]);
    assert.equal(tools[0].edit, true);
    assert.deepEqual(tools[1].shellCommands.map((c) => c.toLowerCase()), ['git']);
    assert.equal(tools[0].project.toLowerCase(), path.join(dir, 'App').toLowerCase());

    // Auto model: share of the sessions that log the model picked.
    const stats = sessionStats(data, {});
    assert.deepEqual(stats.filter((s) => s.autoModel).map((s) => s.id), ['old-1']);
    assert.equal(stats.filter((s) => s.modelChoice != null).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
