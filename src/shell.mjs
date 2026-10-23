// Extracts the programs a Bash or PowerShell tool call ran: the first word of
// every pipeline stage, list element, subshell and script block. Quoted text,
// heredocs, here-strings and comments are never split, so inline code
// (python -c "...", cat <<EOF ... EOF) does not show up as commands.

export const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// Words that start or continue a segment without being the command themselves.
const PREFIX = {
  Bash: new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'time', 'exec', 'sudo', 'command', 'nohup']),
  PowerShell: new Set(['if', 'else', 'elseif', 'do', 'while', 'until', 'try', 'catch', 'finally', 'return', 'throw', '.', '&']),
};
// Segments that are control flow or definitions, not a program run.
const CONTROL = {
  Bash: new Set(['for', 'case', 'esac', 'in', 'done', 'fi', 'function', 'select', 'local', 'declare', 'return', 'exit', 'break', 'continue', '[', '[[', 'true', 'false']),
  PowerShell: new Set(['foreach', 'for', 'switch', 'function', 'filter', 'param', 'begin', 'process', 'end', 'exit', 'break', 'continue']),
};

const SEPARATORS = new Set([';', '&', '|', '\n', '{', '}']);

/** Index of the quote closing the string opened at `i`; "..." may hold $( ... ) with quotes of its own. */
function closingQuote(src, i, ps) {
  if (src[i] === "'") {
    const end = src.indexOf("'", i + 1);
    return end === -1 ? src.length : end;
  }
  const escape = ps ? '`' : '\\';
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === escape) j++;
    else if (src[j] === '"') return j;
    else if (src[j] === '$' && src[j + 1] === '(') j = closingParen(src, j + 1, ps);
  }
  return src.length;
}

/** Index of the bracket closing the one at `i` (( or {), skipping quoted text. */
function closingBracket(src, i, ps) {
  const [open, close] = src[i] === '{' ? ['{', '}'] : ['(', ')'];
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "'" || src[j] === '"') j = closingQuote(src, j, ps);
    else if (src[j] === open) depth++;
    else if (src[j] === close && --depth === 0) return j;
  }
  return src.length;
}
const closingParen = closingBracket;
const closingBrace = closingBracket;

