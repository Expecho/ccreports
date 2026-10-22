---
name: report
description: Report the user's own Claude Code usage from their local session logs (~/.claude/projects) - tokens and estimated API cost, tool / skill / slash-command / subagent counts and the tokens each consumed, context size, sessions, an adoption assessment (chat, assisted, agent-first, multi-agent) and best-practice recommendations backed by their data. Use when the user asks how much they used or spent, which tools or skills they use most, what consumes their tokens, how their usage trends per day/week/month/project/session, how far they have adopted agentic workflows, how to use Claude Code more effectively or cheaply, or wants such a report as a table, Markdown, CSV, JSON or HTML page.
argument-hint: "[summary|daily|weekly|monthly|session|project|adoption|recommendations] [options]"
---

# ccreports

Run the bundled CLI with Node.js (20 or later). It lives two folders above this
skill's base directory: `<base directory>/../../bin/ccreports.mjs`. Use the
absolute path from the "Base directory for this skill" line, quoted:

```sh
node "<base directory>/../../bin/ccreports.mjs" [report] [options]
```

It only reads local transcripts; the one network call fetches Anthropic's public
pricing page for cost estimates (cached for a day; `--offline` skips it).

## Choosing the command

If the user passed arguments, use them as the report and options. Otherwise map
the request:

| The user wants | Command |
|---|---|
| an overview, totals, top tools / skills / commands / models | `summary` (default) |
| a trend over time | `daily`, `weekly` or `monthly` |
| per conversation or per repository | `session` or `project` |
| what each tool, skill or subagent consumed | add `-b` (breakdown) to a period report |
| an adoption / maturity assessment | `adoption`, or `-a` to add it to another report |
| advice: how to use Claude Code better or cheaper | `recommendations`, or `-r` to add it to another report |

Useful options: `-s/--since` and `-u/--until` (`YYYYMMDD`), `-p/--project <text>`,
`-n/--top <n>`, `--compact`, `--no-cost`, `-f/--format table|json|csv|markdown|html`,
`-o/--output <file>`. Run with `--help` for the full list.

## Running it

- For an answer in the conversation, prefer `-f markdown` (or `-j` when you need
  to compute something) over the box-drawn table, and keep the range tight with
  `--since` so the output stays readable. Pass `--no-color`.
- For a page to view or share, write HTML to a file in the current working
  directory unless the user names another place, e.g.
  `-f html -o ccreports-adoption.html`, then give the user the full path. On
  Windows `start "" "<file>"`, on macOS `open "<file>"`, on Linux `xdg-open "<file>"`
  opens it in their browser - do that only when they ask to see it.
- If Node.js is missing or older than 20, say so; don't install it for them.

## Explaining the results

Lead with what stands out (biggest cost driver, trend, phase), not a restatement
of every table. Keep these caveats in mind and mention them when relevant:

- Costs are Claude API list prices; on a subscription plan they show what the
  usage would cost, not what the user pays.
- Tokens per tool / skill (shown with `~`) are reconstructed from context growth
  and include re-reads of the result in later requests; subagent tokens are exact.
- Context size counts the main conversation only.
- The adoption phases are per session, from the user's own logs; PRs are those
  Claude Code created.
