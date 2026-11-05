import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverage, methodSection } from '../src/method.mjs';
import { toCsv, toHtml, toMarkdown } from '../src/formats.mjs';

test('coverage: first to last activity, in days', () => {
  const range = coverage({ firstActivity: '2026-10-01T08:00:00Z', lastActivity: '2026-10-30T20:00:00Z' }, { timeZone: 'UTC' });
  assert.deepEqual(range, { from: '2026-10-01', to: '2026-10-30', days: 30, text: '2026-10-01 → 2026-10-30 (30 days)' });
  assert.equal(coverage({ firstActivity: '2026-10-01T08:00:00Z', lastActivity: '2026-10-01T09:00:00Z' }, { timeZone: 'UTC' }).text, '2026-10-01 → 2026-10-01 (1 day)');
  assert.equal(coverage({ firstActivity: null, lastActivity: null }), null);
});

test('methodSection: notes only for the sources and sections in the report', () => {
  const range = { text: '2026-10-01 → 2026-10-30 (30 days)' };
  const claudeOnly = methodSection({ claude: true, cost: true }, { range, since: '2026-10-01', timeZone: 'UTC' });
  const terms = claudeOnly.notes.map((n) => n.term);
  assert.ok(terms.includes('Cost') && terms.includes('Tokens'));
  assert.ok(!terms.includes('Adoption phases') && !terms.includes('Recommendations') && !terms.includes('Tokens per tool, skill and subagent'));
  const text = claudeOnly.notes.map((n) => n.text).join(' ');
  assert.match(text, /2026-10-01 → 2026-10-30 \(30 days\), filtered to from 2026-10-01\. Dates are in UTC\./);
  assert.doesNotMatch(text, /Copilot|Cursor/);

  const all = methodSection(
    { claude: true, copilot: true, cursor: true, cost: true, breakdown: true, adoption: true, recommendations: true, intentsByClaude: true },
    { range },
  );
  const byTerm = Object.fromEntries(all.notes.map((n) => [n.term, n.text]));
  assert.match(byTerm.Data, /~\/\.claude\/projects.*; ~?.*~\/\.copilot\/session-state; and Cursor/);
  assert.match(byTerm['Session intent'], /Classified by Claude/);
  assert.match(byTerm['Adoption phases'], /10 or more tool calls per prompt/);
  assert.match(byTerm.Cost, /AI credits/);

  const cursorOnly = methodSection({ cursor: true }, { range });
  assert.match(cursorOnly.notes.find((n) => n.term === 'Tokens').text, /activity only/);
  assert.ok(!cursorOnly.notes.some((n) => n.term === 'Cost'));
});

test('documents render the notes and the covered period; CSV keeps the period table first and skips the notes', () => {
  const doc = {
    title: 'x',
    coverage: { text: '2026-10-01 → 2026-10-30 (30 days)' },
    sections: [
      { title: 'Skills', columns: [{ title: 'Skill' }], rows: [{ cells: ['plan'] }] },
      { title: "How it's measured", notes: [{ term: 'Data', text: 'local `logs`' }] },
      { title: 'Usage per session', main: true, columns: [{ title: 'Session' }], rows: [{ cells: ['s1'] }] },
    ],
  };
  const html = toHtml(doc);
  assert.match(html, /<strong>Data: 2026-10-01 → 2026-10-30 \(30 days\)<\/strong>/);
  assert.match(html, /<section class="method"><details><summary><h2>How it&#39;s measured<\/h2><\/summary>\n<dl><dt>Data<\/dt><dd>local <code>logs<\/code><\/dd><\/dl>/);
  assert.ok(html.indexOf('Skills') < html.indexOf('How it&#39;s measured') && html.indexOf('How it&#39;s measured') < html.indexOf('Usage per session'));
  const md = toMarkdown(doc);
  assert.doesNotMatch(md, /<details>/);
  assert.match(md, /_Data: 2026-10-01 → 2026-10-30 \(30 days\)_/);
  assert.match(md, /- \*\*Data:\*\* local `logs`/);
  assert.equal(toCsv(doc), 'Session\ns1\n\nSkill\nplan\n');
});

test('HTML folds long tables and minor recommendations', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ cells: [`s${i}`] }));
  const html = toHtml({ title: 'x', sections: [{ title: 'Skills', fold: 15, columns: [{ title: 'Skill' }], rows }] });
  assert.equal((html.match(/<tr hidden>/g) ?? []).length, 5);
  assert.match(html, /<table data-fold="15">/);
  assert.match(html, /data-fold-toggle[^>]*>Show all 20</);
  // A couple of extra rows are not worth a button.
  const short = toHtml({ title: 'x', sections: [{ title: 'Skills', fold: 15, columns: [{ title: 'Skill' }], rows: rows.slice(0, 17) }] });
  assert.doesNotMatch(short, /<table data-fold/);

  const item = (title, impact, atStakeUSD = null) => ({ title, impact, atStakeUSD, evidence: 'e', advice: 'a' });
  const recs = toHtml({
    title: 'x',
    sections: [{ title: 'R', items: [item('Big', 'high', 400), item('Cheap', 'medium', 0.2), item('Small', 'low')] }],
  });
  const [open, more] = recs.split('<details class="more">');
  assert.match(open, /Big/);
  assert.doesNotMatch(open, /Cheap|Small/);
  assert.match(more, /^<summary>2 more, with less at stake<\/summary><ol class="recs" start="2">.*Cheap.*Small/s);
  // Only minor items: the first stays open.
  const onlyLow = toHtml({ title: 'x', sections: [{ title: 'R', items: [item('Small', 'low')] }] });
  assert.doesNotMatch(onlyLow, /<details class="more"/);
});
