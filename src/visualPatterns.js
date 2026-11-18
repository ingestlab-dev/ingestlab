const numeric = /^[+\u2212-]?\d+(?:[.,]\d+)*%?$/;
const marker = /^[\u2610\u2611\u2612\u25cb\u25c9]$/;
const cx = (b) => (b.x0 + b.x1) / 2;
const cy = (b) => (b.y0 + b.y1) / 2;
const width = (b) => b.x1 - b.x0;
const height = (b) => b.y1 - b.y0;
const near = (a, b, gap = 2) => Math.abs(a - b) <= gap;
const inY = (t, lo, hi) => t.y >= lo && t.y <= hi;
const join = (tokens) => [...tokens].sort((a, b) =>
  near(a.y, b.y, 2.5) ? a.x0 - b.x0 : a.y - b.y).map((t) => t.str).join(' ');
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const table = (headers, rows) => [headers, headers.map(() => '---'), ...rows]
  .map((r) => '| ' + r.map(cell).join(' | ') + ' |').join('\n');
const result = (kind2, headers, rows, extra = {}) => ({ kind2, tableMd: table(headers, rows),
  data: { headers, rows, ...extra } });

function printedPie(fills, labels) {
  const sectors = fills.filter((f) => !f.isRect && f.pts.length >= 18 && width(f.bbox) > 20 && height(f.bbox) > 20);
  if (sectors.length < 3 || sectors.length > 10) return null;
  const vertices = (f) => Array.from({ length: f.pts.length / 2 }, (_, i) => f.pts.slice(2 * i, 2 * i + 2));
  if (!vertices(sectors[0]).some(([x, y]) => sectors.slice(1).every((s) =>
    vertices(s).some(([a, b]) => near(a, x, 0.8) && near(b, y, 0.8))))) return null;
  const swatches = sectors.map((s) => fills.filter((f) => f.isRect && f.fillColor === s.fillColor &&
    width(f.bbox) >= 5 && width(f.bbox) <= 22 && height(f.bbox) >= 5 && height(f.bbox) <= 22));
  if (swatches.some((s) => s.length !== 1)) return null;
  const entries = swatches.map(([s]) => {
    const b = s.bbox;
    const line = labels.filter((t) => t.x0 >= b.x1 && t.x0 < b.x1 + 165 && inY(t, b.y0, b.y1 + 3));
    const m = join(line).match(/^(.+?)\s*[\u2013\u2014:-]?\s+(\d+(?:\.\d+)?)\s*%$/);
    return m && [m[1].trim().replace(/\s*[\u2013\u2014:-]$/, ''), Number(m[2])];
  });
  if (entries.some((e) => !e) || !near(entries.reduce((n, e) => n + e[1], 0), 100, 0.5)) return null;
  const mermaid = ['pie showData', ...entries.map(([label, n]) =>
    '  "' + label.replace(/["<>\\]/g, '') + '" : ' + n)].join('\n');
  return { ...result('pie', ['Category', 'Share'], entries.map(([label, n]) => [label, n + '%'])), mermaid };
}

function groupedBars(fills, labels) {
  const rects = fills.filter((f) => f.isRect);
  const bars = rects.filter((f) => width(f.bbox) > 11 && width(f.bbox) < 54 && height(f.bbox) > 16)
    .sort((a, b) => a.bbox.x0 - b.bbox.x0);
  if (bars.length < 4 || bars.length > 24 || bars.some((f) => !near(width(f.bbox), width(bars[0].bbox), 2) ||
    !near(f.bbox.y1, bars[0].bbox.y1, 1.5))) return null;
  const colors = [...new Set(bars.map((f) => f.fillColor))];
  const n = colors.length;
  if (n < 2 || n > 4 || bars.length % n || bars.some((f, i) => f.fillColor !== colors[i % n])) return null;
  const series = colors.map((color) => {
    const keys = rects.filter((f) => f.fillColor === color && width(f.bbox) >= 5 && width(f.bbox) <= 20 &&
      height(f.bbox) >= 5 && height(f.bbox) <= 18 && f.bbox.y1 < Math.min(...bars.map((b) => b.bbox.y0)));
    if (keys.length !== 1) return '';
    const b = keys[0].bbox;
    const end = rects.filter((f) => f.bbox.x0 > b.x1 && near(cy(f.bbox), cy(b), 3) && colors.includes(f.fillColor))
      .reduce((e, f) => Math.min(e, f.bbox.x0), b.x1 + 95);
    return join(labels.filter((t) => t.x0 >= b.x1 && t.x1 <= end && inY(t, b.y0, b.y1 + 3)));
  });
  if (series.some((s) => !s) || new Set(series).size !== n) return null;
  const rows = [];
  for (let i = 0; i < bars.length; i += n) {
    const group = bars.slice(i, i + n);
    if (group.some((f, j) => j && f.bbox.x0 - group[j - 1].bbox.x1 > 9)) return null;
    const base = group[0].bbox.y1;
    const left = group[0].bbox.x0, right = group.at(-1).bbox.x1;
    const category = join(labels.filter((t) => cx(t) >= left && cx(t) <= right && inY(t, base + 3, base + 20)));
    const values = group.map(({ bbox: b }) => labels.filter((t) =>
      near(cx(t), cx(b), width(b) * 0.42) && inY(t, b.y0 - 13, b.y0 + 1) && numeric.test(t.str)));
    if (!category || values.some((v) => v.length !== 1)) return null;
    rows.push([category, ...values.map(([t]) => t.str)]);
  }
  return result('grouped-bar', ['Category', ...series], rows);
}

function funnel(fills, labels) {
  const tiers = fills.filter((f) => !f.isRect && width(f.bbox) >= 48 && height(f.bbox) >= 12 &&
    f.pts.length === 10).sort((a, b) => a.bbox.y0 - b.bbox.y0);
  if (tiers.length < 3 || tiers.length > 8 || tiers.some(({ bbox: b, pts }, i) =>
    new Set([pts[1], pts[3], pts[5], pts[7]].map(Math.round)).size !== 2 ||
    !near(cx(b), cx(tiers[0].bbox), 5) || (i > 0 && (width(b) >= width(tiers[i - 1].bbox) - 8 ||
    !near(b.y0, tiers[i - 1].bbox.y1, 8))))) return null;
  const rows = tiers.map(({ bbox: b }) =>
    join(labels.filter((t) => cx(t) >= b.x0 && cx(t) <= b.x1 && inY(t, b.y0 + 4, b.y1)))
      .match(/^(.+?):\s*([\d,.]+)\s*\(\s*([\d.]+%)\s*\)$/)?.slice(1));
  return rows.every(Boolean) ? result('funnel', ['Stage', 'Count', 'Share of initial stage'], rows) : null;
}

function stackedBars(fills, labels) {
  const rects = fills.filter((f) => f.isRect);
  const stacks = [];
  for (const f of rects.filter(({ bbox: b }) => width(b) >= 22 && width(b) <= 68 && height(b) >= 7)) {
    const same = stacks.find((s) => near(s[0].bbox.x0, f.bbox.x0) && near(width(s[0].bbox), width(f.bbox)));
    if (same) same.push(f);
    else stacks.push([f]);
  }
  const bars = stacks.filter((s) => s.length >= 2).map((s) => s.sort((a, b) => b.bbox.y1 - a.bbox.y1))
    .sort((a, b) => a[0].bbox.x0 - b[0].bbox.x0);
  if (bars.length < 3 || bars.length > 12) return null;
  const base = bars[0][0].bbox.y1, left = bars[0][0].bbox.x0;
  const colors = bars[0].map((f) => f.fillColor);
  if (new Set(colors).size !== colors.length || colors.length > 5 ||
    bars.some((s) => s.length !== colors.length || !near(s[0].bbox.y1, base) ||
      s.some((f, i) => f.fillColor !== colors[i] || (i && !near(f.bbox.y1, s[i - 1].bbox.y0, 1))))) return null;
  const ticks = labels.filter((t) => t.x1 < left - 10 && t.x1 > left - 70 && numeric.test(t.str))
    .sort((a, b) => b.y - a.y).map((t) => ({ y: t.y, n: Number(t.str.replace(/,/g, '')) }));
  if (ticks.length < 3 || ticks.some((t) => !Number.isFinite(t.n)) || ticks[0].n !== 0 ||
      !near(ticks[0].y, base, 6)) return null;
  const scale = ticks.at(-1).n / (ticks[0].y - ticks.at(-1).y);
  if (!(scale > 0) || ticks.some((t) => !near(scale * (ticks[0].y - t.y), t.n, 1.25))) return null;
  const series = colors.map((color) => {
    const keys = rects.filter((f) => f.fillColor === color && width(f.bbox) >= 6 && width(f.bbox) <= 18 &&
      height(f.bbox) <= 18 && f.bbox.y1 < Math.min(...bars.map((s) => s.at(-1).bbox.y0)));
    if (keys.length !== 1) return '';
    const b = keys[0].bbox;
    return join(labels.filter((t) => t.x0 >= b.x1 && t.x1 <= b.x1 + 44 && inY(t, b.y0, b.y1 + 2)));
  });
  if (series.some((s) => !s) || new Set(series).size !== series.length) return null;
  const rows = bars.map((s) => {
    const b = s[0].bbox, top = s.at(-1).bbox.y0;
    const atBar = (t) => cx(t) > b.x0 && cx(t) < b.x1;
    const cat = join(labels.filter((t) => atBar(t) && inY(t, base + 5, base + 20)));
    const total = labels.filter((t) => atBar(t) && numeric.test(t.str) && inY(t, top - 13, top - 1));
    if (!cat || total.length !== 1) return null;
    const values = s.map((f) => Math.round(height(f.bbox) * scale));
    return Math.abs(values.reduce((a, v) => a + v, 0) - Number(total[0].str.replace(/,/g, ''))) <= 1
      ? [cat, ...values.map((v) => '~' + v), total[0].str] : null;
  });
  return rows.every(Boolean) ? result('stacked-bar', ['Category', ...series, 'Printed total'], rows,
    { approximateColumns: series }) : null;
}

function matrix(fills, labels) {
  const cells = fills.filter((f) => f.isRect && width(f.bbox) >= 24 && width(f.bbox) <= 130 &&
    height(f.bbox) >= 14 && height(f.bbox) <= 64).map((f) => f.bbox);
  for (const seed of cells) {
    const matches = cells.filter((b) => near(width(seed), width(b), 1.5) && near(height(seed), height(b), 1.5));
    const xs = [...new Set(matches.map((b) => Math.round(b.x0)))].sort((a, b) => a - b);
    const ys = [...new Set(matches.map((b) => Math.round(b.y0)))].sort((a, b) => a - b);
    if (xs.length < 2 || ys.length < 2 || xs.length > 10 || ys.length > 10 ||
        xs.length * ys.length !== matches.length ||
        xs.some((x, i) => i && !near(x - xs[i - 1], width(seed))) ||
        ys.some((y, i) => i && !near(y - ys[i - 1], height(seed)))) continue;
    const headers = xs.map((x) => join(labels.filter((t) => cx(t) > x && cx(t) < x + width(seed) &&
      inY(t, ys[0] - 27, ys[0] - 1))));
    const rows = ys.map((y) => {
      const label = join(labels.filter((t) => t.x1 <= xs[0] - 1 && t.x1 >= xs[0] - 65 &&
        inY(t, y + 2, y + height(seed) - 1)));
      const vals = xs.map((x) => join(labels.filter((t) => cx(t) > x && cx(t) < x + width(seed) &&
        inY(t, y + 2, y + height(seed) - 1))));
      return [label, ...vals];
    });
    if (headers.some((h) => !h) || new Set(headers).size !== headers.length ||
        rows.some((r) => !r[0] || r.slice(1).some((s) => !/\d/.test(s)))) continue;
    return result('matrix', ['Row', ...headers], rows);
  }
  return null;
}

function gantt(fills, labels, r) {
  const ticks = labels.filter((t) => /^W\d{1,2}$/i.test(t.str)).sort((a, b) => a.x0 - b.x0);
  if (ticks.length < 3 || !ticks.every((t) => near(t.y, ticks[0].y))) return null;
  const step = cx(ticks[1]) - cx(ticks[0]);
  if (step < 15 || ticks.some((t, i) => i && !near(cx(t) - cx(ticks[i - 1]), step, 2))) return null;
  const x0 = cx(ticks[0]) - step / 2, x1 = cx(ticks.at(-1)) + step / 2;
  const entries = fills.filter(({ bbox: b }) => b.x0 >= x0 - 5 && b.x1 <= x1 + 5 &&
    b.y0 > ticks[0].y + 4 && height(b) >= 5 && height(b) <= 22 && width(b) >= step * 0.7)
    .sort((a, b) => a.bbox.y0 - b.bbox.y0).map(({ bbox: b }) => {
      const title = join(labels.filter((t) => t.x1 <= x0 + 5 && inY(t, b.y0, b.y1 + 2)));
      const weeks = ticks.filter((t) => cx(t) > b.x0 && cx(t) < b.x1);
      return title && weeks.length ? [title, weeks[0].str, weeks.at(-1).str] : null;
    });
  if (entries.length < 2 || entries.some((e) => !e)) return null;
  const milestone = labels.filter((t) => /^v\d+(?:\.\d+)+$/i.test(t.str) && t.x0 >= x0 && t.y < r.y1 - 8);
  for (const t of milestone) {
    const tick = ticks.find((w) => near(cx(w), cx(t), step / 2));
    if (tick) entries.push(['Milestone: ' + t.str, tick.str, tick.str]);
  }
  return result('gantt', ['Task', 'Start', 'End (inclusive)'], entries);
}

function states(fills, labels, page, r) {
  const dots = fills.filter((f) => !f.isRect && f.pts.length > 40 &&
    width(f.bbox) >= 7 && width(f.bbox) <= 17 && near(width(f.bbox), height(f.bbox), 1));
  const nodes = fills.filter((f) => !f.isRect && f.pts.length > 40 &&
    width(f.bbox) >= 45 && width(f.bbox) <= 140 && height(f.bbox) >= 18 && height(f.bbox) <= 43)
    .map(({ bbox: b }) => ({ b, text: join(labels.filter((t) => t.x0 > b.x0 && t.x1 < b.x1 &&
      inY(t, b.y0 + 4, b.y1 - 3))) })).sort((a, b) => a.b.x0 - b.b.x0);
  if (nodes.length < 2 || nodes.length > 7 || nodes.some((n) => !n.text || !near(cy(n.b), cy(nodes[0].b), 3))) return null;
  const center = cy(nodes[0].b);
  const start = dots.filter(({ bbox: b }) => b.x1 < nodes[0].b.x0 && near(cy(b), center, 2));
  const end = dots.filter(({ bbox: b }) => b.x0 > nodes.at(-1).b.x1 && near(cy(b), center, 2));
  if (start.length !== 1 || end.length !== 1) return null;
  const arrows = (page.primitives || []).filter((p) => p.type === 'arrow' && p.base &&
    p.tip.x > r.x0 && p.tip.x < r.x1 && p.tip.y > r.y0 && p.tip.y < r.y1);
  const chain = [start[0].bbox, ...nodes.map((n) => n.b), end[0].bbox];
  const edges = [];
  const horizontal = (page.segments?.h || []);
  for (let i = 0; i + 1 < chain.length; i++) {
    const a = chain[i], b = chain[i + 1];
    const arrow = arrows.find(({ tip, base }) => near(tip.x, b.x0, 7) && near(tip.y, center) &&
      near(tip.y, base.y) && tip.x > base.x &&
      horizontal.some((s) => near(s.pos, center) && near(s.from, a.x1, 4) && s.to >= base.x - 2 && s.to <= tip.x + 3));
    if (!arrow) return null;
    const title = join(labels.filter((t) => t.x0 >= a.x1 && t.x1 <= b.x0 && inY(t, center - 16, center - 3)));
    edges.push([i - 1, i, title]);
  }
  const vertical = page.segments?.v || [];
  const hasDashes = (segs, pos, lo, hi) => {
    const distinct = new Set(segs.filter((s) => near(s.pos, pos) && s.from >= lo - 2 &&
      s.to <= hi + 2 && s.to - s.from >= 1.5 && s.to - s.from <= 8).map((s) => Math.round(s.from)));
    return distinct.size >= 3;
  };
  const upward = arrows.filter(({ tip, base }) => near(tip.x, base.x) && tip.y < base.y &&
    nodes.some((n) => near(cx(n.b), tip.x, 3) && near(n.b.y1, tip.y, 3)));
  for (const { tip, base } of upward) {
    const dest = nodes.findIndex((n) => near(cx(n.b), tip.x, 3));
    const options = [];
    for (const [src, n] of nodes.entries()) {
      if (src === dest) continue;
      const x = cx(n.b), left = Math.min(x, tip.x), right = Math.max(x, tip.x);
      const ys = [...new Set(horizontal.filter((s) => s.pos > base.y + 6 && s.pos < base.y + 46 &&
        s.from >= left - 2 && s.to <= right + 2).map((s) => Math.round(s.pos)))];
      for (const y of ys) {
        if (!hasDashes(horizontal, y, left, right) || !hasDashes(vertical, x, n.b.y1, y) ||
            !hasDashes(vertical, tip.x, base.y - 4, y)) continue;
        const title = join(labels.filter((t) => t.x0 >= left + 3 && t.x1 <= right - 3 && inY(t, y + 3, y + 16)));
        if (title && !options.some((e) => e[0] === src && e[2] === title)) options.push([src, dest, title]);
      }
    }
    if (options.length !== 1) return null;
    edges.push(options[0]);
  }
  if (edges.length !== arrows.length) return null;
  const id = (i) => i < 0 || i >= nodes.length ? '[*]' : 'S' + i;
  const clean = (s) => s.replace(/["<>\\;:{}]/g, ' ').trim();
  return { kind2: 'state', mermaid: ['stateDiagram-v2', ...nodes.map(({ text }, i) =>
    '  state "' + clean(text) + '" as ' + id(i)), ...edges.map(([a, b, title]) =>
    '  ' + id(a) + ' --> ' + id(b) + (title ? ' : ' + clean(title) : ''))].join('\n'), data: { edges } };
}

function categoryAxis(labels, r) {
  for (const v of r.rV || []) {
    if (v.to - v.from < 46 || v.pos < r.x0 + 22 || v.pos > r.x0 + 115) continue;
    const base = (r.rH || []).find((h) => near(h.pos, v.to, 2) && near(h.from, v.pos, 2) && h.to - h.from > 115);
    if (!base) continue;
    const ticks = labels.filter((t) => /^-?\d+(?:\.\d+)?%?$/.test(t.str) &&
      t.x1 <= v.pos - 3 && t.x1 >= v.pos - 29 && inY(t, v.from - 2, v.to + 7))
      .map((t) => ({ y: t.y, n: parseFloat(t.str), unit: t.str.endsWith('%') ? '%' : '' }))
      .sort((a, b) => b.y - a.y);
    if (ticks.length < 3 || ticks.some((t, i) => i && (ticks[i - 1].y - t.y < 8 || t.unit !== ticks[0].unit))) continue;
    const bottom = ticks[0], top = ticks.at(-1);
    if (!near(bottom.y, v.to, 7) || !near(top.y, v.from, 7)) continue;
    const scale = (top.n - bottom.n) / (bottom.y - top.y);
    if (!(scale > 0) || ticks.some((t) => !near(bottom.n + (bottom.y - t.y) * scale, t.n, (top.n - bottom.n) * 0.018))) continue;
    const label = (x, radius) => join(labels.filter((t) => near(cx(t), x, radius) && inY(t, v.to + 5, v.to + 21)));
    const value = (y) => '~' + (Math.round((bottom.n + (v.to - y) * scale) * 10) / 10) + bottom.unit;
    return { v, base, label, value };
  }
  return null;
}

function lineSeries(fills, labels, r) {
  const axes = categoryAxis(labels, r);
  if (!axes) return null;
  const { v, base, label, value } = axes;
  const dots = fills.filter(({ bbox: b }) => width(b) >= 3 && width(b) <= 10 &&
    near(width(b), height(b), 1) && b.x0 > v.pos && b.x1 < base.to && b.y0 > v.from && b.y1 < v.to);
  const colors = [...new Set(dots.map((d) => d.fillColor))];
  if (!colors.length || colors.length > 4) return null;
  const series = colors.map((color) => dots.filter((d) => d.fillColor === color).sort((a, b) => cx(a.bbox) - cx(b.bbox)));
  const first = series[0];
  if (first.length < 3 || first.length > 18 || series.some((s) => s.length !== first.length ||
    s.some((p, i) => !near(cx(p.bbox), cx(first[i].bbox), 1.5)))) return null;
  const keys = colors.map((color) => fills.filter(({ bbox: b, fillColor }) => fillColor === color &&
    b.y1 < v.from && width(b) >= 3 && width(b) <= 12 && height(b) >= 3 && near(width(b), height(b), 1.5)));
  if (keys.some((k) => k.length !== 1)) return null;
  const headers = keys.map(([{ bbox: b }]) => {
    const end = Math.min(b.x1 + 78, ...keys.flat().map((k) => k.bbox.x0).filter((x) => x > b.x1));
    return join(labels.filter((t) => t.x0 >= b.x1 && t.x1 <= end && inY(t, b.y0, b.y1 + 3)));
  });
  const names = first.map(({ bbox: b }) => label(cx(b), 28));
  if (headers.some((h) => !h) || new Set(headers).size !== headers.length ||
      names.some((n) => !/\p{L}/u.test(n)) || new Set(names).size !== first.length) return null;
  return result('line-series', ['Category', ...headers], names.map((n, i) =>
    [n, ...series.map((s) => value(cy(s[i].bbox)))]), { approximateColumns: headers });
}

function boxPlot(fills, labels, page, r) {
  const axes = categoryAxis(labels, r);
  if (!axes) return null;
  const { v, base, label, value } = axes;
  const boxes = fills.filter(({ isRect, bbox: b }) => isRect && width(b) >= 22 && width(b) <= 62 &&
    height(b) >= 8 && height(b) <= 72 && b.x0 > v.pos && b.x1 < base.to && b.y0 > v.from && b.y1 < v.to)
    .map((f) => f.bbox).sort((a, b) => a.x0 - b.x0);
  if (boxes.length < 2 || boxes.length > 12 || boxes.some((b, i) => i && b.x0 < boxes[i - 1].x1 + 6)) return null;
  const rows = [];
  for (const b of boxes) {
    const x = cx(b);
    const span = (r.rV || []).filter((s) => near(s.pos, x) && s.from < b.y0 - 3 && s.to > b.y1 + 3);
    if (!span.length) return null;
    const { from, to } = span[0];
    const cap = (y) => (r.rH || []).some((s) => near(s.pos, y) && near((s.from + s.to) / 2, x) &&
      s.to - s.from > 8 && s.to - s.from < width(b) * 0.88);
    const median = (r.rH || []).find((s) => s.pos > b.y0 + 2 && s.pos < b.y1 - 2 && near(s.from, b.x0) && near(s.to, b.x1));
    const name = label(x, width(b) * 0.78);
    if (!cap(from) || !cap(to) || !median || !/\p{L}/u.test(name)) return null;
    const outliers = (page.curves || []).filter(({ arcFit: a, isClosed }) => isClosed && a &&
      a.sweep > 5.4 && a.rx >= 1.5 && a.rx <= 6 && near(a.rx, a.ry, 0.7) && near(a.cx, x, 3) &&
      (a.cy + a.ry < from || a.cy - a.ry > to) && a.cy - a.ry >= v.from && a.cy + a.ry <= v.to);
    rows.push([name, value(to), value(b.y1), value(median.pos), value(b.y0), value(from),
      [...new Set(outliers.map(({ arcFit: a }) => value(a.cy)))].join(', ') || '-']);
  }
  const headers = ['Category', 'Lower whisker', 'Q1', 'Median', 'Q3', 'Upper whisker', 'Outliers'];
  return result('box-plot', headers, rows, { approximateColumns: headers.slice(1) });
}

function treemap(fills, labels) {
  const tiles = fills.filter(({ isRect, bbox: b }) => isRect && width(b) >= 34 && height(b) >= 20);
  if (tiles.length < 4 || tiles.length > 16 || new Set(tiles.map((f) => f.fillColor)).size < 3) return null;
  const boxes = tiles.map((f) => f.bbox);
  const bounds = { x0: Math.min(...boxes.map((b) => b.x0)), x1: Math.max(...boxes.map((b) => b.x1)),
    y0: Math.min(...boxes.map((b) => b.y0)), y1: Math.max(...boxes.map((b) => b.y1)) };
  if (boxes.some((b, i) => boxes.slice(i + 1).some((a) =>
    Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 1 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 1)) ||
    !near(boxes.reduce((a, b) => a + width(b) * height(b), 0), width(bounds) * height(bounds), width(bounds) * height(bounds) * 0.025)) return null;
  const rows = boxes.map((b) => {
    const text = join(labels.filter((t) => t.x0 >= b.x0 && t.x1 <= b.x1 && inY(t, b.y0 + 3, b.y1 - 2)));
    return text.match(/^(.+?)\s+(\d+(?:\.\d+)?)%\s*(?:\(([^)]+)\))?$/)?.slice(1);
  });
  if (rows.some((r) => !r || !/\p{L}/u.test(r[0])) || !near(rows.reduce((a, r) => a + Number(r[1]), 0), 100, 0.5)) return null;
  return result('treemap', ['Category', 'Printed share', 'Printed amount'],
    rows.map(([label, share, amount]) => [label.replace(/\s*[\u2013\u2014:-]$/, ''), share + '%', amount || '-']));
}

function currencyBridge(fills, labels) {
  const bars = fills.filter(({ isRect, bbox: b }) => isRect && width(b) >= 12 && width(b) <= 64 && height(b) >= 6)
    .map((f) => f.bbox).sort((a, b) => a.x0 - b.x0);
  if (bars.length < 4 || bars.length > 14) return null;
  const base = bars[0].y1;
  if (!near(base, bars.at(-1).y1, 1) || bars.slice(1, -1).some((b) => b.y1 > base - 3) ||
    bars.some((b, i) => i && (b.x0 < bars[i - 1].x1 + 4 || !near(width(b), width(bars[0]), 2)))) return null;
  const rows = bars.map((b, i) => {
    const words = labels.filter((t) => near(cx(t), cx(b), width(b) * 0.72));
    const name = join(words.filter((t) => inY(t, base + 5, base + 23)));
    const mid = i > 0 && i < bars.length - 1;
    const values = words.filter((t) => /^([+\u2212-]?)\$(\d+(?:,\d{3})*(?:\.\d+)?)([KMB]?)$/.test(t.str) &&
      (inY(t, b.y0 - 13, b.y0 + 1) || (mid && inY(t, b.y1 + 2, b.y1 + 15))));
    if (!/\p{L}/u.test(name) || values.length !== 1 || mid !== /^[+\u2212-]/.test(values[0].str)) return null;
    return [name, values[0].str];
  });
  if (rows.some((r) => !r)) return null;
  const units = rows.map(([, s]) => s.match(/[KMB]$/)?.[0] || '');
  if (new Set(units).size !== 1) return null;
  const values = rows.map(([, s]) => Number(s.replace('\u2212', '-').replace(/[$,KMB]/g, '')));
  if (!near(values.slice(0, -1).reduce((a, b) => a + b, 0), values.at(-1), 0.02)) return null;
  return result('waterfall', ['Step', 'Printed amount'], rows);
}

function responsibilityMatrix(fills, labels) {
  const cells = fills.filter(({ isRect, bbox: b }) => isRect && width(b) >= 22 && height(b) >= 11 && height(b) <= 34)
    .map((f) => f.bbox);
  const bands = [];
  for (const b of cells.sort((a, b) => a.y0 - b.y0)) {
    const last = bands.at(-1);
    if (last && near(b.y0, last[0].y0, 1)) last.push(b);
    else bands.push([b]);
  }
  const area = bands.filter((lines) => lines.length >= 4 && lines.length <= 9)
    .map((lines) => lines.sort((a, b) => a.x0 - b.x0));
  if (area.length < 3 || area.length > 12) return null;
  const [head, ...rows] = area;
  if (area.some((row, i) => row.length !== head.length ||
      (i > 0 && !near(row[0].y0, area[i - 1][0].y1, 1)) || row.some((b, j) =>
        !near(b.x0, head[j].x0, 1) || !near(b.x1, head[j].x1, 1) || (j > 0 && !near(b.x0, row[j - 1].x1, 1))))) return null;
  const text = (row) => row.map((b) => join(labels.filter((w) =>
    cx(w) > b.x0 && cx(w) < b.x1 && inY(w, b.y0 + 3, b.y1 - 1))));
  const header = text(head), body = rows.map(text);
  if (header.some((s) => !/\p{L}/u.test(s)) || new Set(header).size !== header.length ||
      body.some(([label, ...codes]) => !/\p{L}/u.test(label) || codes.some((c) => !/^[RACI]$/.test(c))) ||
      new Set(body.flatMap((r) => r.slice(1))).size < 3) return null;
  return result('responsibility-matrix', header, body);
}

function scatter(fills, labels, r) {
  const parseTick = (w) => /^-?\d+(?:\.\d+)?$/.test(w.str);
  for (const v of r.rV || []) {
    if (v.to - v.from < 55 || v.pos < r.x0 + 20) continue;
    const axis = (r.rH || []).find((h) => near(h.pos, v.to) && near(h.from, v.pos) && h.to - h.from > 115);
    if (!axis) continue;
    const x = labels.filter((w) => parseTick(w) && cx(w) >= axis.from - 5 && cx(w) <= axis.to + 5 &&
      inY(w, axis.pos + 5, axis.pos + 21)).map((w) => [cx(w), Number(w.str)]).sort((a, b) => a[0] - b[0]);
    const y = labels.filter((w) => parseTick(w) && w.x1 < v.pos - 3 && w.x1 >= v.pos - 26 &&
      inY(w, v.from - 1, v.to + 7)).map((w) => [w.y, Number(w.str)]).sort((a, b) => a[0] - b[0]);
    const fit = (ticks) => {
      if (ticks.length < 3 || ticks.some((t, i) => i && t[0] - ticks[i - 1][0] < 8)) return null;
      const [lo, n] = ticks[0], [hi, end] = ticks.at(-1);
      const scale = (end - n) / (hi - lo);
      if (!scale || ticks.some(([p, value]) => !near(value, n + (p - lo) * scale, Math.abs(end - n) * 0.02))) return null;
      return { scale, n, lo };
    };
    const ax = fit(x), ay = fit(y);
    if (!ax || !ay || ax.scale <= 0 || ay.scale >= 0 ||
      !near(x[0][0], axis.from, 6) || !near(x.at(-1)[0], axis.to, 6) ||
      !near(y.at(-1)[0], axis.pos, 7) || !near(y[0][0], v.from, 7)) continue;
    const dots = fills.filter(({ bbox: b, isRect, pts }) => !isRect && pts.length >= 30 &&
      width(b) >= 3 && width(b) <= 11 && near(width(b), height(b), 0.9) &&
      b.x0 > axis.from && b.x1 < axis.to && b.y0 > v.from && b.y1 < v.to);
    if (dots.length < 4 || dots.length > 85 ||
        dots.some((d) => d.fillColor !== dots[0].fillColor || !near(width(d.bbox), width(dots[0].bbox), 1))) continue;
    // Baseline of the printed y-axis ticks is slightly below each gridline.
    const round = (n) => '~' + String(Math.round(n * 10) / 10);
    const rows = dots.map(({ bbox: b }) => [ax.n + (cx(b) - ax.lo) * ax.scale,
      ay.n + (cy(b) - (axis.pos + (ay.lo - y.at(-1)[0]))) * ay.scale])
      .sort((a, b) => a[0] - b[0]).map((point) => point.map(round));
    return result('scatter', ['X (estimated)', 'Y (estimated)'], rows, { approximateColumns: ['X', 'Y'] });
  }
  return null;
}

export function reconstructVisualPattern(page, r) {
  const fills = (page.fills || []).filter(({ bbox: b }) => b.x0 >= r.x0 + 3 && b.x1 <= r.x1 - 3 &&
    b.y0 >= r.y0 + 3 && b.y1 <= r.y1 - 5);
  const labels = (r.labels || []).filter((t) => !marker.test(t.str));
  if (fills.length < 3 || fills.length > 240 || labels.length < 3) return null;
  return printedPie(fills, labels) || groupedBars(fills, labels) || stackedBars(fills, labels) || funnel(fills, labels) ||
    matrix(fills, labels) || gantt(fills, labels, r) || states(fills, labels, page, r) ||
    treemap(fills, labels) || currencyBridge(fills, labels) || responsibilityMatrix(fills, labels) ||
    boxPlot(fills, labels, page, r) || lineSeries(fills, labels, r) || scatter(fills, labels, r);
}
