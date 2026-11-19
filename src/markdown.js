
import { wrapInlineMath } from './math.js';

const escapeVisualText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/[\\|*\x60[\]_\x7e]/g, '\\$&').replace(/[\r\n]+/g, ' ');

function emitVisualContent(content) {
  if (!content) return [];
  const { nodes, links, labels } = content;
  const result = [];
  if (nodes?.length) {
    result.push('**Detected connections**\n\n' + [
      '| Component | Relationship | Component |', '| --- | --- | --- |',
      ...links.map(({ a, b, directed }) =>
        '| ' + escapeVisualText(nodes[a]) + (directed ? ' | Points to | ' : ' | Connected to | ') +
        escapeVisualText(nodes[b]) + ' |'),
    ].join('\n'));
    const linked = new Set(links.flatMap(({ a, b }) => [a, b]));
    const other = nodes.filter((_, i) => !linked.has(i));
    if (other.length) result.push('**Other components**\n\n' + other.map((s) => '- ' + escapeVisualText(s)).join('\n'));
  }
  if (labels?.length) result.push((links?.length || content.structured ? '**Additional labels**' : '**Transcribed labels (relationships not established)**') +
    '\n\n' + labels.map((s) => '- ' + escapeVisualText(s)).join('\n'));
  return result;
}

const escapeCell = (s) =>
  String(s ?? '')
    .replace(/☐/g, '[ ]')
    .replace(/[☑☒]/g, '[x]')
    .replace(/○/g, '( )')
    .replace(/◉/g, '(x)')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');

const inlineChecks = (s) =>
  String(s ?? '').replace(/☐/g, '[ ]').replace(/[☑☒]/g, '[x]').replace(/○/g, '( )').replace(/◉/g, '(x)');

const CHECK_SPLIT = /([☐☑☒○◉])/;

// Turn runs of checkbox options into task lists.
function emitTaskList(text) {
  const parts = String(text).split(CHECK_SPLIT);
  if (parts.length === 1) return null;
  const intro = inlineChecks(parts[0]).trim();
  const items = [];
  for (let i = 1; i < parts.length; i += 2) {
    const checked = /[☑☒◉]/.test(parts[i]);
    const label = (parts[i + 1] || '').trim();
    if (label) items.push({ checked, label });
    else if (items.length) items[items.length - 1].trailing = (items[items.length - 1].trailing || 0) + 1;
  }
  if (!items.length) return inlineChecks(text);
  const out = [];
  if (intro) out.push(wrapInlineMath(intro));
  for (const it of items) {
    const tail = it.trailing ? ' ' + '[ ]'.repeat(it.trailing) : '';
    out.push(`- [${it.checked ? 'x' : ' '}] ${wrapInlineMath(inlineChecks(it.label))}${tail}`);
  }
  return out.join('\n');
}

/**
 * GFM pipe table. Expresses what pipes can: merged cells keep their text in
 * the top-left owner cell (covered cells empty), group header rows and total
 * rows are bolded, rotated header text lands in its column, the diagonal
 * corner becomes "col / row".
 */
