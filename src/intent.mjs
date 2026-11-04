// Session intent: what a session was for (bug fix, new development,
// refactoring, ...), from rules over what the logs say about it. Signals, from
// strong to weak: conventional commit and PR titles the session wrote, review
// commands, the session title, the git branch, the first prompt, and what the
// session did (which files it changed, or that it changed none).

export const INTENTS = [
  { key: 'bugfix', title: 'Bug fix', description: 'Fixing something that is broken' },
  { key: 'feature', title: 'New development', description: 'Adding features, pages, apps' },
  { key: 'refactor', title: 'Refactoring', description: 'Restructuring, renaming, upgrading' },
  { key: 'tests', title: 'Tests', description: 'Writing or fixing tests' },
  { key: 'planning', title: 'Planning & design', description: 'Plans, specs, architecture' },
  { key: 'docs', title: 'Docs & content', description: 'READMEs, docs, articles, course material' },
  { key: 'ops', title: 'Ops & config', description: 'CI, deploys, settings, dependencies' },
  { key: 'review', title: 'Review', description: 'Reviewing code or a PR' },
  { key: 'research', title: 'Research & analysis', description: 'Questions, explanations, investigations' },
  { key: 'other', title: 'Other', description: 'No clear signal' },
];
// On a tie the earlier intent wins.
const ORDER = INTENTS.map((i) => i.key);