/** Splits a command line into segments (arrays of { text, quoted } words), honoring quotes, heredocs and comments. */
export function segments(command, shell = 'Bash') {
  const ps = shell === 'PowerShell';
  const src = String(command ?? '').replace(/\r\n?/g, '\n');
  const out = [];
  let words = [];
  let word = '';
  let inWord = false;
  let quoted = false; // the current word holds quoted text
  const heredocs = []; // delimiters whose bodies start after the current line
  const outer = []; // state of the commands enclosing the current ( ... )

  const endWord = () => {
    if (inWord) words.push({ text: word, quoted });
    word = '';
    inWord = false;
    quoted = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (ch === '\n') {
      endSegment();
      // Skip heredoc bodies that were opened on this line.
      while (heredocs.length) {
        const delimiter = heredocs.shift();
        let end = src.indexOf('\n', i + 1);
        while (true) {
          const line = src.slice(i + 1, end === -1 ? src.length : end);
          i = end === -1 ? src.length : end;
          if (line.trim() === delimiter || end === -1) break;
          end = src.indexOf('\n', i + 1);
        }
      }
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      endWord();
      continue;
    }
    // Comments run to the end of the line.
    if (ch === '#' && !inWord) {
      const end = src.indexOf('\n', i);
      i = (end === -1 ? src.length : end) - 1;
      continue;
    }
    // PowerShell here-strings: @' ... '@ and @" ... "@.
    if (ps && ch === '@' && !inWord && (src[i + 1] === "'" || src[i + 1] === '"') && src[i + 2] === '\n') {
      const end = src.indexOf(`\n${src[i + 1]}@`, i + 2);
      i = end === -1 ? src.length : end + 2;
      word = '';
      inWord = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const j = closingQuote(src, i, ps);
      word += src.slice(i + 1, j);
      inWord = true;
      quoted = true;
      i = j;
      continue;
    }
    // Escapes: a backslash in Bash, a backtick in PowerShell (also line continuation).
    if ((!ps && ch === '\\') || (ps && ch === '`')) {
      if (src[i + 1] === '\n') i++;
      else {
        word += src[i + 1] ?? '';
        inWord = true;
        i++;
      }
      continue;
    }
    if (!ps && ch === '`') {
      endSegment();
      continue;
    }
    if (!ps && ch === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      const m = /^<<-?\s*(['"]?)([\w.-]+)\1/.exec(src.slice(i));
      if (m) {
        heredocs.push(m[2]);
        endWord();
        i += m[0].length - 1;
        continue;
      }
    }
    // ( $( <( @( open a nested command list; the outer command resumes after
    // the ), its word continuing. ${...} and $var stay part of the word.
    if (ch === '(' || (ch === '$' && src[i + 1] === '(')) {
      outer.push({ words, word, inWord, quoted });
      words = [];
      word = '';
      inWord = false;
      quoted = false;
      if (ch === '$') i++;
      continue;
    }
    if (ch === ')') {
      endSegment();
      if (outer.length) ({ words, word, quoted } = outer.pop());
      inWord = true;
      continue;
    }
    // ${var} and PowerShell @{ hashtables } are part of the word.
    if ((ch === '$' || (ps && ch === '@')) && src[i + 1] === '{') {
      const j = closingBrace(src, i + 1, ps);
      word += src.slice(i, j + 1);
      inWord = true;
      i = j;
      continue;
    }
    // PowerShell: a single & is the call operator, && chains.
    if (ps && ch === '&' && src[i + 1] !== '&' && src[i - 1] !== '&' && !inWord) {
      endWord();
      words.push({ text: '&', quoted: false });
      continue;
    }
    if (SEPARATORS.has(ch)) {
      // 2>&1, &>, >& are redirections, not separators.
      if (ch === '&' && (src[i - 1] === '>' || src[i + 1] === '>')) {
        word += ch;
        inWord = true;
        continue;
      }
      endSegment();
      continue;
    }
    word += ch;
    inWord = true;
  }
  endSegment();
  return out;
}

// What a program is used for, to group the shell commands report. Keys are
// lower-case; anything not listed is "Other".
const CATEGORY_PROGRAMS = {
  'Search & read files': [
    'grep', 'egrep', 'rg', 'ag', 'head', 'tail', 'cat', 'less', 'more', 'ls', 'dir', 'find', 'fd', 'tree', 'file',
    'stat', 'du', 'df', 'diff', 'comm', 'od', 'xxd', 'hexdump', 'strings', 'realpath', 'readlink', 'basename',
    'dirname', 'cygpath', 'which', 'where', 'whereis', 'type', 'pwd',
    'select-string', 'sls', 'get-childitem', 'gci', 'get-content', 'gc', 'get-item', 'gi', 'get-itemproperty',
    'test-path', 'resolve-path', 'split-path', 'join-path', 'get-location', 'gl', 'get-command', 'gcm',
    'import-csv', 'compare-object', 'get-filehash',
  ],
  'Change directory': ['cd', 'pushd', 'popd', 'set-location', 'sl', 'push-location', 'pop-location', 'chdir'],
  'Text & data processing': [
    'sed', 'awk', 'gawk', 'cut', 'sort', 'uniq', 'tr', 'wc', 'xargs', 'jq', 'yq', 'paste', 'column', 'fold', 'rev',
    'nl', 'tac', 'base64', 'md5sum', 'sha256sum', 'iconv', 'dos2unix', 'unix2dos',
    'select-object', 'select', 'foreach-object', '%', 'where-object', '?', 'sort-object', 'sort', 'group-object',
    'group', 'measure-object', 'measure', 'convertfrom-json', 'convertto-json', 'convertfrom-csv', 'convertto-csv',
    'out-string', 'format-table', 'ft', 'format-list', 'fl', 'format-wide', 'join-string', 'out-null',
    'select-xml', 'new-object', 'add-member', 'get-member', 'tee-object',
  ],
  'Print output': ['echo', 'printf', 'write-host', 'write-output', 'write-error', 'write-warning', 'write-verbose'],
  'Create, move & delete files': [
    'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'touch', 'ln', 'chmod', 'chown', 'tee', 'unzip', 'zip', 'tar', 'gzip',
    'gunzip', '7z', 'new-item', 'ni', 'remove-item', 'ri', 'del', 'erase', 'copy-item', 'copy', 'cpi', 'move-item',
    'move', 'mi', 'rename-item', 'ren', 'set-content', 'sc', 'add-content', 'ac', 'out-file', 'expand-archive',
    'compress-archive', 'clear-content',
  ],
  'Git & GitHub': ['git', 'gh', 'glab', 'tig'],
  'Build, run & test': [
    'dotnet', 'msbuild', 'nuget', 'python', 'python3', 'py', 'pip', 'pip3', 'uv', 'uvx', 'pytest', 'node', 'npm',
    'npx', 'pnpm', 'yarn', 'bun', 'deno', 'tsc', 'tsx', 'jest', 'vitest', 'eslint', 'prettier', 'java', 'javac',
    'gradle', 'gradlew', 'gradlew.bat', 'mvn', 'mvnw', 'cargo', 'rustc', 'go', 'make', 'cmake', 'ninja', 'gcc',
    'g++', 'clang', 'perl', 'ruby', 'php', 'composer', 'bash', 'sh', 'zsh', 'pwsh', 'powershell', 'cmd',
    'ilspycmd', 'aspire', 'playwright',
  ],
  'Cloud, containers & network': [
    'az', 'aws', 'gcloud', 'kubectl', 'helm', 'docker', 'docker-compose', 'podman', 'terraform', 'func', 'azd',
    'curl', 'wget', 'ssh', 'scp', 'rsync', 'ping', 'nslookup', 'dig', 'netstat', 'adb', 'openssl',
    'invoke-restmethod', 'irm', 'invoke-webrequest', 'iwr', 'test-netconnection',
  ],
  'Processes & system': [
    'sleep', 'timeout', 'kill', 'pkill', 'ps', 'top', 'taskkill', 'tasklist', 'nohup', 'env', 'export', 'set',
    'unset', 'source', 'date', 'whoami', 'hostname', 'uname', 'seq', 'read', 'test', 'start', 'open', 'xdg-open',
    'explorer', 'claude', 'start-sleep', 'get-process', 'gps', 'stop-process', 'start-process', 'saps',
    'wait-process', 'get-ciminstance', 'get-wmiobject', 'get-date', 'get-service', 'get-host', 'invoke-item', 'ii',
    'invoke-expression', 'iex', 'add-type', 'start-job', 'receive-job', 'wait-job', 'get-job', 'set-executionpolicy',
    'get-psdrive', 'get-variable', 'set-variable', 'clear-host', 'reg', 'setx', 'winget', 'choco', 'scoop',
  ],
};
export const OTHER_CATEGORY = 'Other';
export const CATEGORIES = [...Object.keys(CATEGORY_PROGRAMS), OTHER_CATEGORY];
const CATEGORY_OF = new Map(
  Object.entries(CATEGORY_PROGRAMS).flatMap(([category, programs]) => programs.map((p) => [p, category])),
);

/** The purpose of a program, e.g. "grep" -> "Search & read files". */
export function commandCategory(name) {
  return CATEGORY_OF.get(String(name).toLowerCase()) ?? OTHER_CATEGORY;
}

/** "C:\tools\node.exe" -> "node", "./run.sh" -> "run.sh". */
function programName(word) {
  const base = word.split(/[\\/]/).filter(Boolean).pop() ?? '';
  return base.replace(/\.exe$/i, '');
}

/** The distinct programs a shell command ran, in order of first use. */
export function shellCommands(command, shell = 'Bash') {
  const prefix = PREFIX[shell] ?? PREFIX.Bash;
  const control = CONTROL[shell] ?? CONTROL.Bash;
  const ps = shell === 'PowerShell';
  const found = [];
  const all = segments(command, shell);
  // Functions the command defines itself are not programs.
  const defined = new Set(
    all.filter((p) => p[0].text.toLowerCase() === 'function' && p[1]).map((p) => (ps ? p[1].text.toLowerCase() : p[1].text)),
  );
  for (const parts of all) {
    const words = parts.map((w) => w.text);
    let i = 0;
    while (i < words.length) {
      const w = ps ? words[i].toLowerCase() : words[i];
      if (prefix.has(w)) i++;
      else if (/^[A-Za-z_]\w*=/.test(words[i])) i++; // Bash: FOO=bar cmd
      else if (words[i].startsWith('$') && /^[+\-*/]?=$/.test(words[i + 1] ?? '')) i += 2; // PowerShell: $x = cmd
      else break;
    }
    const word = words[i];
    if (!word || control.has(ps ? word.toLowerCase() : word) || defined.has(ps ? word.toLowerCase() : word)) continue;
    // A quoted string in PowerShell is a value, unless run with & or dot-sourced.
    if (ps && parts[i].quoted && !['&', '.'].includes(words[i - 1])) continue;
    // Variables, options, redirections, numbers, literals, type
    // accessors ([IO.File]::...) and members (.Count) are not programs.
    if (/^[$\-<>@0-9=,+*%[(]|^\.\w/.test(word)) continue;
    const name = programName(word);
    if (/^[A-Za-z_][\w.+-]*$/.test(name) && !found.includes(name)) found.push(name);
  }
  return found;
}
