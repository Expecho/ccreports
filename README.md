# ccreports

Reports Claude Code **tool calls, skills, slash commands, subagents, token usage and cost** from
the local session transcripts in `~/.claude/projects`. Inspired by
[ccusage](https://github.com/ccusage/ccusage), which covers tokens and cost;
ccreports adds what you actually *did* with those tokens.

Zero dependencies, Node.js 20+.

## Quick start

No install needed:

```sh
npx ccreports@latest                                  # summary
npx ccreports@latest daily -b                         # per day, with tool / skill / agent breakdown
npx ccreports@latest -a -r -f html -o report.html     # summary + adoption + recommendations as a page
```

Or install it globally: `npm install -g ccreports`, then run `ccreports`.

## Install as a Claude Code plugin

At the prompt of a Claude Code terminal session:

```
/plugin install ccreports --marketplace Expecho/ccreports
```

Answer `y` to add the marketplace, then pick a scope. From a shell:
`claude plugin install ccreports --marketplace Expecho/ccreports`. In the
desktop app: click + next to the prompt box, then Plugins, Add marketplace with
`Expecho/ccreports`, then Add plugin.

The plugin adds a `report` skill: ask Claude things like *"what did I spend on
Claude Code this week?"* or *"which tools use most of my tokens?"*, or run it
directly:

```
/ccreports:report adoption as html
/ccreports:report weekly -b --since 20261001
```

Claude runs the bundled CLI (Node.js 20+ required) and explains the results.

## Usage

```sh
node bin/ccreports.mjs                 # summary: totals + ranked tools, MCP servers, skills, commands, hooks, models
node bin/ccreports.mjs daily           # one row per day
node bin/ccreports.mjs weekly -b       # per week, with top tools/skills/commands as sub-rows
node bin/ccreports.mjs -x              # summary plus the programs run by Bash / PowerShell calls
node bin/ccreports.mjs monthly --json
node bin/ccreports.mjs session -s 20261020
node bin/ccreports.mjs project -p agent42
```

Or install it globally with `npm link` and run `ccreports`.

Period reports (daily/weekly/monthly/project) include a **Sessions** column:
the sessions active in that period. A session that spans two days counts in
both, so rows can add up to more than the total. With `--breakdown`, a
**Per Session** column gives each tool / skill / command / agent count divided
by the row's sessions.

**Tokens per tool, skill and subagent.** Breakdown sub-rows fill the token
columns like their parent row: *Output* (the tool input the model wrote),
*Cache Create* (the result entering the context), *Cache Read* (re-reads),
*Total Tokens* and *Cost*; in `--compact` layout *Input* is all input-side
tokens. Tool and skill rows leave the uncached *Input* column empty: results
always arrive through the cache. The summary's Tools, MCP servers and Skills
tables add *Input (est.)*, *Output (est.)*, *Tokens (est.)* and *Cost
(est.)*; the Subagents table shows exact *Input* and *Output*. The logs record usage per request only, so
for tools and skills this is reconstructed (shown with `~`):

- the tool input the model wrote counts as output tokens;
- the result is what it adds to the context of the next request. In a tool
  loop that is measured: `context(next) − context(this) − output(this)`,
  split over parallel calls by result length. When a human message or
  compaction sits in between, or for a skill typed as a command, it is
  estimated from the text length at a characters-per-token ratio calibrated
  on the measured turns (about 2.2–2.4 in practice);
- input and result are then re-sent with every later request of that
  conversation until it ends or is compacted - these re-reads (cache reads)
  are usually most of it;
- cost prices the input as output tokens, the first inclusion as a cache
  write and the re-reads as cache reads, at the model of the request.

A model-invoked skill is its `Skill` call plus the skill content it loads.
Subagent rows are exact: all tokens of that type's own transcripts. Items are
counted in the period of the call, even when re-reads happen later.

**Context size** is the full prompt of a request: input + cache write + cache
read tokens (output excluded). Only main-conversation requests count, since
subagents run in their own context window.

| Report | Max Context | Avg column |
|---|---|---|
| `session` | the session's peak | **Avg Context**: its average request |
| others + summary | the largest peak of any session | **Avg Max Context**: session peaks averaged |

### Adoption assessment

`ccreports adoption` is modelled on GitHub Copilot's adoption cohorts, with
your sessions as the unit. Each session lands in the first phase that fits:

| Phase | Rule |
|---|---|
| Chat | no code edits and no PR |
| Phase 3 · Multi-agent | 2+ subagents, a background agent, a worktree, or agents messaging each other |
| Phase 2 · Agent-first | 10+ tool calls per prompt you typed |
| Phase 1 · Assisted | everything else that changed code |

The report opens with a short written assessment, then shows the cohorts (as
cards in HTML) with PRs, edits, tool calls per prompt, tokens and cost per
session; the phase mix per week; how many sessions use each capability
(skills, subagents, background agents, worktrees, MCP, web, PRs); and usage by
surface (CLI, desktop, IDE, SDK). PRs are the `pr-link` entries Claude Code
records when it creates a PR; prompts exclude agent-to-agent messages and
task notifications. `--json` returns the per-session stats and phase.

```sh
node bin/ccreports.mjs adoption -s 20261001 -f html -o adoption.html
node bin/ccreports.mjs -s 20261001 --adoption -f html -o report.html   # summary + adoption
```

`--adoption` (`-a`) appends the assessment to any report: the written
assessment goes on top, the adoption tables after the report's own. In JSON
it adds an `adoption` object.

### Recommendations

`ccreports recommendations` (or `-r` on any report) checks your usage for
patterns worth changing. A recommendation only appears when the data clearly
shows the pattern; each comes with its evidence, what to do, and, where it can
be priced, the cost at stake (amounts overlap). Impact is the share of cost at
stake: high from 15%, medium from 5%.

| Fires when | Recommends |
|---|---|
| ≥25% of cost comes from requests with >200k tokens of context | new session or `/clear` per task, `/compact` with a focus |
| a tool's results take ≥10% of all tokens, or ≥200k tokens per call | tool-specific trimming (Bash/PowerShell output, Read ranges, Edit over Write, lean skills, filters for MCP tools) |
| main-session Read/Grep/Glob take ≥12% of tokens while subagents do <25% | delegate exploration to an Explore subagent |
| subagents run on Opus/Fable and Sonnet 5.5 would save ≥$1 and ≥10% | `model: sonnet` / `haiku` for routine agents (repriced savings shown) |
| ≥3 sessions (or ≥10%) hit compaction | split tasks, compact yourself at natural breaks |
| ≥3 cache misses in main conversations, costing ≥3% more than cache reads would | per cause: *expired* (pause longer than the 5-minute / 1-hour cache) → `/compact` or `/clear` before continuing after a break; *invalidated* (no pause, the start of the prompt changed) → keep the tool set stable; *model switch* → stay on one model. Misses right after a compaction are left out |
| ≥30% of coding sessions are Assisted | hand over whole tasks, plan mode, skills |
| background agents and worktrees in <10% of sessions; skills in <10% | parallel work; recurring workflows as skills |
| a hook failed ≥10 times and in ≥50% of its runs | fix paths / interpreters or remove the hook (with a sample error) |

```sh
node bin/ccreports.mjs recommendations -s 20261001
node bin/ccreports.mjs -s 20261001 -a -r -f html -o report.html   # summary + adoption + recommendations
```

### Output formats

| Format | Notes |
|---|---|
| `table` | Box-drawn terminal tables. Colors only on a TTY; cache columns hidden below 120 columns or with `--compact`. |
| `json` | Every bucket with all tools, MCP servers, skills, commands, hooks, models and subagent types (not limited by `--top`). |
| `markdown` | GitHub-flavored tables, one `##` heading per summary section; breakdown sub-rows included. |
| `csv` | Raw numbers (no separators, `$` or `%`; cost to 4 decimals). The summary is several tables separated by blank lines; breakdown sub-rows are left out. |
| `html` | Self-contained page (no external assets), light/dark aware, share columns drawn as bars, sortable columns. |

```sh
node bin/ccreports.mjs -s 20261001 -f html -o usage.html
node bin/ccreports.mjs monthly -f csv -o monthly.csv
node bin/ccreports.mjs weekly -b -f md >> REPORT.md
```

Warnings (unpriced models, built-in prices) go to stderr, so redirected output stays clean.

A report written with `-o` opens in the app your system associates with the
file - the browser for HTML, Excel for CSV, your editor for Markdown or JSON -
when you run ccreports from a terminal; scripts, CI (`CI` set) and agents
don't open anything unless they pass `--open`. `ccreports -f html --open`
writes to a temp file and opens it in one step. CSV files start with a UTF-8
byte order mark so Excel shows non-ASCII characters correctly.

| Option | |
|---|---|
| `-s, --since` / `-u, --until` | Date range, `YYYYMMDD` or `YYYY-MM-DD` (inclusive) |
| `-p, --project <text>` | Filter on project path (case-insensitive substring) |
| `-b, --breakdown` | Per-row tool / skill / command sub-rows |
| `-x, --shell` | Programs run by Bash / PowerShell calls, grouped by purpose: a table per shell in the summary, `[bash]` / `[powershell]` sub-rows in period reports |
| `-a, --adoption` | Append the adoption assessment to the report |
| `-r, --recommendations` | Append best-practice recommendations to the report |
| `-n, --top <n>` | Rows per ranked list (`0` = all) |
| `-f, --format <fmt>` | `table` (default), `json`, `csv`, `markdown` / `md`, `html` |
| `-j, --json` | Same as `--format json` |
| `-o, --output <file>` | Write to a file instead of stdout; run from a terminal, the file then opens in its associated app |
| `--open` | Open the report in its associated app (browser, Excel, editor); without `-o` it goes to a temp file |
| `--no-open` | Don't open the file written with `-o` |
| `--order asc\|desc` | Row order |
| `--timezone <tz>` | Timezone for date grouping |
| `--no-cost` | Skip cost estimates |
| `--offline` | Use cached (or built-in) pricing; never fetch |
| `--no-subagents` | Exclude subagent transcripts |
| `--compact` | Hide cache token columns (automatic below 120 columns) |
| `--dir <path>` | Projects directory (repeatable). Default: `CLAUDE_CONFIG_DIR` (comma-separated) or `~/.claude` / `~/.config/claude` |

## What is counted

- **Tokens** – `usage` from each assistant message, deduplicated per
  `message.id + requestId`. One API response is written as several lines, and
  resumed sessions copy earlier history, so naive summing overcounts. Totals
  match `ccusage`.
- **Tools** – every `tool_use` block, deduplicated by tool-use id. MCP tools
  (`mcp__<server>__<tool>`) are also rolled up per server.
- **Skills** – two sources, reported separately:
  - *by model*: `Skill` tool calls;
  - *by user*: a slash command followed by the skill's content
    (`Base directory for this skill: …`).

  Directory scopes like `.claude/worktrees/x:plan` are normalized to `plan`.
- **Shell commands** (`--shell`) – the programs a `Bash` or `PowerShell`
  call ran: the first word of every pipeline stage, `&&` / `;` list element,
  `$( … )` subshell and PowerShell script block. Quoted text, heredocs,
  here-strings and comments are not split, so inline code (`python -c "…"`,
  `cat <<EOF`) is not counted; nor are variables, keywords, PowerShell values
  and members (`$x = …`, `.Count`, `[IO.File]::…`) or functions the command
  defines itself. Paths are reduced to the program (`C:\…\git.exe` → `git`)
  and PowerShell names are case-insensitive. A call running several programs
  counts once for each. Reports group them by purpose (search & read files,
  change directory, text & data processing, print output, files, Git &
  GitHub, build / run / test, cloud & network, processes & system, other):
  *Calls* counts a call once per purpose, so *Share* (of that tool's calls)
  adds up to more than 100%. *Tokens (est.)* and *Cost (est.)* are the
  call's estimate (see *Tokens per tool* above) split evenly over its
  programs and over its purposes, so they add up to the tool's total instead
  of double counting; a `cd` / `Set-Location` prints nothing and only gets
  tokens when the call ran nothing else. The *Commands* column shows each
  program's calls and `~tokens`. JSON output always includes `shellCommands`
  (per program, with its category) and `shellCategories`, both with tokens
  and cost.
- **Slash commands** – user messages containing `<command-name>`, including
  built-ins like `/clear` and `/model`. A user-typed skill counts both as a
  command and as a skill.
- **Hooks** – the `hook_*` attachments Claude Code writes per hook run,
  deduplicated by uuid and grouped by command. The summary's *Hooks* table
  shows the events each hook ran on, runs, *Failed* (non-blocking errors:
  the hook crashed or exited non-zero), *Blocked* (exit code 2, the hook
  stopped the action on purpose), average and total duration, and *Context
  (est.)*: tokens the hook added to the conversation (`additionalContext`,
  and a blocking hook's stderr), estimated from the text length and counted
  once, without re-reads. Successful runs are only logged by some Claude Code
  versions and hook types, so *Runs* can undercount hooks that succeed.
- **Subagents** – `<session>/subagents/*.jsonl` is included and attributed to
  the parent session. The summary's *Subagents* table splits requests, tool
  calls, tokens and cost by subagent type (from each transcript's
  `.meta.json`), next to a `(main session)` row; *Launches* counts `Agent`
  tool calls by requested `subagent_type`. The *Agents* column in period
  reports is the number of launches.
- **Cost** – estimated per request at Claude API list prices, parsed from
  Anthropic's [pricing page](https://platform.claude.com/docs/en/about-claude/pricing)
  and cached for 24h in `%LOCALAPPDATA%\ccreports` / `~/.cache/ccreports`;
  falls back to the cache, then a built-in snapshot of the page. Applied as
  the page describes:
  - 5-minute and 1-hour cache writes and cache reads at each model's own rate;
  - Haiku 5.5's higher prices when a request's prompt (input + cache reads and
    writes) is over 100k tokens;
  - fast-mode prices when `usage.speed` is `fast` (cache multipliers on top);
  - 1.1× for US-only inference (`usage.inference_geo` = `us`);
  - web searches at $10 per 1,000.

  Models without a price count as $0 and are reported on stderr. These are
  API list prices, so on a subscription plan they show what the usage *would*
  cost, not what you pay; Batch discounts and Bedrock / Vertex pricing don't
  apply to Claude Code sessions and aren't modeled.

The transcript format is undocumented and changes between Claude Code versions;
the parser ignores line types it doesn't know. Claude Code deletes transcripts
older than `cleanupPeriodDays` (default 30), so history is limited to that window.

## Tests

```sh
npm test
```

## Releasing

```sh
npm version patch          # or minor / major: bumps package.json and .claude-plugin/plugin.json, commits, tags
git push --follow-tags
```

Pushing the `v*` tag runs the Publish workflow, which checks the versions
match, runs the tests and publishes to npm with provenance via trusted
publishing (no token involved), then creates the GitHub release with
generated notes (edit them on GitHub to describe the release). Plugin users
get the new version from the marketplace on update.
