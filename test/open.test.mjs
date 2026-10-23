import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openCommand, FORMAT_EXTENSIONS } from '../src/open.mjs';

test('opens with the platform launcher, by absolute path', () => {
  const abs = path.resolve('report.html');
  assert.deepEqual(openCommand('report.html', 'darwin'), { command: 'open', args: [abs], options: {} });
  assert.deepEqual(openCommand('report.html', 'linux'), { command: 'xdg-open', args: [abs], options: {} });
  const win = openCommand('my report.html', 'win32');
  assert.equal(win.command, 'cmd.exe');
  // `start` takes a window title first; the quoted path survives spaces.
  assert.equal(win.args.at(-1), `start "" "${path.resolve('my report.html')}"`);
  assert.equal(win.options.windowsVerbatimArguments, true);
});

test('every format has a file extension', () => {
  for (const f of ['table', 'json', 'csv', 'markdown', 'html']) assert.match(FORMAT_EXTENSIONS[f], /^\.\w+$/);
});
