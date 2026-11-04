---
name: report
description: Report the user's own Claude Code usage from their local session logs (~/.claude/projects), their GitHub Copilot CLI / VS Code agent usage (~/.copilot/session-state), and their Cursor CLI / editor agent activity (~/.cursor/projects) - tokens and estimated API cost, tool / skill / slash-command / hook / subagent counts and the tokens each consumed, context size, sessions, an adoption assessment (chat, assisted, agent-first, multi-agent), what each session was for (bug fix, new development, refactoring, research, ...) and best-practice recommendations backed by their data. Use when the user asks how much they used or spent, which tools or skills they use most, what consumes their tokens, how their usage trends per day/week/month/project/session, how far they have adopted agentic workflows, what they spend their sessions on, how to use Claude Code, Copilot or Cursor more effectively or cheaply, how their usage of these tools compares, or wants such a report as a table, Markdown, CSV, JSON or HTML page.
argument-hint: "[summary|daily|weekly|monthly|session|project|adoption|intents|recommendations] [options]"
---

# ccreports

Run the bundled CLI with Node.js (20 or later). It lives two folders above this
skill's base directory: `<base directory>/../../bin/ccreports.mjs`. Use the
absolute path from the "Base directory for this skill" line, quoted:

```sh
node "<base directory>/../../bin/ccreports.mjs" [report] [options]
```

It only reads local session logs; the one network call fetches Anthropic's public
pricing page for cost estimates (cached for a day; `--offline` skips it).

## Choosing the command

If the user passed arguments, use them as the report and options. Otherwise map
the request:

| The user wants | Command |
|---|---|
| an overview, totals, top tools / skills / commands / hooks / models | `summary` (default) |
| which plugins are installed (version, enabled) and whether they're used | any report (its *Installed plugins* table), e.g. `summary` |
| a trend over time | `daily`, `weekly` or `monthly` |
| per conversation or per repository | `session` or `project` |
| what each tool, skill or subagent consumed | add `-b` (breakdown) to a period report |
| which programs / CLI commands Bash and PowerShell calls ran | add `-x` (`--shell`) to `summary` or a period report |
| an adoption / maturity assessment | `adoption`, or `-a` to add it to another report |
| what sessions were for (bug fixes, features, refactoring, research, ...) | `adoption` (its Session intent section), or `intents` per session; classify them yourself, see [Classifying session intent](#classifying-session-intent) |
| advice: how to use Claude Code better or cheaper | `recommendations`, or `-r` to add it to another report |
| the same for GitHub Copilot (CLI or VS Code agent) | any of the above with `--source copilot` |
| the same for Cursor (CLI or editor agent; activity only, no tokens or cost) | any of the above with `--source cursor` |
| Claude Code, Copilot and Cursor together, or compared | any of the above with `--source all` (recommendations get a section per product) |

Useful options: `-s/--since` and `-u/--until` (`YYYYMMDD`), `-p/--project <text>`,
`-n/--top <n>`, `--compact`, `--no-cost`, `-f/--format table|json|csv|markdown|html`,
`-o/--output <file>`. Run with `--help` for the full list.

## Running it

- For an answer in the conversation, prefer `-f markdown` (or `-j` when you need
  to compute something) over the box-drawn table, and keep the range tight with
  `--since` so the output stays readable. Pass `--no-color`.
- For a page to view or share, write HTML to a file in the current working
  directory unless the user names another place, e.g.
  `-f html -o ccreports-adoption.html`, then give the user the full path.
  When they ask to see or open it, add `--open`: the CLI launches the file in
  its associated app (browser for HTML, Excel for CSV). From your shell it does
  not open files unless `--open` is passed.
- If Node.js is missing or older than 20, say so; don't install it for them.

## Classifying session intent

ccreports guesses each session's intent with rules. When the user asks what
their sessions were for, or asks for intent to be classified by Claude, classify
the sessions yourself instead; it is more accurate than the rules. For an
adoption report where intent is not the question, the rules are enough.

1. Export the signals, with the same `--source`, `-s`, `-u` and `-p` options as
   the report, to a temporary file (your scratchpad directory if you have one):

   ```sh
   node "<base directory>/../../bin/ccreports.mjs" intents -j --no-open -o "<tmp>/ccreports-intent-signals.json" [options]
   ```

   With more than about 200 sessions, narrow the range with `--since` or ask
   the user which period to classify.
2. Read the file. `intents` lists the keys to choose from. Each session has a
   `title` and `signals`: `firstPrompt`, `branches`, `workMessages` (commit
   messages and PR titles it wrote), `commands`, `files` (changed files per
   kind: code, tests, docs, ops, plans), `newFiles`, `edits`, and the rules'
   guess (`ruleIntent`, `ruleEvidence`). Pick one key per session for its main
   purpose:
   - Commits and PR titles are the strongest evidence, then the title and the
     first prompt, then the branch (a long-lived `feature/` branch also hosts
     fixes).
   - A session that changed nothing is research, even if it talks about a bug.
   - Keep `ruleIntent` when the signals don't point elsewhere; use `other` only
     when nothing hints at a purpose.
3. Write `{ "<session id>": "<key>", ... }` to `<tmp>/ccreports-intents.json`.
4. Run the report the user asked for with `--intents "<tmp>/ccreports-intents.json"`,
   e.g. `adoption --intents …` or `intents --intents …` (not `-j`, which would
   print the prompts again). The section notes how many sessions you classified;
   their evidence reads `claude`.

The signals hold the user's own prompts from their local logs. Use them only to
classify; don't quote them in the report or the answer unless asked.

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
- Session intent (bug fix, new development, refactoring, ...) comes from rules
  over commit messages, titles, branch names, the first prompt and the files
  changed, unless you classified it. Either way it is a best guess per session;
  `intents` shows the evidence.

With `--source copilot`, `cursor` or `all`, also keep in mind:

- Copilot cost is what it billed in AI credits (1 AIU = $0.01); where nothing
  was billed, Claude models are priced at API rates and other models (GPT,
  local) show as unpriced. The summary also lists premium requests.
- Older Copilot sessions only log totals per run at shutdown: no context size,
  and subagent tokens are folded into the main session. Sessions that never
  shut down cleanly have no token counts.
- Copilot's tokens per tool are rougher than Claude Code's: they are scaled
  down to at most what each session sent.
- Cursor keeps token usage on its servers: Cursor reports show activity only
  (sessions, prompts, tools, skills, commands, adoption), and add nothing to
  tokens or cost in combined reports. Skills the agent picks itself are
  inferred from it reading a SKILL.md.
