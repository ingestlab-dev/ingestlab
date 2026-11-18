// Dense tax/credit lookups repeat headers in adjacent, independent grids.
export function extractLookupTables({ words, segments }) {
  const near = (a, b, d = 1.6) => Math.abs(a - b) <= d;
  const number = /^(?:\d+(?:,\d{3})*\**|\*+)$/;
  const bands = new Map();
  for (const { from, to, pos } of segments?.h || []) {
    if (pos < 0 || to - from < 145 || to - from > 280) continue;
    const key = [Math.round(from), Math.round(to)].join(':');
    if (!bands.has(key)) bands.set(key, { from, to });
  }
  const out = [];
  for (const { from, to } of bands.values()) {
    const region = words.filter((w) => (w.x0 + w.x1) / 2 >= from && (w.x0 + w.x1) / 2 <= to);
    const starts = region.filter((w) => w.str === 'At' && w.x0 - from < 22);
    if (!starts.length) continue;
    const groups = new Map();
    for (const w of region) {
      const y = Math.round(w.y);
      if (!groups.has(y)) groups.set(y, []);
      groups.get(y).push(w);
    }
    const bandsByY = [...groups].sort(([a], [b]) => a - b);
    for (const at of starts) {
      const headers = region.filter((w) => w.y >= at.y - 58 && w.y < at.y + 25);
      if (!headers.some((w) => w.str === 'But' && near(w.y, at.y, 8)) ||
          !headers.some((w) => /^least$/i.test(w.str))) continue;
      const body = bandsByY.filter(([y]) => y >= at.y + 10);
      const numeric = (row) => row.every((w) => number.test(w.str));
      const lead = body.findIndex(([, row]) => [6, 10].includes(row.length) && numeric(row) &&
        row.slice().sort((a, b) => a.x0 - b.x0).slice(0, 2).every((w) => /^\d/.test(w.str)));
      if (lead < 0 || body[lead][0] > at.y + 78) continue;
      const [firstY, first] = body[lead];
      first.sort((a, b) => a.x1 - b.x1);
      const count = first.length;
      const tax = count === 6;
      const header = headers.map((w) => w.str.toLowerCase());
      if (!header.includes('married') || (tax ? !header.includes('single') : !header.includes('credit'))) continue;
      const rows = [];
      const consumed = new Set();
      const signature = first.map((w) => w.x1);
      const parse = (w) => Number(w.str.replace(/[,*]/g, ''));
      let lastY = firstY, lastUpper = null;
      for (const [y, row] of body.slice(lead)) {
        if (y - lastY > 34) break;
        if (row.length === 1 && numeric(row)) {
          consumed.add(row[0]);
          continue;
        }
        if (row.length !== count || !numeric(row)) break;
        row.sort((a, b) => a.x1 - b.x1);
        if (!row.every((w, j) => near(w.x1, signature[j], j >= 2 && /^\*+$/.test(w.str) ? 6 : 1.6)) ||
            !Number.isFinite(parse(row[0])) || !Number.isFinite(parse(row[1])) ||
            !/^\d/.test(row[0].str) || !/^\d/.test(row[1].str) || parse(row[0]) >= parse(row[1]) ||
            (lastUpper !== null && lastUpper !== parse(row[0]))) break;
        lastUpper = parse(row[1]);
        lastY = y;
        rows.push(row.map((w) => w.str));
        for (const w of row) consumed.add(w);
      }
      if (rows.length < (tax ? 4 : 5) || out.some((t) => (near(t.bbox.x0, from, 3) || t.rows[1]?.[0] === rows[0][0]) &&
        near(t.bbox.y0, firstY - 4, 3))) continue;
      const columns = tax ? ['Single', 'Married filing jointly', 'Married filing separately', 'Head of household'] :
        ['Single / head of household / qualifying surviving spouse', 'Married filing jointly'].flatMap((s) =>
          Array.from({ length: 4 }, (_, i) => s + ': ' + i + (i === 3 ? '+' : '') + ' qualifying children'));
      out.push({ type: 'table', kind: 'ruled', lookup: true, consumed,
        bbox: { x0: from, x1: to, y0: firstY - 4, y1: lastY + 2 },
        rows: [['At least', 'But less than', ...columns], ...rows] });
    }
  }
  return out;
}
