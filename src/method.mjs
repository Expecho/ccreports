// "How it's measured": what a report is built from and how its figures are
// counted, limited to the sources and sections the report contains.

import { AUTONOMY_THRESHOLD } from './adoption.mjs';
import { dateFormatter } from './aggregate.mjs';

const DAY_MS = 86_400_000;

/**
 * The period a report's data covers: its first and last activity within the
 * filters, as "2026-06-12 → 2026-11-04 (146 days)". Null without activity.
 */
export function coverage(totals, { timeZone } = {}) {
  if (!totals.firstActivity || !totals.lastActivity) return null;
  const date = dateFormatter(timeZone);
  const from = date(totals.firstActivity);
  const to = date(totals.lastActivity);
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
  return { from, to, days, text: `${from} → ${to} (${days.toLocaleString('en-US')} ${days === 1 ? 'day' : 'days'})` };
}

/**
 * The section: { title, note, notes: [{ term, text }] }.
 * `has` says what the report includes: claude / copilot / cursor (sources with
 * sessions), cost, breakdown, shell, adoption, recommendations, intentsByClaude.
 */
export function methodSection(has, { since, until, project, timeZone, pricingSource, range } = {}) {
  const notes = [];
  const add = (term, text) => notes.push({ term, text });

  const sources = [
    has.claude && 'Claude Code transcripts in ~/.claude/projects, subagent transcripts included and counted in their parent session',
    has.copilot && 'GitHub Copilot CLI and VS Code agent sessions in ~/.copilot/session-state',
    has.cursor && "Cursor agent transcripts in ~/.cursor/projects, with chat metadata (model, mode) from the editor's database",
  ].filter(Boolean);
  add(
    'Data',
    `Read from your local logs only: ${listText(sources)}. Nothing is uploaded; the only network call fetches Anthropic's public pricing page.`,
  );

  const filters = [
    since && `from ${since}`,
    until && `until ${until}`,
    project && `projects matching "${project}"`,
  ].filter(Boolean);
  add(
    'Period',
    `${range ? `The data runs from the first to the last activity found: ${range.text}` : 'No activity was found'}${
      filters.length ? `, filtered to ${listText(filters)}` : ', all logs that are still on disk'
    }. Dates are in ${timeZone ?? 'your local time zone'}.`,
  );

  add(
    'Sessions and prompts',
    'A session is one conversation. Resumed sessions copy earlier history into a new log, so every message, tool call and response is counted once, by its id. Prompts are the messages you typed; tool results and messages the tool adds itself are not prompts.',
  );

  if (has.claude || has.copilot) {
    add(
      'Tokens',
      `Input, output, cache-write and cache-read tokens as each API response logged them, once per response.${
        has.copilot ? ' Older Copilot sessions only log totals per run at shutdown, and sessions that never shut down cleanly have none.' : ''
      }${has.cursor ? ' Cursor keeps token usage on its servers, so its sessions count in activity only (prompts, tools, skills).' : ''} Context size is the main conversation's, without subagents.`,
    );
  } else if (has.cursor) {
    add('Tokens', 'Cursor keeps token usage on its servers, so this report shows activity only: sessions, prompts, tools, skills and commands.');
  }

  if (has.cost) {
    add(
      'Cost',
      `Estimated per request at Claude API list prices (${
        pricingSource === 'builtin' ? "a built-in copy of Anthropic's pricing page; it was unreachable" : "Anthropic's pricing page"
      }), with each model's cache, long-context and fast-mode rates. On a subscription it shows what the usage would cost at API prices, not what you pay.${
        has.copilot ? ' For Copilot it is what Copilot billed in AI credits (1 AIU = $0.01); unbilled Claude models are priced at API rates.' : ''
      } Models without a price count as $0.`,
    );
  }

  add(
    'Tools, skills and commands',
    `Every tool call in the logs; MCP tools are also rolled up per server. Skills count when the model calls one and when you type it as a slash command${
      has.cursor ? " (in Cursor, when the agent reads a skill's SKILL.md)" : ''
    }. Slash commands include built-ins such as /clear and /model. Installed plugins come from the plugin settings on disk, with the use of their skills, commands, subagents, MCP servers and hooks.`,
  );

  if (has.breakdown || has.shell) {
    add(
      'Tokens per tool, skill and subagent',
      `Marked ~: reconstructed from how much each result grew the context, so they include re-reads of the result in later requests.${
        has.copilot ? " Copilot's are rougher: they are scaled down to at most what the session sent." : ''
      } Subagent tokens are exact.${
        has.shell ? ' Shell commands are the programs each Bash or PowerShell call ran; a call running several counts for each.' : ''
      }`,
    );
  }

  add(
    'Usage limits',
    `Counted when a plan's 5-hour, weekly or spend limit${has.copilot ? ", or Copilot's premium request quota or rate limit," : ''} stopped a request. Short capacity errors that are retried automatically do not count. The table only appears when a limit was hit.${
      has.cursor ? ' Cursor logs no errors.' : ''
    }`,
  );

  if (has.adoption) {
    add(
      'Adoption phases',
      `Each session gets one phase. Chat: no code edits and no pull requests. Multi-agent: two or more subagent launches, background agents, worktrees or messages between agents. Agent-first: ${AUTONOMY_THRESHOLD} or more tool calls per prompt you typed. Assisted: the rest. Pull requests are those the agent created.`,
    );
    add(
      'Session intent',
      has.intentsByClaude
        ? 'Classified by Claude from all prompts of each session; sessions it did not classify use the rules: weighted signals from commit and PR titles, the session title, branch names, prompts and the kinds of files changed. A best guess per session.'
        : 'A best guess per session from weighted rules over commit and PR titles, the session title, branch names, prompts and the kinds of files changed (code, tests, docs, config, plans).',
    );
  }

  if (has.recommendations) {
    add(
      'Recommendations',
      'Checks against your own logs, most impact first, each with the evidence it is based on. The amounts at stake are estimates that overlap, so they do not add up.',
    );
  }

  return { title: "How it's measured", notes };
}

/** "a, b and c"; items that contain commas are separated by semicolons. */
function listText(items) {
  if (items.length <= 1) return items.join('');
  const sep = items.some((i) => i.includes(',')) ? '; ' : ', ';
  return `${items.slice(0, -1).join(sep)}${sep.trim()} and ${items.at(-1)}`;
}
