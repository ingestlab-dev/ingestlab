import { contentItems, normalizeGlyphs } from './pdfio.js';

const closure = /^(?:P|H[1-6]|LBody|TH|TD)$/;
const lineNumber = /^\d{1,2}[a-z]?$/i;
const checkbox = (f) => f.controlType === 'checkbox' || f.controlType === 'radio';
const stripLeaders = (s) => s.replace(/(?:\s+\.){3,}(?=\s|$)/g, '').trim();
const normalize = (s) => stripLeaders(s.replace(/\s+/gu, ' ').trim());
const fieldText = (f) => checkbox(f) ? (f.isChecked ? '\u2611' : '\u2610') :
  (Array.isArray(f.fieldValue) ? f.fieldValue.join(', ') : String(f.fieldValue ?? '')).trim();

function formTables(blocks, includeRowInfo) {
  const out = [];
  for (let i = 0; i < blocks.length;) {
    if (blocks[i].type !== 'form_line') {
      out.push(blocks[i++]);
      continue;
    }
    const start = i;
    while (blocks[i]?.type === 'form_line') i++;
    const lines = blocks.slice(start, i);
    if (!lines.some(({ hasField }) => hasField)) {
      for (const { text } of lines) out.push({ type: 'paragraph', text });
      continue;
    }
    const numbered = lines.filter(({ text, hasValueField }) =>
      hasValueField && /^\d{1,2}[a-z]?\s/i.test(text)).length >= 2;
    const header = numbered ? ['Line', 'Description', 'Value'] : ['Field or instruction', 'Value'];
    const rows = lines.map(({ text, value }) => {
      if (!numbered) return [text, value];
      const match = text.match(/^(\d{1,2}[a-z]?|[a-z])\s+(.+)$/);
      return match ? [match[1], match[2], value] : ['', text, value];
    });
    const table = { type: 'table', kind: 'ruled', tagged: true, form: true, rows: [header, ...rows] };
    if (includeRowInfo) table.formRows = [null, ...lines.map(({ hasField, hasValueField, x, y }) =>
      ({ hasField, hasValueField, x, y }))];
    out.push(table);
  }
  return out;
}