function emitTable(rowsIn, block = {}) {
  let rows = rowsIn.map((r) => (r || []).map((c) => String(c ?? '')));
  while (rows.length > 1 && rows[0].every((c) => !c.trim())) rows = rows.slice(1);
  if (!rows.length) return '';
  const meta = block.meta || {};
  const nCols = Math.max(...rows.map((r) => r.length));
  rows = rows.map((r) => {
    const c = r.slice();
    while (c.length < nCols) c.push('');
    return c;
  });

  const groupSet = new Set(meta.groupRows || []);
  const totalSet = new Set(meta.totalRows || []);
  const rotMap = new Map((meta.rotatedHeaders || []).map((r) => [r.col, r.text]));
  const headerRows = Math.min(meta.headerRows || 1, rows.length);

  // Fill empty span owners from covered cells.
  const text = rows.map((r) => r.map((c) => c.trim()));
  for (const s of block.spans || []) {
    if (!text[s.r] || text[s.r][s.c]) continue;
    const parts = [];
    for (let a = s.r; a < Math.min(s.r + s.rowspan, text.length); a++) {
      for (let b = s.c; b < Math.min(s.c + s.colspan, (text[a] || []).length); b++) {
        if ((a !== s.r || b !== s.c) && text[a][b]) {
          parts.push(text[a][b]);
          text[a][b] = '';
        }
      }
    }
    if (parts.length) text[s.r][s.c] = parts.join(' ');
  }
  for (let ri = 0; ri < text.length; ri++) {
    for (let ci = 0; ci < text[ri].length; ci++) {
      let t = text[ri][ci];
      if (ri < headerRows && rotMap.has(ci) && !t) {
        // Restore rotated labels in empty header cells.
        t = rotMap.get(ci) || '';
      }
      if (meta.diagonal && ri === 0 && ci === 0 && !t) {
        t = [meta.diagonal.b, meta.diagonal.a].filter(Boolean).join(' / ');
      }
      text[ri][ci] = t;
    }
  }
  const grid = text.map((r, ri) => {
    const firstFilled = r.findIndex((c) => c);
    return r.map((t, ci) => ({ t, bold: !!t && (totalSet.has(ri) || (groupSet.has(ri) && ci === firstFilled)) }));
  });

  const alive = [];
  for (let i = 0; i < nCols; i++) if (block.tagged || block.keepColumns || text.some((r) => r[i])) alive.push(i);
  if (!alive.length) return '';
  const out = [];
  if (block.keepColumns && headerRows > 1) {
    const owner = (r, c) => (block.spans || []).find((s) => s.r <= r && r < s.r + s.rowspan &&
      s.c <= c && c < s.c + s.colspan);
    const header = alive.map((c) => {
      const heading = new Set();
      for (let r = 0; r < headerRows; r++) {
        const s = owner(r, c);
        const value = text[s?.r ?? r][s?.c ?? c];
        if (value) heading.add(value);
      }
      return escapeCell([...heading].join(' / '));
    });
    out.push(`| ${header.join(' | ')} |`, `| ${alive.map(() => '---').join(' | ')} |`);
  }
  for (const g of out.length ? grid.slice(headerRows) : grid) {
    const cells = alive.map((i) => {
      const t = escapeCell(g[i].t);
      return g[i].bold && t ? `**${t}**` : t;
    });
    out.push(`| ${cells.join(' | ')} |`);
    if (out.length === 1) out.push(`| ${alive.map(() => '---').join(' | ')} |`);
  }
  return out.join('\n');
}

function emitList(block) {
  return block.items
    .map((item, i) => {
      const isNum = item.ordered && /^\d+$/.test(item.marker || '');
      const marker = isNum ? `${item.marker}. ` : '- ';
      const indent = item.nested ? '  ' : '';
      return indent + marker + inlineChecks(item.text);
    })
    .join('\n');
}


const fieldText = (f) => {
  const label = inlineChecks((f.label || '').trim().replace(/[:\s]+$/, ''));
  const value = inlineChecks((f.value || '').trim());
  const head = label ? `**${label}:**` : '';
  if (f.parts && f.parts.length) {
    const segs = [value, ...f.parts.map((p) => inlineChecks((p.value || '').trim()))].filter(Boolean);
    return `${head} ${segs.join(f.parts.length <= 2 ? ' / ' : ' ')}`.trim();
  }
  return `${head} ${value}`.trim();
};

function emitFormGrid(block) {
  const out = [];
  if (block.title) out.push(`**${block.title.trim()}**`);
  const rows = block.rows || [block.fields || []];
  const used = new Set(
    [
      ...(block.title || '').split(/\s+/),
      ...rows.flat().flatMap((f) => [`${f.label || ''}`, `${f.value || ''}`, ...(f.parts || []).map((p) => p.value || '')]),
    ]
      .join(' ')
      .split(/\s+/)
      .filter(Boolean)
  );
  for (const row of rows) {
    // Keep fields on the same row together in Markdown.
    const line = row.map((f) => fieldText(f)).filter((t) => t.trim()).join('   ');
    if (line.trim()) out.push(line);
  }
  const rest = String(block.text || '')
    .split(/\s+/)
    .filter((w) => w && !used.has(w))
    .join(' ')
    .trim();
  if (rest) out.push(rest);
  return out.join('\n');
}

