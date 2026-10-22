# ccreports

Reports Claude Code **tool calls, skills, slash commands, subagents, token usage and cost** from
the local session transcripts in `~/.claude/projects`. Inspired by
[ccusage](https://github.com/ccusage/ccusage), which covers tokens and cost;
ccreports adds what you actually *did* with those tokens.

Zero dependencies, Node.js 20+.

## Usage

```sh
node bin/ccreports.mjs                 # summary: totals + ranked tools, MCP servers, skills, commands, models
node bin/ccreports.mjs daily           # one row per day
node bin/ccreports.mjs weekly -b       # per week, with top tools/skills/commands as sub-rows
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

**Context size** is the full prompt of a request: input + cache write + cache
read tokens (output excluded). Only main-conversation requests count, since
subagents run in their own context window.

| Report | Max Context | Avg column |
|---|---|---|
| `session` | the session's peak | **Avg Context**: its average request |
| others + summary | the largest peak of any session | **Avg Max Context**: session peaks averaged |

### Output formats

| Format | Notes |
|---|---|
| `table` | Box-drawn terminal tables. Colors only on a TTY; cache columns hidden below 120 columns or with `--compact`. |
| `json` | Every bucket with all tools, MCP servers, skills, commands, models and subagent types (not limited by `--top`). |
| `markdown` | GitHub-flavored tables, one `##` heading per summary section; breakdown sub-rows included. |
| `csv` | Raw numbers (no separators, `$` or `%`; cost to 4 decimals). The summary is several tables separated by blank lines; breakdown sub-rows are left out. |
| `html` | Self-contained page (no external assets), light/dark aware, share columns drawn as bars, sortable columns. |

```sh
node bin/ccreports.mjs -s 20261001 -f html -o usage.html
node bin/ccreports.mjs monthly -f csv -o monthly.csv
node bin/ccreports.mjs weekly -b -f md >> REPORT.md
```

Warnings (unpriced models, built-in prices) go to stderr, so redirected output stays clean.

| Option | |
|---|---|
| `-s, --since` / `-u, --until` | Date range, `YYYYMMDD` or `YYYY-MM-DD` (inclusive) |
| `-p, --project <text>` | Filter on project path (case-insensitive substring) |
| `-b, --breakdown` | Per-row tool / skill / command sub-rows |
| `-n, --top <n>` | Rows per ranked list (`0` = all) |
| `-f, --format <fmt>` | `table` (default), `json`, `csv`, `markdown` / `md`, `html` |
| `-j, --json` | Same as `--format json` |
| `-o, --output <file>` | Write to a file instead of stdout |
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
- **Slash commands** – user messages containing `<command-name>`, including
  built-ins like `/clear` and `/model`. A user-typed skill counts both as a
  command and as a skill.
- **Subagents** – `<session>/subagents/*.jsonl` is included and attributed to
  the parent session. The summary's *Subagents* table splits requests, tool
  calls, tokens and cost by subagent type (from each transcript's
  `.meta.json`), next to a `(main session)` row; *Launches* counts `Agent`
  tool calls by requested `subagent_type`. The *Agents* column in period
  reports is the number of launches.
- **Cost** – estimated per request from [LiteLLM's price
  list](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)
  (the source ccusage uses), cached for 24h in `%LOCALAPPDATA%\ccreports` /
  `~/.cache/ccreports`; falls back to the cache, then a built-in snapshot.
  5-minute and 1-hour cache writes are priced separately, and a request whose
  full input exceeds a model's long-context threshold is billed at that tier.
  Fast-mode surcharges are not applied. Models without a price count as $0
  and are reported on stderr. Results match `ccusage`. These are API list
  prices, so on a subscription plan they show what the usage *would* cost,
  not what you pay.

The transcript format is undocumented and changes between Claude Code versions;
the parser ignores line types it doesn't know. Claude Code deletes transcripts
older than `cleanupPeriodDays` (default 30), so history is limited to that window.

## Tests

```sh
npm test
```