// Words in a title, prompt or commit message. English, plus a few Dutch.
const KEYWORDS = {
  bugfix:
    /\b(bugs?|bugfix|fix(es|ed|ing)?|hotfix|errors?|exceptions?|crash(es|ed|ing)?|broken|breaks|fails?|failing|failed|failure|not working|(does ?n[o']t|did ?n[o']t|is ?n[o']t|wo ?n[o']t) (work|show|load|run|start|give|return)|no output|wrong|incorrect|regression|stack ?trace|debug(ging)?|repro|fout(en|melding)?|werkt niet|kapot)\b/i,
  feature:
    /\b(add(s|ed|ing)?|implement(s|ed|ing)?|build|new (feature|page|app|application|endpoint|command|option|screen|tool|report)|(create|write|make) (a|an) (new )?(tool|app|application|script|page|site|website|service|api|cli|bot|dashboard|component|generator|plugin|extension)|i want (an?|to have)|support for|introduce|scaffold|make me|features?|improv(e|es|ed|ing|ements?)|enhanc(e|es|ed|ing|ements?)|poc|prototype|toevoegen|bouw)\b/i,
  refactor:
    /\b(refactor(s|ed|ing)?|renam(e|es|ed|ing)|clean(ing)? ?up|simplif(y|ies|ied|ication)|restructur(e|ing)|extract|reorgani[sz](e|ing)|migrat(e|es|ed|ing|ion)|upgrad(e|es|ed|ing)|moderni[sz]e|dedup(licate)?|split (up|into)|consolidat(e|ing)|opschonen|herschrijf)\b/i,
  tests: /\b(unit[- ]?tests?|tests?|testing|test (case|suite)s?|coverage|e2e|playwright|jest|vitest|xunit|nunit|pytest)\b/i,
  planning: /\b(plan(s|ning)?(?! mode)|specs?|specification|design( doc)?|architecture|proposal|roadmap|rfc|adr|requirements|feasibility|ideas)\b/i,
  docs: /\b(readme|docs|documentation|document(ed|ing)?|changelog|blog|article|course|module|slides?|presentation|tutorial|guide|write[- ]?up|explainer)\b/i,
  ops: /\b(deploy(s|ed|ing|ment)?|pipelines?|ci|cd|github actions|workflows?|docker(file)?|kubernetes|k8s|helm|terraform|bicep|infra(structure)?|config(ure|uration)?|settings|install(ation)?|dependenc(y|ies)|packages?|publish(ing)?|release|version bump|permissions?|hooks?)\b/i,
  review: /\b(review(ing)?|code review|pull request #?\d+|pr #?\d+|feedback on)\b/i,
  research:
    /\b(explain|what (is|are|does|do|could)|why|how (does|do|is|can|could|would)|analy[sz](e|is|ing)|investigat(e|ion)|research|compar(e|ing|ison)|evaluat(e|ion)|verif(y|ication)|validat(e|ion)|breakdown|overview|look (at|into)|find (out|anything)|understand|due diligence|options|pros and cons|which|is (it|there)|can you find|vs\.?)\b/i,
};

// Conventional commit types, and git branch prefixes.
const COMMIT_TYPES = { fix: 'bugfix', hotfix: 'bugfix', feat: 'feature', feature: 'feature', refactor: 'refactor', perf: 'refactor', style: 'refactor', test: 'tests', tests: 'tests', docs: 'docs', doc: 'docs', chore: 'ops', ci: 'ops', build: 'ops', deps: 'ops' };
const BRANCH_TYPES = { ...COMMIT_TYPES, bugfix: 'bugfix', bug: 'bugfix', features: 'feature', refactoring: 'refactor', infra: 'ops', ops: 'ops', release: 'ops' };
const REVIEW_COMMANDS = /^\/(code-review|review|security-review|pr-review|ultrareview)\b/;

/** The first line of the commit messages and PR titles in one shell command. */
export function workMessages(command) {
  const out = [];
  const text = String(command ?? '');
  const re = /\b(?:git\s+commit\b[^\n]*?\s(?:-m|--message)|gh\s+pr\s+create\b[^\n]*?\s(?:-t|--title))[\s=]*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|@['"]\r?\n([^\r\n]*))/g;
  for (const m of text.matchAll(re)) {
    const body = (m[1] ?? m[2] ?? m[3] ?? '').replace(/^\$\(cat\s*<<-?\s*'?\w+'?\s*/, '');
    const line = body.split(/\r?\n|\\n/).map((l) => l.trim()).find(Boolean);
    if (line) out.push(line.slice(0, 200));
  }
  return out;
}

/**
 * What a prompt says, without the tags Claude Code wraps around commands and
 * attachments. A bare slash command (/clear, /compact) says nothing: ''.
 */
export function promptText(text) {
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1];
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1];
  const plain = name ? `${name} ${args ?? ''}` : String(text ?? '').replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ');
  const clean = plain.replace(/\s+/g, ' ').trim();
  return /^\/\S+$/.test(clean) ? '' : clean.slice(0, 500);
}

/** A changed file's kind: plans (plan / spec documents), docs, tests, ops (CI, containers, settings, manifests) or code. */
export function fileKind(file) {
  const p = String(file).replace(/\\/g, '/').toLowerCase();
  const name = p.slice(p.lastIndexOf('/') + 1);
  if (/\.(md|mdx|markdown|rst|adoc|txt)$/.test(name)) {
    const plan = /(^|\/)(specs?|plans?|rfcs?|adrs?|designs?)\//.test(p) || /^(plan|spec|rfc|adr|design)[-_.]/.test(name);
    return plan ? 'plans' : 'docs';
  }
  if (/(^|\/)(tests?|__tests__|testing)\//.test(p) || /[._-](test|tests|spec)\.[a-z]+$/.test(name) || /^test_/.test(name)) return 'tests';
  if (
    /(^|\/)\.(github|gitlab|azure|circleci|devcontainer|claude|vscode)\//.test(p) ||
    /\.(ya?ml|tf|tfvars|bicep|toml|ini|env|config|props|targets)$/.test(name) ||
    /^(dockerfile|docker-compose.*|makefile|package(-lock)?\.json|pnpm-lock\.yaml|.*\.csproj|.*\.sln|nuget\.config|settings(\.local)?\.json|tsconfig.*\.json|\.gitignore|\.gitattributes|\.npmrc|requirements.*\.txt|pyproject\.toml|go\.mod|cargo\.toml)$/.test(name)
  ) {
    return 'ops';
  }
  return 'code';
}

const WEIGHTS = { commit: 4, command: 4, title: 3, branch: 2, prompt: 2, activity: 3 };

/**
 * Places one session in an intent. `s` holds: title, firstPrompt, branches[],
 * workMessages[] (commits / PR titles), commands[] (slash commands), files
 * { code, tests, docs, ops, plans } (changed files per kind), newFiles, edits.
 * Returns { intent, evidence } - evidence names the signals that decided it.
 */
export function classifyIntent(s) {
  const score = Object.fromEntries(ORDER.map((k) => [k, 0]));
  const why = Object.fromEntries(ORDER.map((k) => [k, new Set()]));
  const add = (key, weight, source) => {
    score[key] += weight;
    why[key].add(source);
  };
  const words = (text, weight, source) => {
    if (!text) return;
    for (const [key, re] of Object.entries(KEYWORDS)) if (re.test(text)) add(key, weight, source);
  };

  for (const msg of s.workMessages ?? []) {
    const type = /^(\w+)(\([^)]*\))?!?:/.exec(msg)?.[1]?.toLowerCase();
    if (COMMIT_TYPES[type]) add(COMMIT_TYPES[type], WEIGHTS.commit, 'commit');
    else words(msg, 1, 'commit');
  }
  if ((s.commands ?? []).some((c) => REVIEW_COMMANDS.test(c))) add('review', WEIGHTS.command, 'command');
  words(s.title, WEIGHTS.title, 'title');
  for (const branch of s.branches ?? []) {
    const prefix = /^([\w-]+)\//.exec(branch)?.[1]?.toLowerCase();
    if (BRANCH_TYPES[prefix]) add(BRANCH_TYPES[prefix], WEIGHTS.branch, 'branch');
  }
  words(s.firstPrompt, WEIGHTS.prompt, 'prompt');

  const f = { code: 0, tests: 0, docs: 0, ops: 0, plans: 0, ...s.files };
  const changed = f.code + f.tests + f.docs + f.ops + f.plans;
  if (!changed && !(s.edits > 0) && !(s.workMessages ?? []).length) {
    add('research', WEIGHTS.activity, 'activity'); // read and answered, changed nothing
  } else if (changed) {
    // Research that ends in code changes was work on that code.
    score.research /= 2;
    if (f.plans === changed) add('planning', WEIGHTS.activity, 'activity');
    else if (f.docs === changed) add('docs', WEIGHTS.activity, 'activity');
    else if (f.tests === changed) add('tests', WEIGHTS.activity, 'activity');
    else if (f.ops === changed) add('ops', WEIGHTS.activity, 'activity');
    else if (s.newFiles >= 2 && s.newFiles >= changed / 2) add('feature', 1, 'activity');
  }

  const best = ORDER.reduce((a, k) => (score[k] > score[a] ? k : a), ORDER[0]);
  if (score[best] <= 0) return { intent: 'other', evidence: [] };
  return { intent: best, evidence: [...why[best]] };
}