function emitFormMatrix(block) {
  const out = [];
  if (block.title) out.push(`**${block.title.trim()}**`);
  const cols = block.columns || [];
  if (cols.length) {
    out.push(`| ${cols.map((c) => escapeCell(String(c))).join(' | ')} |`);
    out.push(`| ${cols.map(() => '---').join(' | ')} |`);
  }
  for (const row of block.rows || []) {
    if (cols.length) out.push(`| ${row.map((c) => escapeCell(String(c ?? ''))).join(' | ')} |`);
    else out.push(`- ${inlineChecks(row.map((c) => String(c ?? '').trim()).filter(Boolean).join(' '))}`);
  }
  return out.join('\n');
}

function emitWorksheet(block) {
  const out = [];
  if (block.title) out.push(`**${block.title.trim()}**`);
  out.push('| Code | Item | Amount |');
  out.push('| --- | --- | --- |');
  for (const r of block.rows || []) {
    const label = (r.indent ? '» ' : '') + (r.label || '').trim();
    const code = (r.code || '').trim();
    const amount = (r.amount || '').trim();
    // Treat only double rules as totals.
    const amountMd = r.underline === 'double' && amount ? `**${escapeCell(amount)}**` : escapeCell(amount);
    out.push(`| ${escapeCell(code)} | ${escapeCell(label)} | ${amountMd} |`);
  }
  return out.join('\n');
}

function emitKvPanel(block) {
  const out = ['| Key | Value |', '| --- | --- |'];
  for (const row of block.rows || []) {
    for (let i = 0; i < row.length; i += 2) {
      out.push(`| ${escapeCell(String(row[i] || '').trim())} | ${escapeCell(String(row[i + 1] ?? '').trim())} |`);
    }
  }
  return out.join('\n');
}

