import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileAttribution, createCalibration, charsPerToken, resolveTokens } from '../src/attribution.mjs';

const usage = (context, output = 100) => ({ context, output, model: 'claude-opus-5-5', cache1hShare: 1 });

test('measures tool results from context growth and counts re-reads until compaction', () => {
  const cal = createCalibration();
  const f = new FileAttribution(cal);
  // Request 1 calls Read (10 input chars) and Grep in parallel; results 6,000 + 2,000 chars.
  f.response('r1', usage(10_000, 100));
  f.toolUse('r1', 'read', 10);
  f.toolUse('r1', 'grep', 10);
  f.toolResult('read', 6000);
  f.toolResult('grep', 2000);
  // Request 2: context grew by 100 (output) + 4,000 (results).
  f.response('r2', usage(14_100, 50));
  f.response('r3', usage(14_200, 50));
  f.compact();
  f.response('r4', usage(3_000, 50)); // after compaction: earlier results are gone
  const items = f.finish();
  resolveTokens(items, charsPerToken(cal));

  const read = items.find((i) => i.id === 'read');
  assert.equal(read.measuredTokens, 3000); // 4,000 split 6:2
  assert.equal(read.carried, 2); // r2 and r3, not r4
  assert.equal(charsPerToken(cal), 2); // 8,000 chars / 4,000 tokens
  assert.deepEqual(
    { out: read.tokens.outputTokens, write: read.tokens.cacheWriteTokens, read: read.tokens.cacheReadTokens },
    { out: 5, write: 3005, read: 3005 }, // 10 chars / 2 = 5 input tokens; re-read once (r3)
  );
  assert.equal(read.tokens.measured, true);
  assert.equal(read.tokens.promptTokens, 14_100);
});

test('falls back to estimates across a human turn and for typed skills', () => {
  const cal = createCalibration();
  const f = new FileAttribution(cal);
  f.response('r1', usage(10_000));
  f.toolUse('r1', 'bash', 0);
  f.toolResult('bash', 240);
  f.human(); // user typed something before the next request: delta isn't the tool result alone
  f.skillContent(480, 'skill-uuid'); // a typed /skill: enters the next request
  f.response('r2', usage(20_000));
  f.response('r3', usage(20_100));
  const items = f.finish();
  resolveTokens(items, 2.4); // default ratio: nothing calibrated

  const bash = items.find((i) => i.id === 'bash');
  assert.equal(bash.measuredTokens, null);
  assert.equal(bash.tokens.cacheWriteTokens, 100); // 240 / 2.4
  assert.equal(bash.tokens.cacheReadTokens, 100); // re-read by r3
  const skill = items.find((i) => i.id === 'skill-uuid');
  assert.equal(skill.carried, 2);
  assert.equal(skill.tokens.cacheWriteTokens, 200);
  assert.equal(charsPerToken(cal), 2.4);
});

test('skill content loaded by a Skill tool call is attributed to that call', () => {
  const f = new FileAttribution(createCalibration());
  f.response('r1', usage(1_000, 0));
  f.toolUse('r1', 'skill-call', 20, true);
  f.toolResult('skill-call', 30);
  f.skillContent(5_000);
  f.response('r2', usage(3_000));
  const [item] = f.finish();
  assert.equal(item.resultChars, 5_030);
  assert.equal(item.measuredTokens, 2_000);
});

test('a tool call in the last request of a file never enters a later context', () => {
  const f = new FileAttribution(createCalibration());
  f.response('r1', usage(1_000));
  f.toolUse('r1', 'last', 24);
  const items = f.finish();
  resolveTokens(items, 2.4);
  assert.deepEqual(
    { out: items[0].tokens.outputTokens, write: items[0].tokens.cacheWriteTokens, total: items[0].tokens.total },
    { out: 10, write: 0, total: 10 },
  );
});
