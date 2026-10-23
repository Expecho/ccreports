// Groups loaded records into report buckets (daily, weekly, monthly, session,
// project or a single summary bucket).

import { commandCategory } from './shell.mjs';

const QUIET_CATEGORY = 'Change directory';

export const REPORTS = ['summary', 'daily', 'weekly', 'monthly', 'session', 'project', 'adoption', 'recommendations'];

export function dateFormatter(timeZone) {
  // en-CA formats as YYYY-MM-DD.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return (timestamp) => fmt.format(new Date(timestamp));
}

/** Accepts YYYYMMDD or YYYY-MM-DD, returns YYYY-MM-DD. */
export function parseDateArg(value, flag) {
  if (value == null) return undefined;
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(String(value).trim());
  if (!m) throw new Error(`${flag} must be YYYYMMDD or YYYY-MM-DD, got "${value}"`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function weekStart(date) {
  // ISO weeks: Monday is the first day.
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function groupKey(report, rec) {
  switch (report) {
    case 'daily':
      return rec.date;
    case 'weekly':
      return weekStart(rec.date);
    case 'monthly':
      return rec.date.slice(0, 7);
    case 'session':
      return rec.sessionId;
    case 'project':
      return rec.project;
    default:
      return 'total';
  }
}

function newBucket(key) {
  return {
    key,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUSD: 0,
    requests: 0,
    toolCalls: 0,
    skillCalls: 0,
    commandCount: 0,
    subagentLaunches: 0,
    // Context = full prompt of a main-conversation request (input + cache write
    // + cache read). Subagents have their own context window and are excluded.
    contextTokensSum: 0,
    contextRequests: 0,
    sessionPeaks: new Map(), // sessionId -> largest context
    maxContextTokens: 0,
    avgContextTokens: 0,
    avgSessionMaxContextTokens: 0,
    firstActivity: null,
    lastActivity: null,
    sessions: new Set(),
    projects: new Set(),
    unpricedModels: new Set(),
    models: new Map(), // model -> { requests, totalTokens, costUSD }
    agents: new Map(), // MAIN_AGENT | subagent type -> { launches, requests, toolCalls, totalTokens, costUSD }
    tools: new Map(), // name -> count
    mcpServers: new Map(), // server -> count
    skills: new Map(), // name -> { model, user }
    // Estimated tokens / cost attributed to each item (see src/attribution.mjs).
    toolTokens: new Map(), // name -> { tokens, costUSD }
    mcpServerTokens: new Map(), // server -> { tokens, costUSD }
    skillTokens: new Map(), // name -> { tokens, costUSD }
    commands: new Map(), // name -> count
    shellCommands: new Map(), // 'Bash' | 'PowerShell' -> Map(program -> { calls, sessions: Set })
    shellCategories: new Map(), // 'Bash' | 'PowerShell' -> Map(category -> { calls, sessions: Set })
    hookRuns: 0,
    hooks: new Map(), // command -> { events, runs, errors, blocked, durationMs, contextTokens }
  };
}

export const MAIN_AGENT = '(main session)';

function agentEntry(bucket, type) {
  const key = type ?? MAIN_AGENT;
  if (!bucket.agents.has(key)) {
    bucket.agents.set(key, {
      launches: 0,
      requests: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      costUSD: 0,
    });
  }
  return bucket.agents.get(key);
}

function inc(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

/** Adds an attributed item's tokens (src/attribution.mjs) to a per-name entry. */
function addTokens(map, key, t, costUSD) {
  map.set(key, addUsage(map.get(key) ?? {}, t, costUSD));
}

/** Adds a share `f` of an attributed item's tokens and cost to `entry`. */
function addUsage(entry, t, costUSD, f = 1) {
  for (const k of ['tokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens', 'costUSD']) entry[k] ??= 0;
  if (t) {
    entry.tokens += t.total * f;
    entry.outputTokens += t.outputTokens * f;
    entry.cacheWriteTokens += t.cacheWriteTokens * f;
    entry.cacheReadTokens += t.cacheReadTokens * f;
  }
  entry.costUSD += costUSD * f;
  return entry;
}

/** Prices an attributed item: tool input as output, then cache writes and re-reads. */
function attributedCost(t, pricer) {
  if (!pricer || !t.model) return 0;
  return (
    pricer({
      model: t.model,
      inputTokens: 0,
      outputTokens: t.outputTokens,
      cacheCreationTokens: t.cacheWriteTokens,
      cacheCreation1hTokens: Math.round(t.cacheWriteTokens * t.cache1hShare),
      cacheReadTokens: t.cacheReadTokens,
      promptTokens: t.promptTokens,
    }) ?? 0
  );
}

function touch(bucket, rec) {
  if (!bucket.firstActivity || rec.timestamp < bucket.firstActivity) bucket.firstActivity = rec.timestamp;
  if (!bucket.lastActivity || rec.timestamp > bucket.lastActivity) bucket.lastActivity = rec.timestamp;
  bucket.sessions.add(rec.sessionId);
  bucket.projects.add(rec.project);
}

/** Predicate for the --since / --until / --project filters; also sets `rec.date`. */
export function recordFilter({ since, until, project, timeZone } = {}) {
  const toDate = dateFormatter(timeZone);
  const projectFilter = project?.toLowerCase();
  return (rec) => {
    rec.date = toDate(rec.timestamp);
    if (since && rec.date < since) return false;
    if (until && rec.date > until) return false;
    if (projectFilter && !String(rec.project).toLowerCase().includes(projectFilter)) return false;
    return true;
  };
}

/**
 * @param data   result of loadRecords()
 * @param opts   { report, since, until, project, timeZone, pricer } - pricer from
 *               createPricer(); omit it to skip cost calculation
 * @returns      { buckets: Bucket[], totals: Bucket }
 */
export function aggregate(data, { report = 'summary', since, until, project, timeZone, pricer } = {}) {
  const inRange = recordFilter({ since, until, project, timeZone });
  const buckets = new Map();
  const totals = newBucket('total');

  const accept = (rec) => {
    if (!inRange(rec)) return null;
    const key = groupKey(report, rec);
    if (!buckets.has(key)) buckets.set(key, newBucket(key));
    touch(buckets.get(key), rec);
    touch(totals, rec);
    return [buckets.get(key), totals];
  };

  for (const rec of data.usage) {
    const buckets = accept(rec);
    if (!buckets) continue;
    const total = rec.inputTokens + rec.outputTokens + rec.cacheCreationTokens + rec.cacheReadTokens;
    const context = rec.inputTokens + rec.cacheCreationTokens + rec.cacheReadTokens;
    const cost = pricer?.(rec) ?? 0;
    for (const b of buckets) {
      if (rec.agent == null) {
        b.contextTokensSum += context;
        b.contextRequests += 1;
        if (context > (b.sessionPeaks.get(rec.sessionId) ?? 0)) b.sessionPeaks.set(rec.sessionId, context);
      }
      b.inputTokens += rec.inputTokens;
      b.outputTokens += rec.outputTokens;
      b.cacheCreationTokens += rec.cacheCreationTokens;
      b.cacheReadTokens += rec.cacheReadTokens;
      b.totalTokens += total;
      b.costUSD += cost;
      b.requests += 1;
      if (pricer && !pricer.isPriced(rec.model)) b.unpricedModels.add(rec.model);
      const m = b.models.get(rec.model) ?? { requests: 0, totalTokens: 0, costUSD: 0 };
      m.requests += 1;
      m.totalTokens += total;
      m.costUSD += cost;
      b.models.set(rec.model, m);
      const a = agentEntry(b, rec.agent);
      a.requests += 1;
      a.inputTokens += rec.inputTokens;
      a.outputTokens += rec.outputTokens;
      a.cacheCreationTokens += rec.cacheCreationTokens;
      a.cacheReadTokens += rec.cacheReadTokens;
      a.totalTokens += total;
      a.costUSD += cost;
    }
  }

  for (const rec of data.tools) {
    const buckets = accept(rec);
    if (!buckets) continue;
    const server = rec.name.startsWith('mcp__') ? rec.name.split('__')[1] || 'unknown' : null;
    const cost = rec.tokens ? attributedCost(rec.tokens, pricer) : 0;
    for (const b of buckets) {
      b.toolCalls += 1;
      inc(b.tools, rec.name);
      addTokens(b.toolTokens, rec.name, rec.tokens, cost);
      if (server) {
        inc(b.mcpServers, server);
        addTokens(b.mcpServerTokens, server, rec.tokens, cost);
      }
      agentEntry(b, rec.agent).toolCalls += 1;
      if (rec.shellCommands?.length) {
        // A call's tokens are split evenly over its programs, and over its
        // purposes, so neither double counts. A cd prints nothing: it only gets
        // tokens when the call ran nothing else. A call counts once per purpose.
        const programs = rec.shellCommands;
        const categories = [...new Set(programs.map(commandCategory))];
        const producing = programs.filter((p) => commandCategory(p) !== QUIET_CATEGORY);
        for (const [map, keys, category] of [
          [b.shellCommands, programs, commandCategory],
          [b.shellCategories, categories, (c) => c],
        ]) {
          if (!map.has(rec.name)) map.set(rec.name, new Map());
          const entries = map.get(rec.name);
          const paid = producing.length ? keys.filter((k) => category(k) !== QUIET_CATEGORY) : keys;
          for (const key of keys) {
            const e = entries.get(key) ?? { calls: 0, sessions: new Set() };
            e.calls += 1;
            e.sessions.add(rec.sessionId);
            addUsage(e, rec.tokens, cost, paid.includes(key) ? 1 / paid.length : 0);
            entries.set(key, e);
          }
        }
      }
      if (rec.subagentType) {
        b.subagentLaunches += 1;
        agentEntry(b, rec.subagentType).launches += 1;
      }
    }
  }

  for (const rec of data.skills) {
    const buckets = accept(rec);
    if (!buckets) continue;
    const cost = rec.tokens ? attributedCost(rec.tokens, pricer) : 0;
    for (const b of buckets) {
      addTokens(b.skillTokens, rec.name, rec.tokens, cost);
      b.skillCalls += 1;
      const s = b.skills.get(rec.name) ?? { model: 0, user: 0 };
      s[rec.source] += 1;
      b.skills.set(rec.name, s);
    }
  }

  for (const rec of data.commands) {
    for (const b of accept(rec) ?? []) {
      b.commandCount += 1;
      inc(b.commands, rec.name);
    }
  }

  for (const rec of data.hooks ?? []) {
    for (const b of accept(rec) ?? []) {
      const h = b.hooks.get(rec.command) ?? { events: new Set(), runs: 0, errors: 0, blocked: 0, durationMs: 0, contextTokens: 0 };
      h.events.add(rec.event);
      if (rec.run) {
        b.hookRuns += 1;
        h.runs += 1;
        if (rec.outcome === 'non_blocking_error') h.errors += 1;
        if (rec.outcome === 'blocking_error') h.blocked += 1;
      }
      if (rec.outcome === 'non_blocking_error' && rec.error) h.lastError = rec.error;
      h.durationMs += rec.durationMs;
      h.contextTokens += rec.contextTokens ?? 0;
      b.hooks.set(rec.command, h);
    }
  }

  const list = [...buckets.values()];
  for (const b of [...list, totals]) {
    const peaks = [...b.sessionPeaks.values()];
    b.maxContextTokens = peaks.length ? Math.max(...peaks) : 0;
    b.avgSessionMaxContextTokens = peaks.length ? Math.round(peaks.reduce((s, v) => s + v, 0) / peaks.length) : 0;
    b.avgContextTokens = b.contextRequests ? Math.round(b.contextTokensSum / b.contextRequests) : 0;
  }
  if (report === 'session') {
    for (const b of list) b.title = data.titles.get(b.key) ?? null;
    list.sort((a, b) => (a.lastActivity < b.lastActivity ? -1 : 1));
  } else if (report === 'project') {
    list.sort((a, b) => a.totalTokens - b.totalTokens);
  } else {
    list.sort((a, b) => (a.key < b.key ? -1 : 1));
  }
  return { buckets: list, totals };
}

/** Sorted [name, value] entries, highest first. */
export function ranked(map, valueOf = (v) => v) {
  return [...map.entries()].sort((a, b) => valueOf(b[1]) - valueOf(a[1]) || (a[0] < b[0] ? -1 : 1));
}

/** { Bash: { grep: { calls, sessions, tokens, ... } } } from shellCommands / shellCategories. */
function shellJSON(shells, extra = () => ({})) {
  return Object.fromEntries(
    [...shells].map(([shell, entries]) => [
      shell,
      Object.fromEntries(
        ranked(entries, (e) => e.calls).map(([k, { sessions, costUSD, ...e }]) => [
          k,
          {
            ...extra(k),
            ...Object.fromEntries(Object.entries(e).map(([f, v]) => [f, Math.round(v)])),
            sessions: sessions.size,
            costUSD,
          },
        ]),
      ),
    ]),
  );
}

/** Plain-JSON form of a bucket. */
export function toJSON(bucket) {
  const {
    sessions,
    projects,
    unpricedModels,
    models,
    agents,
    tools,
    mcpServers,
    skills,
    commands,
    shellCommands,
    shellCategories,
    sessionPeaks,
    contextTokensSum,
    toolTokens,
    mcpServerTokens,
    skillTokens,
    hooks,
    ...rest
  } = bucket;
  const withTokens = (counts, tokens, key) =>
    Object.fromEntries(ranked(counts).map(([k, v]) => [k, { [key]: v, ...tokens.get(k) }]));
  return {
    ...rest,
    sessionCount: sessions.size,
    projects: [...projects].sort(),
    unpricedModels: [...unpricedModels].sort(),
    models: Object.fromEntries(ranked(models, (m) => m.totalTokens)),
    agents: Object.fromEntries(ranked(agents, (a) => a.totalTokens)),
    // tokens / costUSD: estimated attribution (see src/attribution.mjs).
    tools: withTokens(tools, toolTokens, 'calls'),
    mcpServers: withTokens(mcpServers, mcpServerTokens, 'calls'),
    skills: Object.fromEntries(
      ranked(skills, (s) => s.model + s.user).map(([k, s]) => [
        k,
        { ...s, total: s.model + s.user, ...skillTokens.get(k) },
      ]),
    ),
    commands: Object.fromEntries(ranked(commands)),
    // Programs run by Bash / PowerShell calls; a call running several counts for
    // each. tokens / costUSD: the call's estimate, split evenly over its programs.
    shellCommands: shellJSON(shellCommands, (k) => ({ category: commandCategory(k) })),
    // The same calls grouped by purpose; a call counts once per category, its
    // tokens split evenly over its categories.
    shellCategories: shellJSON(shellCategories),
    // contextTokens: estimated, counted once as it enters the context.
    hooks: Object.fromEntries(ranked(hooks, (h) => h.runs).map(([k, h]) => [k, { ...h, events: [...h.events].sort() }])),
  };
}