export function emitBlocks(blocks, tableRenderer = emitTable) {
  const parts = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
        parts.push('#'.repeat(Math.min(b.level, 6)) + ' ' + inlineChecks(b.text));
        break;
      case 'paragraph': {
        const task = emitTaskList(b.text);
        if (task) parts.push(task);
        else parts.push(wrapInlineMath(inlineChecks(b.text)));
        break;
      }
      case 'list':
        parts.push(emitList(b));
        break;
      case 'code':
        parts.push('```\n' + b.lines.join('\n') + '\n```');
        break;
      case 'table':
        parts.push(tableRenderer(b.rows, b));
        break;
      case 'figure': {
        if (b.caption) {
          const caption = inlineChecks(b.caption);
          parts.push(b.kind === 'caption' ? `> ${caption}` : `> **Visual reconstruction:** ${caption}`);
          break;
        }
        const w = b.bboxW ? ` ${b.bboxW}×${b.bboxH}` : '';
        const label = `${b.kind || 'drawing'}${w}`;
        if (!b.assetPath && !b.vectorPath && !b.sourceCaption && !b.mermaid && !b.tableMd && !b.visualContent)
          parts.push(`> [Image: ${label}]`);
        if (b.sourceCaption) parts.push(`> ${inlineChecks(b.sourceCaption)}`);
        if (b.vectorPath) parts.push(`![Vector reconstruction: ${escapeVisualText(b.sourceCaption || label)}](${b.vectorPath})`);
        if (b.reconstruction === 'circuit-partial')
          parts.push('> Partial schematic: traced connections only. Other components and connections may be missing.');
        else if (b.sourceCaption && (b.mermaid || b.tableMd) && b.reconstruction !== 'geometry')
          parts.push('> Automated reconstruction; verify against the source figure.');
        if (b.approximateValues) parts.push('> Values marked with `~` are estimated from the chart geometry.');
        if (b.mermaid) parts.push('```mermaid\n' + b.mermaid + '\n```');
        if (b.tableMd) parts.push(b.tableMd);
        if (b.visualContent) parts.push(...emitVisualContent({ ...b.visualContent, structured: b.reconstruction === 'geometry' }));
        if (b.sourceText && !b.visualContent && !b.omitSourceText)
          parts.push(b.sourceText.split('\n').map((line) => `> ${inlineChecks(line)}`).join('\n'));
        if (b.assetPath) parts.push(`![figure: ${label}](${b.assetPath})`);
        break;
      }
      case 'image':
        if (b.rasterVisual) {
          const v = b.rasterVisual;
          if (v.kind === 'diagram') {
            const quote = (s) => s.replace(/["&#<>\x60]/g, (c) => '#' + c.charCodeAt(0) + ';');
            parts.push('> Partial diagram reconstructed from image OCR. Lines without arrows have no verified direction.');
            parts.push(['```mermaid', 'flowchart BT',
              ...v.nodes.map((s, i) => `  N${i}["${quote(s)}"]`),
              ...v.edges.map(([a, z, directed]) => `  N${a} ${directed ? '-->' : '---'} N${z}`), '```'].join('\n'));
            if (v.labels.length) parts.push('**Other visible labels:** ' + v.labels.map(escapeVisualText).join('; '));
          } else {
            parts.push(v.kind === 'table' ? '> Table extracted from image OCR.' : '> Chart extracted from image OCR.');
            if (v.partial) parts.push('> Blank cells could not be verified.');
            if (v.approximate) parts.push('> Values prefixed with ~ are estimates from the axis and bar heights.');
            parts.push(tableRenderer([v.headers, ...v.rows], b));
          }
          if (b.assetPath && !b.coveredByPage) parts.push(`![Source image](${b.assetPath})`);
          break;
        }
        if (!b.coveredByPage) parts.push(b.assetPath
          ? `![${b.text.replace(/[\[\]]/g, '')}](${b.assetPath})`
          : `> ${b.text || '[Image region]'}`);
        if (b.ocrLines?.length) parts.push('**Text read from the image (OCR)**\n\n' +
          b.ocrLines.map((s) => '- ' + escapeVisualText(s)).join('\n'));
        break;
      case 'source_page':
        parts.push(`![Source page ${b.page}](${b.assetPath})`);
        break;
      case 'math': {
        const tags = [...b.text.matchAll(/\\tag\{[^{}]*\}/g)];
        const text = tags.length === 1 ? b.text.replace(tags[0][0], '').trimEnd() : b.text;
        parts.push('$$\n\\begin{aligned}\n' + text.split('\n').join(' \\\\\n') + '\n\\end{aligned}' +
          (tags.length === 1 ? '\n' + tags[0][0] : '') + '\n$$');
        break;
      }
      case 'aside':
        parts.push('> ' + inlineChecks(b.text));
        break;
      case 'form_grid':
        parts.push(emitFormGrid(b));
        break;
      case 'form_matrix':
        parts.push(emitFormMatrix(b));
        break;
      case 'worksheet':
        parts.push(emitWorksheet(b));
        break;
      case 'kv_panel':
        parts.push(emitKvPanel(b));
        break;
      case 'form_section': {
        parts.push(b.note ? `**${inlineChecks(b.title || '')}** — *${inlineChecks(b.note)}*` : `**${inlineChecks(b.title || '')}**`);
        const used = new Set(
          [`${b.title || ''}`, `${b.note || ''}`].flatMap((s) => s.split(/\s+/)).filter(Boolean)
        );
        const rest = inlineChecks(
          `${b.text || ''}`
            .split(/\s+/)
            .filter((w) => w && !used.has(w))
            .join(' ')
            .trim()
        );
        if (rest) parts.push(rest);
        break;
      }
      default:
        break;
    }
  }
  return parts.filter((p) => p && p.trim()).join('\n\n');
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function applyImageMode(md, assets, mode = 'refs') {
  if (mode !== 'base64' && mode !== 'none') return md;
  const map = new Map((assets || []).map((a) => [a.path, a]));
  let fence = null;
  return String(md)
    .split('\n')
    .map((line) => {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (marker && (!fence || (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()))) {
        fence = fence ? null : marker[1];
        return line;
      }
      if (fence) return line;
      const m = matchMarkdownImage(line);
      if (!m) return line;
      const [, alt, src] = m;
      if (mode === 'base64') {
        const a = map.get(src);
        if (!a) return line;
        const mime = /\.svg$/i.test(src) ? 'image/svg+xml' : /\.webp$/i.test(src) ? 'image/webp' :
          /\.jpe?g$/i.test(src) ? 'image/jpeg' : 'image/png';
        return `![${alt}](data:${mime};base64,${bytesToBase64(a.bytes)})`;
      }
      return alt.startsWith('figure:') ? `> [${alt}]` : `[image: ${alt}]`;
    })
    .join('\n');
}

export function matchMarkdownImage(line) {
  return line.match(/^!\[((?:\\.|[^\\\]])*)\]\(([^)\s]+)\)\s*$/);
}
