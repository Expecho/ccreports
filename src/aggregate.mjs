// Groups loaded records into report buckets (daily, weekly, monthly, session,
// project or a single summary bucket).

export const REPORTS = ['summary', 'daily', 'weekly', 'monthly', 'session', 'project'];

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
    commands: new Map(), // name -> count
  };
}

export const MAIN_AGENT = '(main session)';

function agentEntry(bucket, type) {
  const key = type ?? MAIN_AGENT;
  if (!bucket.agents.has(key)) {
    bucket.agents.set(key, { launches: 0, requests: 0, toolCalls: 0, totalTokens: 0, costUSD: 0 });
  }
  return bucket.agents.get(key);
}

function inc(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

function touch(bucket, rec) {
  if (!bucket.firstActivity || rec.timestamp < bucket.firstActivity) bucket.firstActivity = rec.timestamp;
  if (!bucket.lastActivity || rec.timestamp > bucket.lastActivity) bucket.lastActivity = rec.timestamp;
  bucket.sessions.add(rec.sessionId);
  bucket.projects.add(rec.project);
}

/**
 * @param data   result of loadRecords()
 * @param opts   { report, since, until, project, timeZone, pricer } - pricer from
 *               createPricer(); omit it to skip cost calculation
 * @returns      { buckets: Bucket[], totals: Bucket }
 */
export function aggregate(data, { report = 'summary', since, until, project, timeZone, pricer } = {}) {
  const toDate = dateFormatter(timeZone);
  const projectFilter = project?.toLowerCase();
  const buckets = new Map();
  const totals = newBucket('total');

  const accept = (rec) => {
    rec.date = toDate(rec.timestamp);
    if (since && rec.date < since) return null;
    if (until && rec.date > until) return null;
    if (projectFilter && !String(rec.project).toLowerCase().includes(projectFilter)) return null;
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
    const cost = pricer?.(rec) ?? 0;
    for (const b of buckets) {
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
      a.totalTokens += total;
      a.costUSD += cost;
    }
  }

  for (const rec of data.tools) {
    for (const b of accept(rec) ?? []) {
      b.toolCalls += 1;
      inc(b.tools, rec.name);
      if (rec.name.startsWith('mcp__')) inc(b.mcpServers, rec.name.split('__')[1] || 'unknown');
      agentEntry(b, rec.agent).toolCalls += 1;
      if (rec.subagentType) {
        b.subagentLaunches += 1;
        agentEntry(b, rec.subagentType).launches += 1;
      }
    }
  }

  for (const rec of data.skills) {
    for (const b of accept(rec) ?? []) {
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

  const list = [...buckets.values()];
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

/** Plain-JSON form of a bucket. */
export function toJSON(bucket) {
  const { sessions, projects, unpricedModels, models, agents, tools, mcpServers, skills, commands, ...rest } = bucket;
  return {
    ...rest,
    sessionCount: sessions.size,
    projects: [...projects].sort(),
    unpricedModels: [...unpricedModels].sort(),
    models: Object.fromEntries(ranked(models, (m) => m.totalTokens)),
    agents: Object.fromEntries(ranked(agents, (a) => a.totalTokens)),
    tools: Object.fromEntries(ranked(tools)),
    mcpServers: Object.fromEntries(ranked(mcpServers)),
    skills: Object.fromEntries(
      ranked(skills, (s) => s.model + s.user).map(([k, s]) => [k, { ...s, total: s.model + s.user }]),
    ),
    commands: Object.fromEntries(ranked(commands)),
  };
}
