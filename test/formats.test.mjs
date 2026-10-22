import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toTerminal, toMarkdown, toCsv, toHtml } from '../src/formats.mjs';
import { money, share } from '../src/report.mjs';

const doc = {
  title: 'Test <report>',
  sections: [
    {
      title: 'Tools',
      note: 'top 2 of 3',
      columns: [
        { title: 'Tool', align: 'left', maxWidth: 6 },
        { title: 'Calls', align: 'right' },
        { title: 'Cost', align: 'right' },
        { title: 'Share', align: 'right' },
      ],
      rows: [
        { cells: ['Bash, a|b', 1234, money(1.5), share(1, 4)] },
        { cells: ['sub item', 3, '', ''], style: 'sub' },
        { cells: ['Total', 1234, money(1.5), share(0, 0)], style: 'total' },
      ],
    },
  ],
};

test('terminal: formats numbers, truncates, marks sub-rows, no color codes when disabled', () => {
  const out = toTerminal(doc, { color: false });
  assert.match(out, /1,234/);
  assert.match(out, /\$1\.50/);
  assert.match(out, /25\.0%/);
  assert.match(out, /Bash,…/);
  assert.match(out, /└ sub i…/);
  assert.match(out, /Tools {2}\(top 2 of 3\)/);
  assert.doesNotMatch(out, /\x1b\[/);
});

test('markdown: escapes pipes, aligns columns, bolds totals', () => {
  const out = toMarkdown(doc);
  assert.match(out, /^# Test <report>/);
  assert.match(out, /## Tools _\(top 2 of 3\)_/);
  assert.match(out, /\| :--- \| ---: \| ---: \| ---: \|/);
  assert.match(out, /\| Bash, a\\\|b \| 1,234 \| \$1\.50 \| 25\.0% \|/);
  assert.match(out, /\| └ sub item \| 3 \|/);
  assert.match(out, /\| \*\*Total\*\* \| \*\*1,234\*\* \|/);
});

test('csv: raw numbers, quoted fields, no sub-rows', () => {
  const lines = toCsv(doc).trim().split('\n');
  assert.deepEqual(lines, ['Tool,Calls,Cost,Share', '"Bash, a|b",1234,1.5000,25.00', 'Total,1234,1.5000,']);
});

test('html: escapes content, adds sort values and share bars', () => {
  const out = toHtml(doc, { generatedAt: new Date('2026-10-22T10:00:00Z'), pricingSource: 'live' });
  assert.match(out, /<title>Test &lt;report&gt;<\/title>/);
  assert.match(out, /data-v="1234">1,234</);
  assert.match(out, /class="right bar" data-v="0.25" style="--p:25.00%"/);
  // Sub-rows start collapsed under their parent, which gets a toggle; the table gets expand/collapse-all.
  assert.match(out, /<tr data-group="0"><td class="left"><button type="button" class="toggle" aria-expanded="false"/);
  assert.match(out, /<tr class="sub" data-parent="0" hidden>/);
  assert.match(out, /data-expand="all">Expand all</);
  assert.match(out, /data-expand="none">Collapse all</);
  assert.doesNotMatch(out, /<tr class="total"[^>]*data-group/);
  assert.match(out, /<tr class="total">/);
  // Tables with sub-rows are not sortable (sorting would detach them from their parent row).
  assert.doesNotMatch(out, /<th [^>]*data-sort/);
  const flat = toHtml({ ...doc, sections: [{ ...doc.sections[0], rows: [doc.sections[0].rows[0]] }] });
  assert.match(flat, /<th class="left" data-sort>Tool<\/th>/);
  assert.match(out, /cost estimates at Claude API list prices/);
});