export async function readTaggedForm(page, data, { dropArtifacts = false, includeRowInfo = false } = {}) {
  const fields = new Map(data.annotations.filter((a) => a.id && a.controlType && a.controlType !== 'button')
    .map((a) => ['pdfjs_internal_id_' + a.id, a]));
  if (fields.size < 2 || typeof page.getStructTree !== 'function') return null;
  const tree = await page.getStructTree();
  if (!tree) return null;
  const content = new Map(), stack = [];
  let total = 0;
  const { items } = await page.getTextContent({ includeMarkedContent: true });
  const visible = dropArtifacts ? new Set(contentItems(items)) : null;
  for (const item of items) {
    if (item.type?.startsWith('beginMarkedContent')) stack.push(item.id);
    else if (item.type === 'endMarkedContent') stack.pop();
    else if (typeof item.str === 'string' && (!visible || visible.has(item))) {
      const id = stack.findLast(Boolean);
      total += item.str.trim().length;
      if (id) {
        if (!content.has(id)) content.set(id, []);
        content.get(id).push(item);
      }
    }
  }
  const seen = new Set(), used = new Set(), ordered = [], blocks = [];
  let unsupported = false;
  const viewport = page.getViewport({ scale: 1 });
  const fragments = (n) => {
    if (n.type === 'content') {
      if (seen.has(n.id)) return [];
      seen.add(n.id);
      const items = content.get(n.id) || [];
      const text = normalize(normalizeGlyphs(items.map((it) => it.str + (it.hasEOL ? ' ' : '')).join('')));
      if (!text) return [];
      const points = items.filter((it) => it.str.trim()).map((it) =>
        viewport.convertToViewportPoint(it.transform[4], it.transform[5]));
      return [{ text, y: points[0]?.[1], endY: points.at(-1)?.[1], x: points[0]?.[0] }];
    }
    if (n.type === 'annotation') {
      const f = fields.get(n.id);
      if (!f || used.has(f)) return [];
      used.add(f);
      ordered.push(f);
      return [{ text: fieldText(f), f, x: f.bbox.x0, y: (f.bbox.y0 + f.bbox.y1) / 2 + 2 }];
    }
    return (n.children || []).flatMap(fragments);
  };
  function labelFields(parts, context) {
    for (let i = 0; i < parts.length; i++) {
      const { f } = parts[i];
      if (!f || f.alternativeText) continue;
      const next = parts.slice(i + 1).findIndex((p) => p.f);
      const right = parts.slice(i + 1, next === -1 ? parts.length : i + 1 + next).map((p) => p.text).join(' ');
      const left = parts.slice(0, i).reverse().find((p) => !p.f && !lineNumber.test(p.text))?.text;
      const label = (checkbox(f) && right.replace(/^\([a-z]\)$/, '')) || left || right;
      if (label && /\p{L}{2}/u.test(label)) f.taggedLabel = label.replace(/\s*\([a-z]\)$/, '');
      if (context) f.taggedLabel = [context, f.taggedLabel].filter(Boolean).join(': ');
    }
  }
  const join = (parts) => {
    let start = parts[0]?.text ?? '', offset = 1;
    if (/^\d{1,2}$/.test(start) && /^[a-z]$/.test(parts[1]?.text)) {
      start += parts[1].text;
      offset++;
    }
    const rest = parts.slice(offset);
    const number = rest.findIndex((p, i) => lineNumber.test(p.text) && !p.f &&
      (i > 0 || /^[a-z] \p{Lu}/u.test(start)) &&
      rest[i + 1]?.f && !checkbox(rest[i + 1].f));
    if (number >= 0 && (lineNumber.test(start) || /^[a-z](?:\s|$)/i.test(start))) {
      start = rest[number].text + start.replace(/^(?:\d{1,2}[a-z]?|[a-z])(?=\s|$)/i, '');
      rest.splice(number, 1);
    }
    return normalize([start, ...rest.map(({ text }) => text)].join(' ')).replace(/\s+([,;])/g, '$1');
  };
  let row = [];
  const flush = () => {
    if (!row.length) return;
    labelFields(row);
    const paired = row.length >= 4 && row.length % 2 === 0 && row.every(({ text, f }, i) => i % 2
      ? f && !checkbox(f)
      : !f && /^\p{L}/u.test(text) && !/[\d/,]/.test(text));
    if (paired) {
      for (let i = 0; i < row.length; i += 2) {
        blocks.push({ type: 'form_line', text: row[i].text, value: row[i + 1].text, hasField: true, hasValueField: true });
      }
    } else if (row.length === 1 && row[0].f && checkbox(row[0].f) && blocks.at(-1)?.type === 'form_line') {
      const prev = blocks.at(-1);
      row[0].f.taggedLabel ||= prev.text;
      prev.text += ' ' + row[0].text;
      prev.hasField = true;
    } else {
      let split = row.length;
      while (split > 0 && row[split - 1].f && !checkbox(row[split - 1].f)) split--;
      const description = row.slice(0, split);
      // The amount field locates the printed line number.
      let text = split === row.length ? join(row) : join(description.concat({ ...row[split], text: '' }));
      if (text.startsWith('\u2022 ')) text = '- ' + text.slice(2);
      const value = row.slice(split).map((p) => p.text).join(' ');
      const hasValueField = split < row.length;
      if (text || hasValueField) {
        const { x, y } = row[0];
        blocks.push({ type: 'form_line', text, value, hasValueField, hasField: row.some((p) => p.f), x, y });
      }
    }
    row = [];
  };
  const emitLine = (parts) => {
    if (!parts.length) return;
    const a = row.at(-1), b = parts[0];
    if (a) {
      const gap = Math.abs((a.endY ?? a.y) - b.y);
      const startsNext = b.x !== undefined && row[0].x !== undefined && b.x < row[0].x - 5;
      const onlyBox = row.length === 1 && checkbox(row[0].f || {});
      const fieldBelow = parts.length === 1 && b.f && gap < 15 &&
        (b.x >= (a.x ?? 0) - 4 || b.y > a.y) && !a.f;
      const nextOption = b.f && checkbox(b.f) && !/^(?:\d+|[a-z])$/.test(a.text) &&
        (row.some((p) => p.f && checkbox(p.f)) || parts.length > 1);
      const nextAmount = a.f && !checkbox(a.f) && /^[a-z]\s+\p{Lu}/u.test(b.text);
      const nextLetter = parts.length === 1 && !b.f && /^[a-z]$/.test(b.text) && row.some((p) => p.f);
      if (!onlyBox && ((!fieldBelow && (gap > 3.5 || startsNext)) || nextOption || nextAmount || nextLetter)) flush();
    }
    row.push(...parts);
  };
  function walk(n) {
    if (n.role === 'Figure' || n.role === 'Formula') {
      unsupported = true;
      return;
    } else if (n.role === 'Table') {
      flush();
      const rows = [], taggedRows = [];
      const visit = (item) => {
        if (item.role === 'TR') taggedRows.push(item.children || []);
        else item.children?.forEach(visit);
      };
      visit(n);
      for (const cols of taggedRows) {
        if (!cols.length || cols.some((c) => c.role !== 'TH' && c.role !== 'TD')) {
          unsupported = true;
          continue;
        }
        const cells = cols.map(fragments);
        cells.forEach((cell, i) => labelFields(cell, [rows[0]?.[i], i ? join(cells[0]) : null].filter(Boolean).join(' / ')));
        rows.push(cells.map(join));
      }
      if (rows.length && rows.every((r) => r.length === rows[0].length)) blocks.push({ type: 'table', kind: 'ruled', tagged: true, rows });
      else unsupported = true;
    } else if (/^H[1-6]$/.test(n.role)) {
      flush();
      const text = join(fragments(n));
      if (!text) return;
      const level = Number(n.role.slice(1));
      const prev = blocks.at(-1);
      if (prev?.type === 'heading' && prev.level === level) prev.text += ' ' + text;
      else blocks.push({ type: 'heading', level, text });
    } else if (closure.test(n.role) || n.type) {
      const parts = fragments(n);
      emitLine(parts);
    } else n.children?.forEach(walk);
  }
  walk(tree);
  flush();
  const coverage = [...seen].reduce((n, id) => n + (content.get(id) || []).reduce((sum, item) => sum + item.str.trim().length, 0), 0);
  if (unsupported || used.size !== fields.size || coverage < total || !blocks.length) {
    for (const field of fields.values()) delete field.taggedLabel;
    return null;
  }
  ordered.forEach((f, i) => { f.taggedOrder = i; });
  return formTables(blocks, includeRowInfo);
}
