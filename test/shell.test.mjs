import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellCommands, commandCategory, OTHER_CATEGORY } from '../src/shell.mjs';

test('commands are grouped by purpose, case-insensitively', () => {
  assert.equal(commandCategory('grep'), 'Search & read files');
  assert.equal(commandCategory('select-string'), 'Search & read files');
  assert.equal(commandCategory('Set-Location'), 'Change directory');
  assert.equal(commandCategory('git'), 'Git & GitHub');
  assert.equal(commandCategory('my-script.sh'), OTHER_CATEGORY);
});

test('Bash: every pipeline stage and list element, quotes not split', () => {
  assert.deepEqual(shellCommands('cd /z/x && git status && grep -n "a|b" f | head -5'), ['cd', 'git', 'grep', 'head']);
  assert.deepEqual(shellCommands('echo $(git rev-parse HEAD) `date`; python -c "import a; b|c"'), ['git', 'echo', 'date', 'python']);
  assert.deepEqual(shellCommands('ls 2>&1 | sort &> out.txt'), ['ls', 'sort']);
  assert.deepEqual(shellCommands('echo "n=$(grep -c "a" f | wc -l) $(date)"; rg x'), ['echo', 'rg']);
  // The outer command resumes after a substitution: /dev/null and b.txt are arguments.
  assert.deepEqual(shellCommands('diff <(sed -n 1,80p a.yml) /dev/null | head; cp $(ls *.md) b.txt'), ['sed', 'diff', 'head', 'ls', 'cp']);
  assert.deepEqual(shellCommands('(cd x && make) && echo ok'), ['cd', 'make', 'echo']);
});

test('Bash: heredoc bodies and comments are not commands', () => {
  const cmd = "cat > f.py <<'EOF'\nimport os\ndef x(): pass\nEOF\npython f.py 2>&1 | tail # then | foo";
  assert.deepEqual(shellCommands(cmd), ['cat', 'python', 'tail']);
});

test('Bash: control flow, assignments and paths', () => {
  assert.deepEqual(shellCommands('for f in *.js; do wc -l "$f"; done; X=1 /usr/bin/node a.js'), ['wc', 'node']);
  assert.deepEqual(shellCommands('if [ -f x ]; then rm x; else ./build.sh; fi'), ['rm', 'build.sh']);
});

test('PowerShell: script blocks, assignments, call operator and here-strings', () => {
  assert.deepEqual(
    shellCommands('Get-ChildItem -Recurse | Where-Object { $_.Length -gt 1 } | ForEach-Object { Write-Host $_.Name }', 'PowerShell'),
    ['Get-ChildItem', 'Where-Object', 'ForEach-Object', 'Write-Host'],
  );
  assert.deepEqual(
    shellCommands('$x = Get-Content f.json | ConvertFrom-Json; & "C:\\Program Files\\Git\\bin\\git.exe" log', 'PowerShell'),
    ['Get-Content', 'ConvertFrom-Json', 'git'],
  );
  assert.deepEqual(
    shellCommands('function Show($p) { Get-Content $p }; Show a.txt; "$($x.Count) files"; (Get-Item x).Length; [IO.File]::ReadAllText($f)', 'PowerShell'),
    ['Get-Content', 'Get-Item'],
  );
  assert.deepEqual(
    shellCommands("git commit -m @'\nmsg; with | pipes\n'@\nforeach ($f in $files) { Remove-Item $f }", 'PowerShell'),
    ['git', 'Remove-Item'],
  );
});

test('a call is counted once per purpose, its tokens split without double counting', async () => {
  const { aggregate, toJSON } = await import('../src/aggregate.mjs');
  const tool = (shellCommands, total) => ({
    timestamp: '2026-10-01T10:00:00Z',
    sessionId: 's1',
    project: '/work',
    name: 'Bash',
    shellCommands,
    tokens: { total, outputTokens: 0, cacheWriteTokens: total, cacheReadTokens: 0 },
  });
  const data = {
    usage: [],
    tools: [tool(['cd', 'grep', 'head'], 100), tool(['cd'], 10)],
    skills: [],
    commands: [],
    hooks: [],
    titles: new Map(),
  };
  const { shellCommands, shellCategories } = toJSON(aggregate(data).totals);
  // cd prints nothing: tokens only for the call that ran nothing else.
  assert.deepEqual(
    Object.fromEntries(Object.entries(shellCommands.Bash).map(([k, v]) => [k, [v.calls, v.tokens]])),
    { cd: [2, 10], grep: [1, 50], head: [1, 50] },
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(shellCategories.Bash).map(([k, v]) => [k, [v.calls, v.tokens]])),
    { 'Change directory': [2, 10], 'Search & read files': [1, 100] },
  );
});
