// Usage limits: the times a session was stopped because the plan's usage limit
// was reached (Claude Code's 5-hour or weekly limits, a spend limit; Copilot's
// premium request quota or its rate limit). Short capacity hiccups the client
// retries on its own are not usage limits and are left out.

import { recordFilter, dateFormatter } from './aggregate.mjs';

export const LIMIT_KINDS = {
  five_hour: '5-hour limit',
  seven_day: 'Weekly limit',
  seven_day_opus: 'Weekly Opus limit',
  seven_day_sonnet: 'Weekly Sonnet limit',
  seven_day_overage_included: 'Weekly limit (with extra usage)',
  overage: 'Extra usage limit',
  spend: 'Spend limit',
  quota: 'Premium request quota',
  rate_limit: 'Rate limit',
  unknown: 'Usage limit',
};

const USAGE_TEXT = /usage limit|limit reached|hit your [\w -]*limit|limit (will )?resets?|resets? (at|in) /i;
const LEGACY = /^Claude AI usage limit reached\|(\d{9,})/; // older Claude Code: "…|<reset epoch seconds>"

function kindFromText(text) {
  if (/opus/i.test(text) && /week|7-day/i.test(text)) return 'seven_day_opus';
  if (/sonnet/i.test(text) && /week|7-day/i.test(text)) return 'seven_day_sonnet';
  if (/week|7-day/i.test(text)) return 'seven_day';
  if (/5-hour|five-hour|session limit/i.test(text)) return 'five_hour';
  return 'unknown';
}

const isoFromEpoch = (seconds) => {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
};

/**
 * A Claude Code transcript line that reports a usage limit: { kind, resetsAt }
 * or null. `text` is the message's text.
 */
export function claudeLimit(d, text) {
  const legacy = LEGACY.exec(text);
  if (legacy) return { kind: 'five_hour', resetsAt: isoFromEpoch(legacy[1]) };
  if (!d?.isApiErrorMessage) return null;
  if (d.error === 'billing_error' && /spend limit|monthly (spend|usage) limit/i.test(text)) return { kind: 'spend', resetsAt: null };
  const info = d.apiErrorParams?.rate_limit_info;
  const usage = d.apiError === 'usage_limit_reached' || (d.error === 'rate_limit' && !d.apiErrorIsTransient && USAGE_TEXT.test(text));
  if (!usage) return null;
  const kind = info?.rateLimitType in LIMIT_KINDS ? info.rateLimitType : /spend limit/i.test(text) ? 'spend' : kindFromText(text);
  return { kind, resetsAt: isoFromEpoch(info?.resetsAt) };
}

/** A Copilot session.error event's data that reports a usage limit: { kind, resetsAt } or null. */
export function copilotLimit(data) {
  if (data?.errorType === 'quota' || data?.statusCode === 402) return { kind: 'quota', resetsAt: null };
  if (data?.errorType === 'rate_limit') return { kind: 'rate_limit', resetsAt: null };
  return null;
}

const median = (values) => {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

/** Usage-limit hits in the selected range, per kind. */
export function limitStats(data, { since, until, project, timeZone } = {}) {
  const inRange = recordFilter({ since, until, project, timeZone });
  const hits = (data.limits ?? []).filter((h) => inRange(h)).sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  const kinds = new Map();
  for (const h of hits) {
    const k = kinds.get(h.kind) ?? { kind: h.kind, title: LIMIT_KINDS[h.kind] ?? LIMIT_KINDS.unknown, hits: 0, sessions: new Set(), lastHit: null, waits: [] };
    k.hits += 1;
    k.sessions.add(h.sessionId);
    k.lastHit = h.timestamp;
    if (h.resetsAt && h.resetsAt > h.timestamp) k.waits.push(Date.parse(h.resetsAt) - Date.parse(h.timestamp));
    kinds.set(h.kind, k);
  }
  const byKind = [...kinds.values()]
    .sort((a, b) => b.hits - a.hits)
    .map(({ waits, sessions, ...k }) => ({ ...k, sessions: sessions.size, medianWaitMs: median(waits) }));
  return { hits, byKind, sessions: new Set(hits.map((h) => h.sessionId)).size };
}

/** "2h 15m", "3d 4h", "40m". */
export function duration(ms) {
  if (ms == null) return '';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const right = (title) => ({ title, align: 'right' });
const left = (title) => ({ title, align: 'left' });

/** Report sections and summary line; nothing when no limit was hit. */
export function limitParts(stats, { timeZone } = {}) {
  if (!stats.hits.length) return { summary: [], sections: [] };
  const day = dateFormatter(timeZone);
  const last = stats.hits.at(-1);
  const times = stats.hits.length === 1 ? 'once' : `${stats.hits.length} times`;
  return {
    summary: [
      `A usage limit stopped ${stats.sessions} session${stats.sessions === 1 ? '' : 's'} ${times}; the last was a ${LIMIT_KINDS[last.kind]?.toLowerCase() ?? 'usage limit'} on ${day(last.timestamp)}.`,
    ],
    sections: [
      {
        title: 'Usage limits',
        note: 'times a session was stopped until the limit reset',
        columns: [left('Limit'), right('Hits'), right('Sessions'), left('Last hit'), right('Median time to reset')],
        rows: stats.byKind.map((k) => ({ cells: [k.title, k.hits, k.sessions, day(k.lastHit), duration(k.medianWaitMs)] })),
      },
    ],
  };
}

/** For --json. */
export function limitsJSON(stats) {
  return {
    hits: stats.hits.length,
    sessions: stats.sessions,
    byKind: stats.byKind,
    events: stats.hits.map(({ timestamp, sessionId, project, agent, source, kind, resetsAt }) => ({ timestamp, sessionId, project, agent, source, kind, resetsAt })),
  };
}
