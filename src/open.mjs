// Opens a file with the application the operating system associates with it
// (browser for .html, Excel for .csv, an editor for .md / .json / .txt).

import { spawn } from 'node:child_process';
import path from 'node:path';

/** The command that opens `file` on this platform. */
export function openCommand(file, platform = process.platform) {
  const abs = path.resolve(file);
  if (platform === 'win32') {
    // `start` is a cmd built-in; the empty "" is the window title it expects first.
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', `start "" "${abs}"`], options: { windowsVerbatimArguments: true } };
  }
  if (platform === 'darwin') return { command: 'open', args: [abs], options: {} };
  return { command: 'xdg-open', args: [abs], options: {} };
}

/** Launches the associated application without waiting for it. Resolves to an error message, or null. */
export function openFile(file) {
  const { command, args, options } = openCommand(file);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { ...options, detached: true, stdio: 'ignore' });
    } catch (err) {
      resolve(err.message);
      return;
    }
    child.once('error', (err) => resolve(err.message));
    child.once('spawn', () => {
      child.unref();
      resolve(null);
    });
  });
}

/** File extension for a report format, for a report written to a temp file. */
export const FORMAT_EXTENSIONS = { table: '.txt', json: '.json', csv: '.csv', markdown: '.md', html: '.html' };
