import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadRecords } from '../src/loader.mjs';
import { loadCopilotRecords } from '../src/copilot.mjs';
import { claudeLimit, copilotLimit, limitStats, limitParts, limitsJSON, duration } from '../src/limits.mjs';
import { toMarkdown } from '../src/formats.mjs';

// Claude Code's own error message for a request a usage limit stopped (as written by 2.1.x).
const limitMessage = (ts, uuid, extra = {}, text = "You've hit your limit · resets 3pm (Europe/Amsterdam)") => ({
  type: 'assistant',
  sessionId: 's1',
  cwd: '/work/app',
  timestamp: ts,
  uuid,
  isApiErrorMessage: true,
  error: 'rate_limit',
  message: { id: uuid, model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] },
  ...extra,
});

test('claudeLimit: usage limits, not other errors or transient 429s', () => {
  const text = (d) => d.message.content[0].text;
  const resetsAt = Date.parse('2026-10-01T15:00:00Z') / 1000;
  const structured = limitMessage('2026-10-01T12:00:00Z', 'a', {
    apiError: 'usage_limit_reached',
    apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'seven_day_opus' } },
  });
  assert.deepEqual(claudeLimit(structured, text(structured)), { kind: 'seven_day_opus', resetsAt: '2026-10-01T15:00:00.000Z' });

  // Only the text: the kind comes from it.
  const weekly = limitMessage('2026-10-01T12:00:00Z', 'b', {}, 'Weekly limit reached · resets Oct 9, 10am');
  assert.deepEqual(claudeLimit(weekly, text(weekly)), { kind: 'seven_day', resetsAt: null });
  const plain = limitMessage('2026-10-01T12:00:00Z', 'c');
  assert.equal(claudeLimit(plain, text(plain)).kind, 'unknown');

  // Older Claude Code: "Claude AI usage limit reached|<reset epoch>".
  assert.deepEqual(claudeLimit({ message: { model: '<synthetic>' } }, `Claude AI usage limit reached|${resetsAt}`), {
    kind: 'five_hour',
    resetsAt: '2026-10-01T15:00:00.000Z',
  });

  // Spend limits on team / enterprise plans.
  const spend = limitMessage('2026-10-01T12:00:00Z', 'd', { error: 'billing_error' }, "You've hit your monthly spend limit.");
  assert.equal(claudeLimit(spend, text(spend)).kind, 'spend');

  // Not usage limits: a capacity hiccup retried by the client, login and server errors.
  const transient = limitMessage('2026-10-01T12:00:00Z', 'e', { apiErrorIsTransient: true }, 'API Error: Request rejected (429) · this may be a temporary capacity issue.');
  assert.equal(claudeLimit(transient, text(transient)), null);
  const login = limitMessage('2026-10-01T12:00:00Z', 'f', { error: 'authentication_failed' }, 'Login expired · Please run /login');
  assert.equal(claudeLimit(login, text(login)), null);
  const server = limitMessage('2026-10-01T12:00:00Z', 'g', { error: 'server_error' }, 'API Error: Connection lost mid-response.');
  assert.equal(claudeLimit(server, text(server)), null);
  // Ordinary assistant text that mentions limits.
  assert.equal(claudeLimit({ message: { model: 'claude-opus-5-5' } }, 'The usage limit resets at 3pm.'), null);
});

test('copilotLimit: premium request quota and rate limit', () => {
  assert.deepEqual(copilotLimit({ errorType: 'quota', statusCode: 402, message: 'Quota exceeded.' }), { kind: 'quota', resetsAt: null });
  assert.deepEqual(copilotLimit({ errorType: 'rate_limit', statusCode: 429 }), { kind: 'rate_limit', resetsAt: null });
  assert.equal(copilotLimit({ errorType: 'query', statusCode: 400, message: '"llama3.2" does not support thinking' }), null);
});

