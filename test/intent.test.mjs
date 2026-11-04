import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent, fileKind, promptText, workMessages } from '../src/intent.mjs';
import { patchFiles } from '../src/loader.mjs';

const intent = (s) => classifyIntent({ files: {}, newFiles: 0, edits: 1, ...s }).intent;

test('workMessages reads commit messages and PR titles in any quoting', () => {
  assert.deepEqual(workMessages('git add . && git commit -m "fix: keep the account" && git push'), ['fix: keep the account']);
  assert.deepEqual(workMessages("git commit -q -m 'feat(ui): fullscreen view'"), ['feat(ui): fullscreen view']);
  assert.deepEqual(workMessages(`git commit -m "$(cat <<'EOF'\nrefactor: split loader\n\nBody\nEOF\n)"`), ['refactor: split loader']);
  assert.deepEqual(workMessages("git commit -q -m @'\nAdd working habits\n\nBody\n'@"), ['Add working habits']);
  assert.deepEqual(workMessages('gh pr create --title "docs: README" --body "x"'), ['docs: README']);
  assert.deepEqual(workMessages('git status; git log --oneline'), []);
});

test('promptText drops the tags around commands and attachments', () => {
  assert.equal(promptText('<command-name>/fix-bug</command-name>\n<command-args>login fails</command-args>'), '/fix-bug login fails');
  assert.equal(promptText('<system-reminder>ignore</system-reminder>  why   is it slow?'), 'why is it slow?');
});

test('fileKind tells plans, docs, tests, ops and code apart', () => {
  assert.equal(fileKind('Z:\\repo\\.agentic\\specs\\plan-caching.md'), 'plans');
  assert.equal(fileKind('docs/plan-x.md'), 'plans');
  assert.equal(fileKind('README.md'), 'docs');
  assert.equal(fileKind('test/adoption.test.mjs'), 'tests');
  assert.equal(fileKind('src/app.spec.ts'), 'tests');
  assert.equal(fileKind('.github/workflows/ci.yml'), 'ops');
  assert.equal(fileKind('src/Api/Api.csproj'), 'ops');
  assert.equal(fileKind('src/loader.mjs'), 'code');
});

test('patchFiles splits updated and added files', () => {
  const patch = '*** Begin Patch\n*** Update File: C:\\src\\a.cs\r\n@@\n*** Add File: b.cs\n+z\n*** Update File: src/c.ts\n*** End Patch';
  assert.deepEqual(patchFiles(patch), { updated: ['C:\\src\\a.cs', 'src/c.ts'], added: ['b.cs'] });
  assert.deepEqual(patchFiles(undefined), { updated: [], added: [] });
});

test('classifyIntent: commits outrank branches, titles and prompts', () => {
  assert.equal(intent({ workMessages: ['fix: null check'], branches: ['feature/login'] }), 'bugfix');
  assert.equal(intent({ workMessages: ['refactor(loader): split'], title: 'Add a page' }), 'refactor');
  assert.equal(intent({ branches: ['feature/login'], firstPrompt: 'go on' }), 'feature');
  assert.equal(intent({ branches: ['main'], title: 'Login button does not work' }), 'bugfix');
  assert.equal(intent({ title: 'Rename the services and clean up' }), 'refactor');
  assert.equal(intent({ commands: ['/code-review'] }), 'review');
  assert.equal(intent({ title: 'Adoption cohorts plan mode', firstPrompt: 'add plan mode to the report' }), 'feature');
});

test('classifyIntent: what the session changed', () => {
  // Read and answered, nothing changed.
  assert.equal(classifyIntent({ firstPrompt: 'ls', edits: 0 }).intent, 'research');
  assert.equal(intent({ firstPrompt: 'why is there a single database?', edits: 0 }), 'research');
  // Research words, but code changed: the work wins.
  assert.equal(intent({ firstPrompt: 'look at the login, the button is broken', files: { code: 2 } }), 'bugfix');
  assert.equal(intent({ firstPrompt: 'go on', files: { plans: 2 } }), 'planning');
  assert.equal(intent({ firstPrompt: 'go on', files: { docs: 1 } }), 'docs');
  assert.equal(intent({ firstPrompt: 'go on', files: { tests: 3 } }), 'tests');
  assert.equal(intent({ firstPrompt: 'go on', files: { ops: 1 } }), 'ops');
  assert.equal(intent({ firstPrompt: 'go on', files: { code: 3 }, newFiles: 3 }), 'feature');
  const other = classifyIntent({ firstPrompt: 'go on', files: { code: 3 }, newFiles: 0, edits: 3 });
  assert.deepEqual(other, { intent: 'other', evidence: [] });
});

test('classifyIntent names the signals that decided', () => {
  const { intent: i, evidence } = classifyIntent({ workMessages: ['feat: x'], branches: ['feature/x'], files: { code: 3 }, newFiles: 3, edits: 3 });
  assert.equal(i, 'feature');
  assert.deepEqual(evidence, ['commit', 'branch', 'activity']);
});
