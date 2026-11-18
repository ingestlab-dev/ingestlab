const esc = (value) => String(value ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function semanticTable(rows, block) {
  const cols = Math.max(...rows.map((r) => r.length));
  const headers = Math.min(rows.length, Math.max(1, block.meta?.headerRows || 1));
  const owners = new Map(), covered = new Set();
  for (const s of block.spans || []) {
    const { r, c, rowspan, colspan } = s;
    if (![r, c, rowspan, colspan].every(Number.isInteger) || r < 0 || c < 0 || rowspan < 1 ||
      colspan < 1 || c + colspan > cols || r + rowspan > rows.length || (r < headers && r + rowspan > headers)) continue;
    const owner = r * cols + c;
    const keys = [];
    for (let y = r; y < r + rowspan; y++) for (let x = c; x < c + colspan; x++) {
      if (y !== r || x !== c) keys.push(y * cols + x);
    }
    if (covered.has(owner) || owners.has(owner) ||
        keys.some((k) => covered.has(k) || owners.has(k) || rows[Math.floor(k / cols)][k % cols])) continue;
    owners.set(owner, s);
    for (const key of keys) covered.add(key);
  }
  const row = (r) => '<tr>' + Array.from({ length: cols }, (_, c) => {
    const key = r * cols + c;
    if (covered.has(key)) return '';
    const { rowspan = 1, colspan = 1 } = owners.get(key) || {};
    const tag = r < headers ? 'th' : 'td';
    const text = esc(rows[r][c]);
    const cell = block.tagged || block.form ? text.replace(/[☐☑]/g, (mark) => '<input type="checkbox" disabled aria-label="' +
        (mark === '☑' ? 'Checked" checked' : 'Unchecked"') + '>') : text;
    return '<' + tag + (rowspan > 1 ? ' rowspan="' + rowspan + '"' : '') +
      (colspan > 1 ? ' colspan="' + colspan + '"' : '') +
      (tag === 'th' && colspan === 1 ? ' scope="col"' : '') + '>' + cell + '</' + tag + '>';
  }).join('') + '</tr>';
  const html = rows.map((_, i) => row(i));
  return ['<table class="il-table">', '<thead>', ...html.slice(0, headers), '</thead>',
    '<tbody>', ...html.slice(headers), '</tbody>', '</table>'].join('\n');
}

export function collectControls(page, pageNo) {
  const native = (page.annotations || []).filter((a) => a.controlType);
  const fields = native.map((a) => ({
    page: pageNo, type: a.controlType, bbox: a.bbox, source: 'acroform',
    name: a.fieldName, label: a.alternativeText || a.taggedLabel || a.fieldName, value: a.fieldValue,
    labelSource: a.alternativeText || a.taggedLabel ? 'pdf-label' : 'field-name', checked: a.isChecked,
    exportValue: a.exportValue, readOnly: a.readOnly, required: a.required, multiple: a.multiple, options: a.options,
  }));
  // AcroForm fields are authoritative where PDF controls are available.
  const vector = native.length ? [] : page.formBoxes || [];
  for (const p of vector) {
    const b = p.bbox, h = b.y1 - b.y0;
    const end = vector.reduce((x, { bbox: q }) => q.x0 > b.x1 && Math.abs(q.y1 - b.y1) < h * 0.65 ? Math.min(x, q.x0) : x, page.width);
    const nearby = page.words.filter((w) => w.x0 >= b.x1 - 0.8 && w.x1 <= end + 0.6 &&
      Math.abs(w.y - b.y1) <= Math.max(4, 0.95 * h) && !/^[☑☐☒◉○]$/.test(w.str));
    const first = nearby.filter((w) => w.x0 - b.x1 <= Math.max(10, h * 1.5)).sort((a, b) => a.y - b.y)[0];
    if (!first) continue;
    const words = nearby.filter((w) => Math.abs(w.y - first.y) <= Math.max(2, 0.3 * h)).sort((a, b) => a.x0 - b.x0);
    if (!words.length || words[0].x0 - b.x1 > Math.max(10, h * 1.5)) continue;
    const label = [words[0]];
    for (const w of words.slice(1)) {
      if (w.x0 - label.at(-1).x1 > Math.max(12, h * 1.6)) break;
      label.push(w);
    }
    fields.push({ page: pageNo, type: p.type, bbox: b, source: 'vector', labelSource: 'geometry',
      label: label.map((w) => w.str).join(' '), checked: p.checked, readOnly: true });
  }
  if (native.length && native.every((a) => a.taggedOrder !== undefined)) {
    return native.map((a, i) => [a.taggedOrder, fields[i]]).sort(([a], [b]) => a - b).map(([, field]) => field);
  }
  return fields.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
}

export function renderControls(controls = []) {
  const out = [];
  let page = null;
  for (const [i, f] of controls.entries()) {
    if (page !== f.page) {
      if (page !== null) out.push('</fieldset>');
      page = f.page;
      out.push('<fieldset><legend>Page ' + page + '</legend>');
    }
    const id = 'il-control-' + i;
    const label = esc(f.labelSource === 'field-name' ? 'Field ' + (i + 1) : f.label || f.name || 'Field ' + (i + 1));
    const attrs = ' id="' + id + '" name="' + esc(f.name || id) + '"' + (f.required ? ' required' : '');
    const readonly = f.readOnly ? ' readonly' : '';
    const disabled = f.readOnly ? ' disabled' : '';
    let html;
    if (f.type === 'textarea') html = '<textarea' + attrs + readonly + '>' + esc(f.value) + '</textarea>';
    else if (f.type === 'select') {
      const values = Array.isArray(f.value) ? f.value : [f.value];
      html = '<select' + attrs + disabled + (f.multiple ? ' multiple' : '') + '>' +
        (f.options || []).map((o) => '<option value="' + esc(o.value) + '"' +
          (values.includes(o.value) ? ' selected' : '') + '>' + esc(o.label ?? o.value) + '</option>').join('') + '</select>';
    } else if (f.type === 'button') html = '<button type="button"' + attrs + ' disabled>' + label + '</button>';
    else if (['checkbox', 'radio'].includes(f.type)) html = '<input type="' + f.type + '"' + attrs +
      ' value="' + esc(f.exportValue ?? 'on') + '"' + (f.checked ? ' checked' : '') + disabled + '>';
    else html = '<input type="text"' + attrs + ' value="' + esc(f.value) + '"' + readonly + '>';
    out.push('<div class="il-field"><label for="' + id + '">' + label + '</label> ' + html + '</div>');
  }
  if (page !== null) out.push('</fieldset>');
  return out.join('\n');
}