test('Claude Code loader records usage-limit hits once, resumed copies included', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ccreports-'));
  try {
    const proj = path.join(root, '-work-app');
    await mkdir(proj, { recursive: true });
    const resetsAt = Date.parse('2026-10-01T15:00:00Z') / 1000;
    const hit = limitMessage('2026-10-01T12:00:00Z', 'l1', {
      apiError: 'usage_limit_reached',
      apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' } },
    });
    const lines = [
      { type: 'user', sessionId: 's1', cwd: '/work/app', timestamp: '2026-10-01T11:59:00Z', uuid: 'u1', message: { role: 'user', content: 'go on' } },
      hit,
      limitMessage('2026-10-01T12:01:00Z', 'l2', { error: 'server_error' }, 'API Error: Connection lost mid-response.'),
    ];
    await writeFile(path.join(proj, 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    await writeFile(path.join(proj, 's1-resumed.jsonl'), JSON.stringify(hit) + '\n');
    const data = await loadRecords({ dirs: [root] });
    assert.equal(data.limits.length, 1);
    assert.deepEqual(
      { ...data.limits[0] },
      { timestamp: '2026-10-01T12:00:00Z', sessionId: 's1', project: '/work/app', agent: null, source: 'claude', kind: 'five_hour', resetsAt: '2026-10-01T15:00:00.000Z' },
    );
    assert.equal(data.usage.length, 0); // the synthetic message is not usage
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Copilot loader records quota and rate-limit errors', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ccreports-copilot-'));
  try {
    const ev = (type, timestamp, data) => ({ type, data, id: `${type}-${timestamp}`, timestamp });
    const events = [
      ev('session.start', '2026-10-01T10:00:00Z', { sessionId: 'c1', context: { cwd: '/work/app' } }),
      ev('user.message', '2026-10-01T10:00:01Z', { content: 'add a button' }),
      ev('session.error', '2026-10-01T10:00:02Z', { errorType: 'quota', message: 'Quota exceeded.', statusCode: 402 }),
      ev('session.error', '2026-10-01T10:05:00Z', { errorType: 'rate_limit', message: 'Sorry, you have exceeded your rate limit.', statusCode: 429 }),
      ev('session.error', '2026-10-01T10:06:00Z', { errorType: 'query', message: 'model not found', statusCode: 400 }),
    ];
    await mkdir(path.join(root, 'c1'), { recursive: true });
    await writeFile(path.join(root, 'c1', 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const data = await loadCopilotRecords({ dirs: [root] });
    assert.deepEqual(data.limits.map((l) => [l.kind, l.sessionId, l.project, l.source]), [
      ['quota', 'c1', '/work/app', 'copilot'],
      ['rate_limit', 'c1', '/work/app', 'copilot'],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('limitStats and limitParts: hits per limit, sessions, time to reset; nothing without hits', () => {
  const hit = (timestamp, sessionId, kind, resetsAt = null) => ({ timestamp, sessionId, project: '/p', agent: null, source: 'claude', kind, resetsAt });
  const data = {
    limits: [
      hit('2026-10-01T12:00:00Z', 's1', 'five_hour', '2026-10-01T15:00:00Z'),
      hit('2026-10-02T09:00:00Z', 's2', 'five_hour', '2026-10-02T10:00:00Z'),
      hit('2026-10-02T09:30:00Z', 's2', 'five_hour', '2026-10-02T10:00:00Z'),
      hit('2026-10-05T18:00:00Z', 's3', 'seven_day'),
      hit('2026-09-01T12:00:00Z', 's0', 'seven_day'), // before --since
    ],
  };
  const stats = limitStats(data, { since: '2026-10-01', timeZone: 'UTC' });
  assert.equal(stats.hits.length, 4);
  assert.equal(stats.sessions, 3);
  assert.deepEqual(stats.byKind, [
    { kind: 'five_hour', title: '5-hour limit', hits: 3, lastHit: '2026-10-02T09:30:00Z', sessions: 2, medianWaitMs: 60 * 60_000 },
    { kind: 'seven_day', title: 'Weekly limit', hits: 1, lastHit: '2026-10-05T18:00:00Z', sessions: 1, medianWaitMs: null },
  ]);

  const parts = limitParts(stats, { timeZone: 'UTC' });
  assert.deepEqual(parts.summary, ['A usage limit stopped 3 sessions 4 times; the last was a weekly limit on 2026-10-05.']);
  assert.deepEqual(parts.sections[0].rows.map((r) => r.cells), [
    ['5-hour limit', 3, 2, '2026-10-02', '1h'],
    ['Weekly limit', 1, 1, '2026-10-05', ''],
  ]);
  assert.match(toMarkdown({ title: 'x', ...parts }), /## Usage limits/);
  assert.equal(limitsJSON(stats).events.length, 4);

  const none = limitParts(limitStats({ limits: [] }, {}), {});
  assert.deepEqual(none, { summary: [], sections: [] });
});

test('duration formats minutes, hours and days', () => {
  assert.equal(duration(40 * 60_000), '40m');
  assert.equal(duration(135 * 60_000), '2h 15m');
  assert.equal(duration(76 * 3_600_000), '3d 4h');
  assert.equal(duration(null), '');
});
