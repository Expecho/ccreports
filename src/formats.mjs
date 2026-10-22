// Output formats for report documents built by src/report.mjs:
// terminal tables, Markdown, CSV and a self-contained HTML page.

export const FORMATS = ['table', 'json', 'csv', 'markdown', 'html'];

/** Display text for a cell; csv=true gives raw, spreadsheet-friendly values. */
function cellText(cell, { csv = false } = {}) {
  if (cell == null || cell === '') return '';
  if (typeof cell === 'number') return csv ? String(cell) : cell.toLocaleString('en-US');
  // Estimates are prefixed with "~" for display; CSV keeps the plain number.
  const mark = cell.approx && !csv ? '~' : '';
  if (cell.kind === 'num') return csv ? String(Math.round(cell.v)) : mark + Math.round(cell.v).toLocaleString('en-US');
  if (cell.kind === 'usd') {
    return csv
      ? cell.v.toFixed(4)
      : `${mark}$${cell.v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (cell.kind === 'avg') {
    if (cell.v == null) return '';
    return csv ? cell.v.toFixed(2) : cell.v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }
  if (cell.kind === 'pct') {
    if (cell.v == null) return csv ? '' : '-';
    return csv ? (cell.v * 100).toFixed(2) : `${(cell.v * 100).toFixed(1)}%`;
  }
  return String(cell);
}

/** Numeric value of a cell for sorting, or null for text. */
function cellValue(cell) {
  if (typeof cell === 'number') return cell;
  if (cell && typeof cell === 'object') return cell.v;
  return null;
}

const truncate = (s, max) => (max && s.length > max ? s.slice(0, max - 1) + '…' : s);

// ---------------------------------------------------------------- terminal

function paint(enabled) {
  const p = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { bold: p('1'), dim: p('2'), cyan: p('36'), yellow: p('33') };
}

// eslint-disable-next-line no-control-regex
const visible = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

function terminalTable({ columns, rows }, c) {
  const text = rows.map((r) => ({
    style: r.style,
    cells: r.cells.map((cell, i) => {
      const s = truncate(cellText(cell), columns[i].maxWidth);
      return i === 0 && r.style === 'sub' && s ? `  └ ${s}` : s;
    }),
  }));
  const widths = columns.map((col, i) => Math.max(col.title.length, ...text.map((r) => visible(r.cells[i]).length)));
  const pad = (s, i) => {
    const gap = ' '.repeat(widths[i] - visible(s).length);
    return columns[i].align === 'right' ? gap + s : s + gap;
  };
  const line = (l, m, r) => c.dim(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r);
  const row = (cells) => c.dim('│') + cells.map((s, i) => ` ${pad(s, i)} `).join(c.dim('│')) + c.dim('│');

  const out = [line('┌', '┬', '┐'), row(columns.map((col) => c.cyan(col.title))), line('├', '┼', '┤')];
  for (const r of text) {
    if (r.style === 'total') out.push(line('├', '┼', '┤'));
    const styler = r.style === 'total' ? c.yellow : r.style === 'sub' ? c.dim : (s) => s;
    out.push(row(r.cells.map((s) => (s ? styler(s) : s))));
  }
  out.push(line('└', '┴', '┘'));
  return out.join('\n');
}

export function toTerminal(doc, { color = false } = {}) {
  const c = paint(color);
  const out = [c.bold(doc.title)];
  doc.sections.forEach((s, i) => {
    if (s.title) out.push((i > 0 ? '\n' : '') + c.bold(s.title) + (s.note ? c.dim(`  (${s.note})`) : ''));
    out.push(terminalTable(s, c));
  });
  return out.join('\n');
}

// ---------------------------------------------------------------- markdown

const mdEscape = (s) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function toMarkdown(doc) {
  const out = [`# ${doc.title}`];
  for (const s of doc.sections) {
    out.push('');
    if (s.title) out.push(`## ${s.title}${s.note ? ` _(${s.note})_` : ''}`, '');
    out.push(`| ${s.columns.map((col) => mdEscape(col.title)).join(' | ')} |`);
    out.push(`| ${s.columns.map((col) => (col.align === 'right' ? '---:' : ':---')).join(' | ')} |`);
    for (const r of s.rows) {
      const cells = r.cells.map((cell, i) => {
        let t = mdEscape(cellText(cell));
        if (t && i === 0 && r.style === 'sub') t = `└ ${t}`;
        if (t && r.style === 'total') t = `**${t}**`;
        return t;
      });
      out.push(`| ${cells.join(' | ')} |`);
    }
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- csv

const csvField = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * One CSV table per section, separated by a blank line. Numbers are raw
 * (no separators, no "$" or "%"); breakdown sub-rows are left out.
 */
export function toCsv(doc) {
  return (
    doc.sections
      .map((s) => {
        const lines = [s.columns.map((col) => csvField(col.title)).join(',')];
        for (const r of s.rows) {
          if (r.style === 'sub') continue;
          lines.push(r.cells.map((cell) => csvField(cellText(cell, { csv: true }))).join(','));
        }
        return lines.join('\n');
      })
      .join('\n\n') + '\n'
  );
}

// ---------------------------------------------------------------- html

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

function htmlTable({ columns, rows }) {
  const hasSubRows = rows.some((r) => r.style === 'sub');
  const sortable = !hasSubRows;
  const head = columns
    .map((col) => `<th class="${col.align}"${sortable ? ' data-sort' : ''}>${esc(col.title)}</th>`)
    .join('');

  // Breakdown sub-rows start collapsed under the row they follow.
  let group = -1;
  const body = rows
    .map((r, index) => {
      const isSub = r.style === 'sub';
      if (!isSub) group = index;
      const hasChildren = !isSub && rows[index + 1]?.style === 'sub';
      const cells = r.cells
        .map((cell, i) => {
          const col = columns[i];
          const v = cellValue(cell);
          const classes = [col.align];
          if (cell?.kind === 'pct') classes.push('bar');
          const attrs = [`class="${classes.join(' ')}"`];
          if (v != null) attrs.push(`data-v="${v}"`);
          if (cell?.kind === 'pct' && cell.v != null) attrs.push(`style="--p:${(cell.v * 100).toFixed(2)}%"`);
          const toggle =
            i === 0 && hasChildren
              ? '<button type="button" class="toggle" aria-expanded="false" aria-label="Show breakdown"></button>'
              : '';
          return `<td ${attrs.join(' ')}>${toggle}${esc(cellText(cell))}</td>`;
        })
        .join('');
      const rowAttrs = [];
      if (r.style) rowAttrs.push(`class="${r.style}"`);
      if (isSub) rowAttrs.push(`data-parent="${group}" hidden`);
      if (hasChildren) rowAttrs.push(`data-group="${group}"`);
      return `<tr${rowAttrs.length ? ' ' + rowAttrs.join(' ') : ''}>${cells}</tr>`;
    })
    .join('\n');

  const controls = hasSubRows
    ? '<div class="controls"><button type="button" data-expand="all">Expand all</button><button type="button" data-expand="none">Collapse all</button></div>\n'
    : '';
  return `${controls}<div class="scroll"><table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody></table></div>`;
}

export function toHtml(doc, { generatedAt = new Date(), pricingSource } = {}) {
  const meta = [`Generated ${generatedAt.toLocaleString('sv-SE').slice(0, 16)}`];
  if (pricingSource) {
    meta.push(`cost estimates at ${pricingSource === 'builtin' ? 'built-in ' : ''}Claude API list prices`);
  }
  const sections = doc.sections
    .map(
      (s) =>
        `<section>${s.title ? `<h2>${esc(s.title)}${s.note ? ` <span class="note">${esc(s.note)}</span>` : ''}</h2>` : ''}\n${htmlTable(s)}</section>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.title)}</title>
<style>
:root { --bg:#f7f7f5; --card:#fff; --fg:#1f2328; --muted:#6b7280; --line:#e5e7eb; --accent:#2563eb; --bar:rgba(37,99,235,.14); --total:#fef9c3; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#0f1115; --card:#171a21; --fg:#e6e8eb; --muted:#9aa3af; --line:#2a2f3a; --accent:#7aa2ff; --bar:rgba(122,162,255,.18); --total:#3a3413; }
}
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { padding:24px 16px 48px; }
h1 { font-size:22px; margin:0 0 4px; }
.meta { color:var(--muted); margin:0 0 20px; }
section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin:0 0 16px; }
h2 { font-size:15px; margin:0 0 10px; }
.note { color:var(--muted); font-weight:normal; font-size:13px; }
.scroll { overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums; }
th, td { padding:5px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.03em; }
th[data-sort] { cursor:pointer; user-select:none; }
th[data-sort]:hover { color:var(--accent); }
.left { text-align:left; } .right { text-align:right; }
td.bar { background:linear-gradient(to left, var(--bar) var(--p), transparent var(--p)); }
tr.sub td { color:var(--muted); font-size:13px; }
tr.sub td:first-child { padding-left:40px; }
tr.sub[hidden] { display:none; }
.controls { display:flex; gap:8px; margin:0 0 10px; }
.controls button { font:inherit; font-size:13px; color:var(--fg); background:transparent; border:1px solid var(--line); border-radius:6px; padding:4px 10px; cursor:pointer; }
.controls button:hover { border-color:var(--accent); color:var(--accent); }
.toggle { font:inherit; width:20px; height:20px; margin:0 6px 0 -4px; padding:0; border:0; border-radius:4px; background:transparent; color:var(--muted); cursor:pointer; vertical-align:middle; }
.toggle::before { content:"▸"; display:inline-block; transition:transform .12s; }
.toggle[aria-expanded="true"]::before { transform:rotate(90deg); }
.toggle:hover { color:var(--accent); background:var(--bar); }
tr[data-group] { cursor:pointer; }
tr.total td { font-weight:600; background:var(--total); border-top:2px solid var(--line); }
tbody tr:not(.total):hover td { background-color:var(--bar); }
</style>
</head>
<body>
<main>
<h1>${esc(doc.title)}</h1>
<p class="meta">${esc(meta.join(' · '))}</p>
${sections}
</main>
<script>
// Breakdown: click a row (or its toggle) to show/hide its sub-rows; the
// buttons above a table expand or collapse every row in it.
function setExpanded(row, open) {
  const body = row.parentElement;
  body.querySelectorAll('tr[data-parent="' + row.dataset.group + '"]').forEach((r) => (r.hidden = !open));
  const btn = row.querySelector('.toggle');
  btn.setAttribute('aria-expanded', String(open));
  btn.setAttribute('aria-label', open ? 'Hide breakdown' : 'Show breakdown');
}
document.querySelectorAll('tr[data-group]').forEach((row) => {
  row.addEventListener('click', () => setExpanded(row, row.querySelector('.toggle').getAttribute('aria-expanded') !== 'true'));
});
document.querySelectorAll('[data-expand]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const table = btn.closest('section').querySelector('table');
    table.querySelectorAll('tr[data-group]').forEach((row) => setExpanded(row, btn.dataset.expand === 'all'));
  });
});

// Click a column header to sort (totals row stays last).
document.querySelectorAll('th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const table = th.closest('table'), body = table.tBodies[0], i = th.cellIndex;
    const dir = th.dataset.dir === 'desc' ? 'asc' : 'desc';
    table.querySelectorAll('th').forEach((h) => delete h.dataset.dir);
    th.dataset.dir = dir;
    const rows = [...body.rows].filter((r) => !r.classList.contains('total'));
    const key = (r) => { const c = r.cells[i]; return c.dataset.v !== undefined ? Number(c.dataset.v) : c.textContent; };
    rows.sort((a, b) => { const x = key(a), y = key(b); const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y)); return dir === 'asc' ? d : -d; });
    rows.forEach((r) => body.insertBefore(r, body.querySelector('tr.total')));
  });
});
</script>
</body>
</html>
`;
}
