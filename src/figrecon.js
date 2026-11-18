import { figureCaption } from './figures.js';
import { reconstructVisualPattern } from './visualPatterns.js';
export { extractDualInlinePinouts } from './pinout.js';
export { extractCircuitPanels } from './circuits.js';

const escSvg = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function svgWrap(r, inner, opts = {}) {
  const w = Math.max(1, Math.round(r.x1 - r.x0));
  const h = Math.max(1, Math.round(r.y1 - r.y0));
  const bg = opts.bg === false ? '' : `<rect x="${r.x0}" y="${r.y0}" width="${w}" height="${h}" fill="#ffffff"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r.x0} ${r.y0} ${w} ${h}" width="${w}" height="${h}" ` +
    `font-family="ui-sans-serif, system-ui, sans-serif" font-size="9" role="img">` +
    bg +
    inner +
    `</svg>`
  );
}

const textAt = (x, y, s, size = 9, fill = '#111', anchor = 'middle') =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" fill="${fill}" text-anchor="${anchor}">${escSvg(s)}</text>`;

const lineAt = (x1, y1, x2, y2, stroke = '#111', width = 1, dash = null) =>
  `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;

const inBox = (r, x, y, pad = 0) => x >= r.x0 - pad && x <= r.x1 + pad && y >= r.y0 - pad && y <= r.y1 + pad;

const compRefRe = /^[RCQULDYDZT][0-9]{1,3}$/;
const compValRe = /^[\d.]+(p|n|u|µ|kKmM)?(F|A|V|Hz|Ω|kΩ|K)$/i;

function regionEvidence(page, r) {
  const curves = (page.curves || []).filter((c) => {
    const cx = c.arcFit ? c.arcFit.cx : midOf(c.pts, 'x');
    const cy = c.arcFit ? c.arcFit.cy : midOf(c.pts, 'y');
    return inBox(r, cx, cy, 6);
  });
  const fills = (page.fills || []).filter((f) => {
    const cx = (f.bbox.x0 + f.bbox.x1) / 2;
    const cy = (f.bbox.y0 + f.bbox.y1) / 2;
    return inBox(r, cx, cy, 6);
  });
  const prims = (page.primitives || []).filter((p) => {
    if (p.type === 'junction') return inBox(r, p.x, p.y, 6);
    if (p.type === 'arrow') {
      // arrows anchor on their tip (the triangle apex)
      return p.tip ? inBox(r, p.tip.x, p.tip.y, 6) : false;
    }
    if (!p.bbox) return false;
    const x = (p.bbox.x0 + p.bbox.x1) / 2;
    const y = p.bbox.y1;
    return inBox(r, x, y, 6);
  });
  return { curves, fills, prims };
}

function midOf(pts, axis) {
  let s = 0;
  let n = 0;
  for (let i = axis === 'x' ? 0 : 1; i + 1 < pts.length; i += 2) {
    s += pts[i];
    n++;
  }
  return n ? s / n : 0;
}

const TICK_RE = /^[\d.,%+\-−µμ°]{1,8}$/;

export function classifyFigure(page, r) {
  const { curves, fills, prims } = regionEvidence(page, r);
  const rw = r.x1 - r.x0;
  const rh = r.y1 - r.y0;
  const labels = r.labels || [];
  const arcs = curves.filter((c) => c.arcFit);
  const junctions = prims.filter((p) => p.type === 'junction');
  const arrows = prims.filter((p) => p.type === 'arrow');

  let gaugeScore = 0;
  for (let i = 0; i < arcs.length; i++) {
    for (let j = i + 1; j < arcs.length; j++) {
      const a = arcs[i].arcFit;
      const b = arcs[j].arcFit;
      const rd = Math.abs(a.r - b.r) / Math.max(a.r, b.r);
      if (Math.hypot(a.cx - b.cx, a.cy - b.cy) < 8 && rd > 0.12) gaugeScore += 2;
    }
  }
  if (arcs.length >= 3) gaugeScore += 1;

  const refs = labels.filter((l) => compRefRe.test(l.str.trim()));
  const vals = labels.filter((l) => compValRe.test(l.str.trim()));
  let circuitScore = junctions.length * 2 + refs.length * 1.5 + vals.length;

  const stepped = curves.filter((c) => {
    const p = c.pts;
    if (p.length < 20) return false;
    const ys = new Set();
    let hRuns = 0;
    let vRuns = 0;
    for (let i = 2; i + 1 < p.length; i += 2) {
      const dx = Math.abs(p[i] - p[i - 2]);
      const dy = Math.abs(p[i + 1] - p[i - 1]);
      if (dy <= 1 && dx > 2) {
        hRuns++;
        ys.add(Math.round(p[i + 1] / 2) * 2);
      } else if (dx <= 1 && dy > 2) vRuns++;
    }
    return hRuns >= 3 && vRuns >= 2 && ys.size <= 3 && ys.size >= 2;
  });
  let timingScore = stepped.length >= 2 ? stepped.length * 2 : 0;

  const bigRect = fills.filter((f) => f.isRect && (f.bbox.x1 - f.bbox.x0) * (f.bbox.y1 - f.bbox.y0) > 0.12 * rw * rh);
  const numbered = labels.filter((l) => /^\d{1,3}$/.test(l.str.trim()) && +l.str <= 128);
  let pinoutScore = bigRect.length && numbered.length >= 6 ? numbered.length : 0;

  const thickRibbons = curves.filter((c) => {
    let y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity;
    for (let i = 0; i + 1 < c.pts.length; i += 2) {
      x0 = Math.min(x0, c.pts[i]); x1 = Math.max(x1, c.pts[i]);
      y0 = Math.min(y0, c.pts[i + 1]); y1 = Math.max(y1, c.pts[i + 1]);
    }
    return x1 - x0 > 0.3 * rw && y1 - y0 > 12 && y1 - y0 < 0.6 * rh && !c.arcFit;
  });
  let sankeyScore = thickRibbons.length >= 3 ? thickRibbons.length : 0;

  const bars = fills.filter((f) => f.isRect && f.bbox.x1 - f.bbox.x0 >= 24 && f.bbox.y1 - f.bbox.y0 >= 4 && f.bbox.y1 - f.bbox.y0 <= 18);
  const barYs = bars.map((b) => (b.bbox.y0 + b.bbox.y1) / 2).sort((a, b) => a - b);
  const ganttTicks = (labels || []).filter((l) => /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|q[1-4])\b/i.test(l.str.trim()));
  let ganttScore = 0;
  if (barYs.length >= 4 && ganttTicks.length >= 3) {
    const pitches = [];
    for (let i = 1; i < barYs.length; i++) pitches.push(barYs[i] - barYs[i - 1]);
    const med = pitches.sort((a, b) => a - b)[Math.floor(pitches.length / 2)];
    if (pitches.filter((p) => Math.abs(p - med) <= 3).length >= barYs.length - 2 && med > 6) ganttScore = bars.length;
  }

  const lifelines = r.rV.filter((s) => s.to - s.from > 0.55 * rh);
  const messages = r.rH.filter((s) => s.to - s.from > 0.12 * rw && s.to - s.from < 0.9 * rw);
  const seqScore =
    lifelines.length >= 3 && messages.length >= 2 && junctions.length === 0 && refs.length === 0
      ? lifelines.length + messages.length
      : 0;

  const rectBoxes = fills.filter((f) => f.isRect && f.bbox.x1 - f.bbox.x0 >= 30 && f.bbox.x1 - f.bbox.x0 <= 0.6 * rw && f.bbox.y1 - f.bbox.y0 >= 12 && f.bbox.y1 - f.bbox.y0 <= 0.5 * rh);
  const flowScore = rectBoxes.length >= 3 && arrows.length >= 1 ? rectBoxes.length + arrows.length : 0;

  const vertexLabels = labels.filter((l) => /^[A-Z]$|^[θ∠]$/.test(l.str.trim()));
  const geoScore = vertexLabels.length >= 2 && labels.length <= 14 && r.rH.length + r.rV.length <= 14 ? vertexLabels.length : 0;

  const numeric = labels.filter((l) => TICK_RE.test(l.str.trim())).length;
  const longV = r.rV.some((s) => s.to - s.from > 0.5 * rh);
  const longH = r.rH.some((s) => s.to - s.from > 0.5 * rw);
  let chartScore = longV && longH && numeric >= 5 ? numeric : 0;

  const best = [
    ['gauge', gaugeScore * 2],
    ['circuit', circuitScore],
    ['timing', timingScore],
    ['pinout', pinoutScore],
    ['sankey', sankeyScore],
    ['gantt', ganttScore],
    ['uml', seqScore],
    ['flowchart', flowScore],
    ['geometry', geoScore],
    ['chart', chartScore],
  ].sort((a, b) => b[1] - a[1])[0];
  if (best[1] >= 3) return best[0];
  if (r.kind === 'photo') return 'photo';
  if (r.kind === 'chart') return 'chart';
  if (r.kind === 'diagram') return 'diagram';
  return 'schematic';
}

const mdTable = (header, rows) =>
  ['| ' + header.join(' | ') + ' |', '| ' + header.map(() => '---').join(' | ') + ' |', ...rows.map((r) => '| ' + r.join(' | ') + ' |')].join('\n');

const cellOf = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

// Circuit schematics

function reconstructCircuit(page, r) {
  const { fills, prims } = regionEvidence(page, r);
  const wires = [...r.rH.map((s) => [s.from, s.pos, s.to, s.pos]), ...r.rV.map((s) => [s.pos, s.from, s.pos, s.to])];
  const junctions = prims.filter((p) => p.type === 'junction');
  const comps = (r.labels || []).filter((l) => compRefRe.test(l.str.trim()));
  const values = (r.labels || []).filter((l) => compValRe.test(l.str.trim()));
  const netlist = comps.map((c) => {
    let val = '';
    let best = 34;
    for (const v of values) {
      const d = Math.hypot((v.x0 + v.x1) / 2 - (c.x0 + c.x1) / 2, v.y - c.y);
      if (d < best) {
        best = d;
        val = v.str.trim();
      }
    }
    return { ref: c.str.trim(), value: val, x: (c.x0 + c.x1) / 2, y: c.y };
  });
  const symbols = fills.filter((f) => !f.isDot && (f.bbox.x1 - f.bbox.x0) < 80 && (f.bbox.y1 - f.bbox.y0) < 40);
  const inner = [];
  for (const [x1, y1, x2, y2] of wires) inner.push(lineAt(x1, y1, x2, y2, '#333', 1));
  for (const j of junctions) inner.push(`<circle cx="${j.x.toFixed(1)}" cy="${j.y.toFixed(1)}" r="2" fill="#333"/>`);
  for (const s of symbols) {
    const { x0, y0, x1, y1 } = s.bbox;
    if (s.isRect) inner.push(`<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${(y1 - y0).toFixed(1)}" fill="none" stroke="#333" stroke-width="1"/>`);
    else inner.push(`<circle cx="${((x0 + x1) / 2).toFixed(1)}" cy="${((y0 + y1) / 2).toFixed(1)}" r="${(Math.max(x1 - x0, y1 - y0) / 2).toFixed(1)}" fill="none" stroke="#333" stroke-width="1"/>`);
  }
  for (const c of netlist) inner.push(textAt(c.x, c.y - 2, c.value ? `${c.ref} ${c.value}` : c.ref, 8.5, '#111'));
  const tableMd = netlist.length
    ? mdTable(['Ref', 'Value'], netlist.map((c) => [cellOf(c.ref), cellOf(c.value || '—')]))
    : null;
  // Only connect components when the wire touches both.
  const edges = [];
  for (const [x1, y1, x2, y2] of wires) {
    const a = netlist.findIndex((c) => Math.hypot(c.x - x1, c.y - y1) < 14);
    const b = netlist.findIndex((c) => Math.hypot(c.x - x2, c.y - y2) < 14);
    if (a >= 0 && b >= 0 && a !== b && !edges.some(([p, q]) => (p === a && q === b) || (p === b && q === a))) edges.push([a, b]);
    if (edges.length >= 10) break;
  }
  let mermaid = null;
  if (netlist.length >= 2 && edges.length) {
    const lines = ['flowchart LR'];
    netlist.forEach((c, i) => lines.push(`  C${i}["${(c.ref + (c.value ? ' ' + c.value : '')).replace(/["|<>{}[\]]/g, '')}"]`));
    for (const [a, b] of edges) lines.push(`  C${a} --- C${b}`);
    mermaid = lines.join('\n') + '\n';
  }
  return { svg: svgWrap(r, inner.join('')), tableMd, mermaid, data: { components: netlist.map((c) => ({ ref: c.ref, value: c.value })) } };
}

// Digital timing / logic

function reconstructTiming(page, r) {
  const { curves } = regionEvidence(page, r);
  const traces = curves.filter((c) => c.pts.length >= 20);
  const inner = [];
  const rows = [];
  traces.slice(0, 6).forEach((c, i) => {
    let d = `M ${c.pts[0].toFixed(1)} ${c.pts[1].toFixed(1)}`;
    let highs = 0;
    let lows = 0;
    for (let k = 2; k + 1 < c.pts.length; k += 2) {
      d += ` L ${c.pts[k].toFixed(1)} ${c.pts[k + 1].toFixed(1)}`;
      if (c.pts[k + 1] < (r.y0 + r.y1) / 2) highs++;
      else lows++;
    }
    inner.push(`<path d="${d}" fill="none" stroke="#2563eb" stroke-width="1.4"/>`);
    const name = (r.labels || []).filter((l) => l.y < r.y0 + 20 && Math.abs((l.x0 + l.x1) / 2 - c.pts[0]) < 40).map((l) => l.str.trim())[0];
    rows.push({ name: name || `Signal ${i + 1}`, highs, lows, edges: highs + lows });
  });
  for (const row of rows) {
    if (row.name && row.name !== `Signal ${rows.indexOf(row) + 1}`) {
      const c = traces[rows.indexOf(row)];
      inner.push(textAt(Math.max(r.x0 + 12, c.pts[0] - 8), c.pts[1] + 3, row.name, 8.5, '#111', 'end'));
    }
  }
  const tableMd = rows.length
    ? mdTable(['Signal', 'High samples', 'Low samples', 'Transitions'], rows.map((row) => [cellOf(row.name), row.highs, row.lows, row.edges]))
    : null;
  return { svg: svgWrap(r, inner.join('')), tableMd, mermaid: null, data: { signals: rows } };
}

// IC pinout / mechanical

function reconstructPinout(page, r) {
  const { fills } = regionEvidence(page, r);
  const labels = (r.labels || []).slice();
  const pkg =
    fills.find((f) => f.isRect && (f.bbox.x1 - f.bbox.x0) * (f.bbox.y1 - f.bbox.y0) > 0.12 * (r.x1 - r.x0) * (r.y1 - r.y0)) ||
    null;
  const box = pkg
    ? pkg.bbox
    : { x0: r.x0 + 0.3 * (r.x1 - r.x0), y0: r.y0 + 0.25 * (r.y1 - r.y0), x1: r.x1 - 0.3 * (r.x1 - r.x0), y1: r.y1 - 0.25 * (r.y1 - r.y0) };
  const left = [];
  const right = [];
  for (const l of labels) {
    const t = l.str.trim();
    if (!/^\d{1,3}$/.test(t)) continue;
    const cx = (l.x0 + l.x1) / 2;
    if (cx < box.x0 && cx > box.x0 - 46) left.push({ n: +t, y: l.y });
    else if (cx > box.x1 && cx < box.x1 + 46) right.push({ n: +t, y: l.y });
  }
  left.sort((a, b) => a.y - b.y);
  right.sort((a, b) => a.y - b.y);
  const nameOf = (pin, sideSign) => {
    let best = '';
    let bd = 26;
    for (const l of labels) {
      const t = l.str.trim();
      if (!/^[A-Za-z][A-Za-z0-9_+\-/]{1,10}$/.test(t) || /^\d+$/.test(t)) continue;
      const cx = (l.x0 + l.x1) / 2;
      const d = Math.hypot(cx - (sideSign < 0 ? box.x0 : box.x1), l.y - pin.y);
      if (d < bd && (sideSign < 0 ? cx < box.x0 : cx > box.x1)) {
        bd = d;
        best = t;
      }
    }
    return best;
  };
  const inner = [
    `<rect x="${box.x0.toFixed(1)}" y="${box.y0.toFixed(1)}" width="${(box.x1 - box.x0).toFixed(1)}" height="${(box.y1 - box.y0).toFixed(1)}" fill="#f1f5f9" stroke="#334155" stroke-width="1.2"/>`,
  ];
  const rows = [];
  const maxRows = Math.max(left.length, right.length);
  for (let i = 0; i < maxRows; i++) {
    const L = left[i];
    const R = right[i];
    if (L) {
      inner.push(lineAt(box.x0 - 10, L.y, box.x0, L.y, '#334155', 1));
      inner.push(textAt(box.x0 - 12, L.y + 3, L.n, 8, '#111', 'end'));
      inner.push(textAt(box.x0 + 5, L.y + 3, nameOf(L, -1) || ' ', 8, '#111', 'start'));
    }
    if (R) {
      inner.push(lineAt(box.x1, R.y, box.x1 + 10, R.y, '#334155', 1));
      inner.push(textAt(box.x1 + 12, R.y + 3, R.n, 8, '#111', 'start'));
      inner.push(textAt(box.x1 - 5, R.y + 3, nameOf(R, 1) || ' ', 8, '#111', 'end'));
    }
    rows.push([L ? L.n : '', L ? cellOf(nameOf(L, -1) || '—') : '', R ? R.n : '', R ? cellOf(nameOf(R, 1) || '—') : '']);
  }
  const tableMd = rows.length
    ? mdTable(['Pin (L)', 'Name (L)', 'Pin (R)', 'Name (R)'], rows)
    : null;
  return { svg: svgWrap(r, inner.join('')), tableMd, mermaid: null, data: { pins: rows } };
}

// Radial gauges / donut / KPI cards

function reconstructGauge(page, r) {
  const { curves } = regionEvidence(page, r);
  const arcs = curves.filter((c) => c.arcFit).sort((a, b) => b.arcFit.r - a.arcFit.r);
  if (!arcs.length) return null;
  const inner = [];
  const rows = [];
  const labels = r.labels || [];
  const primary = arcs[0].arcFit;
  let kpi = '';
  let kpiSize = 0;
  for (const l of labels) {
    const cx = (l.x0 + l.x1) / 2;
    if (Math.hypot(cx - primary.cx, l.y - primary.cy) < primary.r * 0.8 && l.size > kpiSize) {
      kpiSize = l.size;
      kpi = l.str.trim();
    }
  }
  arcs.slice(0, 8).forEach((c, i) => {
    const a = c.arcFit;
    const sweep = Math.min(a.sweep, Math.PI * 2);
    const a0 = a.startAngle;
    const a1 = a0 + sweep * (a.direction >= 0 ? 1 : -1);
    const large = sweep > Math.PI ? 1 : 0;
    const d =
      `M ${(a.cx + a.rx * Math.cos(a0)).toFixed(1)} ${(a.cy + a.ry * Math.sin(a0)).toFixed(1)} ` +
      `A ${a.rx.toFixed(1)} ${a.ry.toFixed(1)} 0 ${large} ${a.direction >= 0 ? 1 : 0} ${(a.cx + a.rx * Math.cos(a1)).toFixed(1)} ${(a.cy + a.ry * Math.sin(a1)).toFixed(1)}`;
    inner.push(`<path d="${d}" fill="${c.fillColor || 'none'}" stroke="${c.strokeColor || '#2563eb'}" stroke-width="${Math.max(2, c.lineWidth || 3).toFixed(1)}"/>`);
    const ex = a.cx + a.rx * Math.cos(a1);
    const ey = a.cy + a.ry * Math.sin(a1);
    let badge = '';
    let bd = 20;
    for (const l of labels) {
      const t = l.str.trim();
      if (!TICK_RE.test(t)) continue;
      const d2 = Math.hypot((l.x0 + l.x1) / 2 - ex, l.y - ey);
      if (d2 < bd) {
        bd = d2;
        badge = t;
      }
    }
    const pct = Math.round((sweep / (Math.PI * 2)) * 100);
    rows.push({ series: `Arc ${i + 1}`, badge, pct, radius: Math.round(a.rx) });
    inner.push(textAt(ex + (a.direction >= 0 ? 10 : -10), ey + 3, badge || `${pct}%`, 8.5, '#111', a.direction >= 0 ? 'start' : 'end'));
  });
  if (kpi) inner.push(textAt(primary.cx, primary.cy + kpiSize * 0.35, kpi, Math.min(20, kpiSize + 2), '#0f172a'));
  const tableMd = mdTable(['Series', 'Endpoint', 'Share %', 'Radius (pt)'], rows.map((row) => [cellOf(row.series), cellOf(row.badge || '—'), row.pct, row.radius]));
  return { svg: svgWrap(r, inner.join('')), tableMd, mermaid: null, data: { center: kpi, arcs: rows } };
}

// Xy statistical charts

function reconstructChart(page, r) {
  const { fills, curves } = regionEvidence(page, r);
  const rw = r.x1 - r.x0;
  const rh = r.y1 - r.y0;
  const labels = r.labels || [];
  const longV = r.rV.filter((s) => s.to - s.from > 0.45 * rh).sort((a, b) => a.pos - b.pos)[0];
  const longH = r.rH.filter((s) => s.to - s.from > 0.45 * rw).sort((a, b) => b.pos - a.pos)[0];
  const inner = [];
  let tableMd = null;
  let mermaid = null;
  const data = {};

  if (longV && longH) {
    inner.push(lineAt(longV.pos, r.y0 + 2, longV.pos, longH.pos, '#334155', 1.2));
    inner.push(lineAt(longV.pos, longH.pos, r.x1 - 4, longH.pos, '#334155', 1.2));
    const ticks = labels
      .filter((l) => TICK_RE.test(l.str.trim()) && (l.x0 + l.x1) / 2 < longV.pos)
      .map((l) => ({ v: parseFloat(l.str.replace(/[,%]/g, '')), y: l.y }))
      .filter((t) => Number.isFinite(t.v))
      .sort((a, b) => a.y - b.y);
    const unitPerPt = ticks.length >= 2 ? (ticks[ticks.length - 1].v - ticks[0].v) / (ticks[0].y - ticks[ticks.length - 1].y || -1) : null;
    const v0 = ticks.length ? ticks[ticks.length - 1].v : 0;
    const baseline = longH.pos;
    const bars = fills
      .filter((f) => f.isRect && f.bbox.y1 <= baseline + 8 && f.bbox.y1 >= baseline - 12 && f.bbox.x1 - f.bbox.x0 >= 4 && f.bbox.x1 - f.bbox.x0 <= 0.2 * rw && baseline - f.bbox.y0 > 3)
      .sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const rows = [];
    bars.forEach((b, i) => {
      const { x0, y0, x1, y1 } = b.bbox;
      inner.push(`<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${Math.max(1, baseline - y0).toFixed(1)}" fill="${b.fillColor || '#60a5fa'}" stroke="none"/>`);
      const cat = labels
        .filter((l) => l.y > baseline - 2 && l.y < baseline + 22 && overlap1d(l.x0, l.x1, x0, x1) > 0.4)
        .map((l) => l.str.trim())
        .join(' ');
      let val = '';
      const printed = labels.filter((l) => TICK_RE.test(l.str.trim()) &&
        (l.x0 + l.x1) / 2 >= x0 && (l.x0 + l.x1) / 2 <= x1 && l.y <= y0 + 1 && l.y >= y0 - 14);
      if (printed.length === 1) val = printed[0].str.trim();
      else if (unitPerPt !== null && Number.isFinite(unitPerPt)) {
        const v = v0 + (baseline - y0) * unitPerPt;
        val = String(Math.round(v * 100) / 100);
      }
      rows.push([cellOf(cat || `Item ${i + 1}`), cellOf(val || `${Math.round(baseline - y0)} pt`)]);
    });
    for (const t of ticks.slice(0, 10)) {
      inner.push(lineAt(longV.pos - 4, t.y, longV.pos, t.y, '#334155', 1));
      inner.push(textAt(longV.pos - 6, t.y + 3, String(t.v), 8, '#111', 'end'));
    }
    for (const c of curves.slice(0, 4)) {
      if (c.pts.length < 8) continue;
      let d = `M ${c.pts[0].toFixed(1)} ${c.pts[1].toFixed(1)}`;
      for (let k = 2; k + 1 < c.pts.length; k += 2) d += ` L ${c.pts[k].toFixed(1)} ${c.pts[k + 1].toFixed(1)}`;
      inner.push(`<path d="${d}" fill="none" stroke="${c.strokeColor || '#dc2626'}" stroke-width="1.4"/>`);
    }
    if (rows.length >= 2) tableMd = mdTable(['Category', 'Value'], rows);
    data.bars = rows.length;
    data.ticks = ticks.length;
  } else {
    for (const c of curves.slice(0, 40)) {
      let d = `M ${c.pts[0].toFixed(1)} ${c.pts[1].toFixed(1)}`;
      for (let k = 2; k + 1 < c.pts.length; k += 2) d += ` L ${c.pts[k].toFixed(1)} ${c.pts[k + 1].toFixed(1)}`;
      inner.push(`<path d="${d}" fill="none" stroke="${c.strokeColor || '#334155'}" stroke-width="1"/>`);
    }
  }
  return { svg: svgWrap(r, inner.join('')), tableMd, mermaid, data };
}

const safeMermaid = (s) => String(s).replace(/["|<>{}\[\]\\;\r\n]/g, ' ').trim();

function reconstructPanel(page, r) {
  const { fills, prims } = regionEvidence(page, r);
  const arrows = prims.filter((p) => p.type === 'arrow').sort((a, b) => a.tip.y - b.tip.y);
  const labels = r.labels || [];
  const nodes = fills.flatMap((f) => {
    const b = f.bbox;
    if (!inBox(r, b.x0, b.y0) || !inBox(r, b.x1, b.y1) ||
        b.x1 - b.x0 < 28 || b.x1 - b.x0 > (r.x1 - r.x0) * 0.6 || b.y1 - b.y0 < 12) return [];
    const label = labels.filter((w) => inBox(b, (w.x0 + w.x1) / 2, w.y))
      .sort((a, b) => Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x0 - b.x0).map((w) => w.str).join(' ');
    if (!label) return [];
    const diamond = !f.isRect && new Set(Array.from({ length: f.pts.length / 2 }, (_, i) => f.pts.slice(i * 2, i * 2 + 2).join(','))).size === 4;
    return [{ b, label: safeMermaid(label), diamond, x: (b.x0 + b.x1) / 2 }];
  }).sort((a, b) => a.x - b.x || a.b.y0 - b.b.y0);
  if (nodes.length < 3 || arrows.length < 2) return null;
  const participants = nodes.filter((n) => n.b.y1 < arrows[0].tip.y);
  const sequence = participants.length >= 3 && participants.length <= 8 &&
    participants.every((n) => Math.abs(n.b.y0 - participants[0].b.y0) < 4);
  if (sequence) {
    const messages = [];
    for (const { tip, base } of arrows) {
      const to = participants.findIndex((n) => Math.abs(n.x - tip.x) <= 9);
      if (to < 0 || !base || Math.abs(tip.y - base.y) > 2) continue;
      const spans = r.rH.filter((s) => Math.abs(s.pos - tip.y) <= 2 && s.to - s.from > 2);
      const dir = Math.sign(tip.x - base.x);
      const candidates = participants.flatMap((n, i) => (tip.x - n.x) * dir > 12 ? [i] : []);
      const matched = candidates.filter((i) => spans.some((s) => Math.min(Math.abs(s.from - participants[i].x), Math.abs(s.to - participants[i].x)) <= 12));
      const from = matched.length === 1 ? matched[0] : candidates.sort((a, b) =>
        Math.abs(participants[a].x - tip.x) - Math.abs(participants[b].x - tip.x))[0];
      if (from === undefined) continue;
      const x0 = Math.min(participants[from].x, participants[to].x);
      const x1 = Math.max(participants[from].x, participants[to].x);
      const message = labels.filter((w) => w.y > tip.y - 13 && w.y < tip.y - 1 && w.x0 >= x0 && w.x1 <= x1 + 5)
        .sort((a, b) => a.x0 - b.x0).map((w) => w.str).join(' ');
      if (!message) continue;
      const dashed = !spans.some((s) => s.to - s.from >= (x1 - x0) * 0.75 && !s.dashed);
      messages.push(`  P${from}${dashed ? '-->>' : '->>'}P${to}: ${safeMermaid(message).replace(/^\d+:\s*/, '')}`);
    }
    if (messages.length !== arrows.length) return null;
    return { kind2: 'uml', mermaid: ['sequenceDiagram', ...participants.map((n, i) => `  participant P${i} as ${n.label}`), ...messages].join('\n'),
      data: { participants: participants.map((n) => n.label), messages: messages.length } };
  }
  const edges = [];
  for (const { tip } of arrows) {
    const to = nodes.findIndex((n) => Math.abs(n.b.x0 - tip.x) < 9 && tip.y >= n.b.y0 && tip.y <= n.b.y1);
    const shaft = r.rH.filter((s) => Math.abs(s.pos - tip.y) <= 2 && s.to <= tip.x + 3 && s.to >= tip.x - 14 && s.to - s.from >= 12)
      .sort((a, b) => a.from - b.from)[0];
    if (to < 0 || !shaft) continue;
    let from = nodes.findIndex((n) => Math.abs(n.b.x1 - shaft.from) < 9 && tip.y >= n.b.y0 && tip.y <= n.b.y1);
    if (from < 0) {
      from = nodes.findIndex((n) => n.diamond && Math.abs(n.x - shaft.from) < 4 && r.rV.some((s) =>
        Math.abs(s.pos - n.x) < 3 && (Math.abs(s.from - tip.y) < 3 && Math.abs(s.to - n.b.y0) < 3 ||
          Math.abs(s.to - tip.y) < 3 && Math.abs(s.from - n.b.y1) < 3)));
    }
    if (from < 0 || from === to) continue;
    const label = labels.find((w) => Math.abs(w.y - tip.y) <= 15 && w.x0 > shaft.from + 4 && w.x1 < tip.x - 4);
    edges.push(`  N${from} -->${label ? `|${safeMermaid(label.str)}|` : ''} N${to}`);
  }
  if (edges.length !== arrows.length) return null;
  return { kind2: 'flowchart', mermaid: ['flowchart LR', ...nodes.map((n, i) =>
    n.diamond ? `  N${i}{"${n.label}"}` : `  N${i}["${n.label}"]`), ...edges].join('\n'),
    data: { nodes: nodes.map((n) => n.label), edges: edges.length } };
}

function overlap1d(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

// Flowcharts

function reconstructFlowchart(page, r) {
  const { fills, prims } = regionEvidence(page, r);
  const boxes = fills
    .filter((f) => f.isRect && f.bbox.x1 - f.bbox.x0 >= 28 && f.bbox.x1 - f.bbox.x0 <= 0.65 * (r.x1 - r.x0) && f.bbox.y1 - f.bbox.y0 >= 12 && f.bbox.y1 - f.bbox.y0 <= 0.5 * (r.y1 - r.y0))
    .sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)
    .slice(0, 12);
  if (boxes.length < 2) return null;
  const labelOf = (b) => {
    const words = (r.labels || [])
      .filter((w) => {
        const cx = (w.x0 + w.x1) / 2;
        return cx > b.bbox.x0 && cx < b.bbox.x1 && w.y > b.bbox.y0 - 2 && w.y < b.bbox.y1 + 2;
      })
      .sort((a, b2) => a.x0 - b2.x0);
    return words.map((w) => w.str).join(' ').trim().slice(0, 48);
  };
  const nodes = boxes.map((b, i) => ({ i, box: b.bbox, label: labelOf(b) || `Step ${i + 1}` }));
  const near = (x, y, pad = 8) => nodes.find((n) => x >= n.box.x0 - pad && x <= n.box.x1 + pad && y >= n.box.y0 - pad && y <= n.box.y1 + pad);
  const strokes = [...r.rH.map((s) => [s.from, s.pos, s.to, s.pos]), ...r.rV.map((s) => [s.pos, s.from, s.pos, s.to])];
  const edges = [];
  const edgeLabels = [];
  for (const [x1, y1, x2, y2] of strokes) {
    const a = near(x1, y1);
    const b = near(x2, y2);
    if (!a || !b || a === b) continue;
    if (edges.some((e) => e[0] === a.i && e[1] === b.i)) continue;
    edges.push([a.i, b.i]);
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const lab = (r.labels || []).find((w) => Math.hypot((w.x0 + w.x1) / 2 - mx, w.y - my) < 24);
    edgeLabels.push(lab ? lab.str.trim() : '');
    if (edges.length >= 14) break;
  }
  const lines = ['flowchart TD'];
  nodes.forEach((n) => lines.push(`  N${n.i}["${n.label.replace(/["|<>{}[\]\\]/g, '')}"]`));
  edges.forEach(([a, b], k) => {
    const lab = edgeLabels[k]?.replace(/["|<>{}[\]\\]/g, '');
    lines.push(lab ? `  N${a} -->|${lab}| N${b}` : `  N${a} --> N${b}`);
  });
  const inner = [];
  for (const n of nodes) {
    const { x0, y0, x1, y1 } = n.box;
    inner.push(`<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${(y1 - y0).toFixed(1)}" rx="4" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.1"/>`);
    inner.push(textAt((x0 + x1) / 2, (y0 + y1) / 2 + 3, n.label.slice(0, 34), 8.5, '#1e1b4b'));
  }
  for (const [x1, y1, x2, y2] of strokes) {
    if (near(x1, y1) && near(x2, y2) && near(x1, y1) !== near(x2, y2)) inner.push(lineAt(x1, y1, x2, y2, '#475569', 1));
  }
  return {
    svg: svgWrap(r, inner.join('')),
    tableMd: null,
    mermaid: lines.join('\n') + '\n',
    data: { nodes: nodes.map((n) => n.label), edges: edges.length },
  };
}

// UML sequence / state

function reconstructUml(page, r) {
  const rh = r.y1 - r.y0;
  const rw = r.x1 - r.x0;
  const lifelines = r.rV.filter((s) => s.to - s.from > 0.5 * rh).sort((a, b) => a.pos - b.pos);
  if (lifelines.length >= 3) {
    const names = lifelines.map((s, i) => {
      const lab = (r.labels || [])
        .filter((w) => Math.abs((w.x0 + w.x1) / 2 - s.pos) < 40 && w.y < s.from + 24 && w.y >= s.from - 14)
        .sort((a, b) => b.size - a.size)[0];
      return (lab?.str.trim() || `Participant ${i + 1}`).slice(0, 24);
    });
    const messages = r.rH
      .filter((s) => s.to - s.from > 0.1 * rw)
      .map((s) => {
        const a = lifelines.findIndex((l) => Math.abs(l.pos - s.from) < 14);
        const b = lifelines.findIndex((l) => Math.abs(l.pos - s.to) < 14);
        const lab = (r.labels || []).find((w) => Math.abs(w.y - s.pos) < 10 && (w.x0 + w.x1) / 2 > Math.min(s.from, s.to) && (w.x0 + w.x1) / 2 < Math.max(s.from, s.to));
        return { a, b, text: lab?.str.trim() || '' };
      })
      .filter((m) => m.a >= 0 && m.b >= 0 && m.a !== m.b)
      .slice(0, 16);
    if (messages.length >= 2) {
      const lines = ['sequenceDiagram'];
      lifelines.forEach((_, i) => lines.push(`  participant P${i} as ${names[i].replace(/["|<>{}[\]\\,]/g, '')}`));
      for (const m of messages) lines.push(`  P${m.a}->>P${m.b}: ${m.text.replace(/[:;]/g, '').slice(0, 40) || 'call'}`);
      return { svg: null, tableMd: null, mermaid: lines.join('\n') + '\n', data: { participants: names, messages: messages.length } };
    }
  }
  const { curves, prims } = regionEvidence(page, r);
  const circles = curves.filter((c) => c.arcFit && c.isClosed && c.arcFit.r > 4 && c.arcFit.r < 30 && c.arcFit.sweep > 5.5);
  const arrows = prims.filter((p) => p.type === 'arrow');
  if (circles.length >= 2 && arrows.length >= 1) {
    const states = circles.map((c, i) => {
      const lab = (r.labels || []).filter((w) => Math.hypot((w.x0 + w.x1) / 2 - c.arcFit.cx, w.y - c.arcFit.cy) < c.arcFit.r + 14).map((w) => w.str).join(' ').trim();
      return { i, x: c.arcFit.cx, y: c.arcFit.cy, label: lab || `S${i + 1}` };
    });
    const lines = ['stateDiagram-v2'];
    const nearState = (x, y) => states.find((s) => Math.hypot(s.x - x, s.y - y) < 30);
    for (const a of arrows.slice(0, 12)) {
      const from = a.tail ? nearState(a.tail.x, a.tail.y) : null;
      const to = nearState(a.tip.x, a.tip.y);
      if (from && to && from !== to) lines.push(`  ${from.label.replace(/[^A-Za-z0-9_]/g, '_') || 'S'} --> ${to.label.replace(/[^A-Za-z0-9_]/g, '_') || 'S'}`);
    }
    if (lines.length > 1) {
      return { svg: null, tableMd: null, mermaid: lines.join('\n') + '\n', data: { states: states.map((s) => s.label) } };
    }
  }
  return null;
}

// Math geometry

function reconstructGeometry(page, r) {
  const inner = [];
  const strokes = [...r.rH.map((s) => [s.from, s.pos, s.to, s.pos]), ...r.rV.map((s) => [s.pos, s.from, s.pos, s.to])];
  for (const [x1, y1, x2, y2] of strokes) inner.push(lineAt(x1, y1, x2, y2, '#0f172a', 1.2));
  const { curves } = regionEvidence(page, r);
  const angleArcs = [];
  for (const c of curves) {
    if (c.pts.length < 6) continue;
    let d = `M ${c.pts[0].toFixed(1)} ${c.pts[1].toFixed(1)}`;
    for (let k = 2; k + 1 < c.pts.length; k += 2) d += ` L ${c.pts[k].toFixed(1)} ${c.pts[k + 1].toFixed(1)}`;
    inner.push(`<path d="${d}" fill="none" stroke="#0f172a" stroke-width="1.2"/>`);
    if (c.arcFit && c.arcFit.sweep < 3 && c.arcFit.r < 40) angleArcs.push(c.arcFit);
  }
  const vertices = [];
  for (const l of r.labels || []) {
    const t = l.str.trim();
    if (/^[A-Z]$|^[θ∠°]$/.test(t) || /^[\d°]{1,3}°$/.test(t)) {
      vertices.push(t);
      inner.push(textAt((l.x0 + l.x1) / 2, l.y, t, 10, '#b91c1c'));
    }
  }
  const summary = [
    ['Vertices / angles', cellOf(vertices.join(', ') || '—')],
    ['Strokes', strokes.length],
    ['Angle arcs', angleArcs.length],
  ];
  return {
    svg: svgWrap(r, inner.join('')),
    tableMd: mdTable(['Property', 'Value'], summary),
    mermaid: null,
    data: { vertices, strokes: strokes.length, arcs: angleArcs.length },
  };
}

// Gantt timelines

function reconstructGantt(page, r) {
  const { fills } = regionEvidence(page, r);
  const bars = fills
    .filter((f) => f.isRect && f.bbox.x1 - f.bbox.x0 >= 24 && f.bbox.y1 - f.bbox.y0 >= 4 && f.bbox.y1 - f.bbox.y0 <= 18)
    .sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)
    .slice(0, 20);
  if (bars.length < 3) return null;
  const inner = [];
  const rows = [];
  const dateTicks = (r.labels || []).filter((l) => /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|q[1-4])\b/i.test(l.str.trim()));
  bars.forEach((b, i) => {
    const { x0, y0, x1, y1 } = b.bbox;
    inner.push(`<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${(y1 - y0).toFixed(1)}" rx="2" fill="#3b82f6" opacity="0.85"/>`);
    const name = (r.labels || [])
      .filter((l) => l.x1 <= x0 + 4 && l.y > y0 - 6 && l.y < y1 + 6)
      .sort((a, b2) => b2.x1 - a.x1)[0];
    const label = name?.str.trim() || `Task ${i + 1}`;
    if (name) inner.push(textAt(name.x1 + 3, (y0 + y1) / 2 + 3, label.slice(0, 30), 8, '#111', 'start'));
    rows.push({ label: label.slice(0, 40), start: Math.round(x0 - r.x0), span: Math.round(x1 - x0) });
  });
  for (const t of dateTicks.slice(0, 12)) inner.push(textAt((t.x0 + t.x1) / 2, r.y0 + 8, t.str.trim(), 7.5, '#475569'));
  // Require printed month or quarter labels for a Mermaid timeline.
  let mermaid = null;
  if (dateTicks.length >= 3) {
    const lines = ['gantt', `  title ${((figureCaption([], r) || 'Timeline').replace(/[:;]/g, '')).slice(0, 50)}`, '  dateFormat YYYY-MM-DD', '  axisFormat %b %d'];
    bars.forEach((b, i) => {
      const row = rows[i];
      const startDay = Math.max(0, Math.round((b.bbox.x0 - r.x0) / 2));
      const spanDays = Math.max(1, Math.round((b.bbox.x1 - b.bbox.x0) / 2));
      lines.push(`  ${row.label.replace(/[:;,]/g, '')} :a${i}, ${spanDays}d`);
    });
    mermaid = lines.join('\n') + '\n';
  }
  const tableMd = mdTable(['Task', 'Start (pt)', 'Span (pt)'], rows.map((row) => [cellOf(row.label), row.start, row.span]));
  return { svg: svgWrap(r, inner.join('')), tableMd, mermaid, data: { tasks: rows } };
}

// Sankey / weighted flows

function reconstructSankey(page, r) {
  const { curves } = regionEvidence(page, r);
  const rw = r.x1 - r.x0;
  const ribbons = curves
    .filter((c) => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i + 1 < c.pts.length; i += 2) {
        x0 = Math.min(x0, c.pts[i]); x1 = Math.max(x1, c.pts[i]);
        y0 = Math.min(y0, c.pts[i + 1]); y1 = Math.max(y1, c.pts[i + 1]);
      }
      return x1 - x0 > 0.25 * rw && y1 - y0 > 10;
    })
    .slice(0, 14);
  if (ribbons.length < 2) return null;
  const inner = [];
  const rows = [];
  ribbons.forEach((c, i) => {
    let y0 = Infinity, y1 = -Infinity;
    for (let k = 1; k < c.pts.length; k += 2) {
      y0 = Math.min(y0, c.pts[k]);
      y1 = Math.max(y1, c.pts[k]);
    }
    const thickness = y1 - y0;
    const col = c.strokeColor || '#38bdf8';
    let d = `M ${c.pts[0].toFixed(1)} ${c.pts[1].toFixed(1)}`;
    for (let k = 2; k + 1 < c.pts.length; k += 2) d += ` L ${c.pts[k].toFixed(1)} ${c.pts[k + 1].toFixed(1)}`;
    inner.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="${Math.max(2, thickness).toFixed(1)}" opacity="0.7" stroke-linecap="round"/>`);
    const endLab = (px, py) => {
      let best = '';
      let bd = 30;
      for (const l of r.labels || []) {
        const d2 = Math.hypot((l.x0 + l.x1) / 2 - px, l.y - py);
        if (d2 < bd) {
          bd = d2;
          best = l.str.trim();
        }
      }
      return best;
    };
    const src = endLab(c.pts[0], c.pts[1]);
    const dst = endLab(c.pts[c.pts.length - 2], c.pts[c.pts.length - 1]);
    rows.push({ src: src || `Source ${i + 1}`, dst: dst || `Sink ${i + 1}`, w: Math.round(thickness) });
  });
  const totalW = rows.reduce((s, x) => s + x.w, 0) || 1;
  const tableMd = mdTable(['From', 'To', 'Weight %'], rows.map((row) => [cellOf(row.src), cellOf(row.dst), Math.round((row.w / totalW) * 100)]));
  return { svg: svgWrap(r, inner.join('')), tableMd, mermaid: null, data: { flows: rows } };
}

export function extractLabeledBarPanels(page) {
  const fills = page.fills || [];
  const rect = (f) => f.isRect && f.bbox;
  const contains = (a, b) => b.x0 >= a.x0 - 0.5 && b.x1 <= a.x1 + 0.5 &&
    b.y0 >= a.y0 - 0.5 && b.y1 <= a.y1 + 0.5;
  const panels = fills.filter((f) => rect(f) && f.bbox.x1 - f.bbox.x0 >= 110 &&
    f.bbox.y1 - f.bbox.y0 >= 60 && f.bbox.y1 - f.bbox.y0 <= 0.45 * page.height);
  const regions = [];
  for (const { bbox: panel } of panels) {
    const w = panel.x1 - panel.x0, h = panel.y1 - panel.y0;
    if (regions.some((r) => contains(panel, r) || contains(r, panel))) continue;
    const bars = fills.filter((f) => rect(f) && contains(panel, f.bbox) &&
      f.bbox.x1 - f.bbox.x0 >= 6 && f.bbox.x1 - f.bbox.x0 <= w * 0.28 &&
      f.bbox.y1 - f.bbox.y0 >= 6 && f.bbox.y1 - f.bbox.y0 <= h * 0.82)
      .map((f) => f.bbox).sort((a, b) => a.x0 - b.x0);
    if (bars.length < 3 || bars.length > 18 || bars.some((b, i) => i && b.x0 < bars[i - 1].x1 + 2)) continue;
    const words = page.words.filter((t) => contains(panel, { x0: t.x0, x1: t.x1, y0: t.y, y1: t.y }));
    const baseline = Math.max(...bars.map((b) => b.y1));
    if (bars.filter((b) => Math.abs(b.y1 - baseline) <= 1.5).length < 2 || panel.y1 - baseline > 24) continue;
    const rows = bars.map((b) => {
      const x = (b.x0 + b.x1) / 2;
      const aligned = (t) => Math.abs((t.x0 + t.x1) / 2 - x) <= (b.x1 - b.x0) * 0.55;
      const values = words.filter((t) => aligned(t) && t.y < b.y0 + 0.5 && t.y >= b.y0 - 14 &&
        /^[+\u2212-]?\d+(?:[.,]\d+)*%?$/.test(t.str));
      const labels = words.filter((t) => aligned(t) && t.y > baseline + 1 && t.y < baseline + 19);
      return values.length === 1 && labels.length && [labels.sort((a, b) => a.x0 - b.x0).map((t) => t.str).join(' '), values[0].str];
    });
    if (!rows.every(Boolean) || new Set(rows.map((r) => r[0])).size < 3) continue;
    const titleY = Math.min(...words.map((t) => t.y));
    const title = words.filter((t) => t.y <= titleY + 2 && t.y < Math.min(...bars.map((b) => b.y0)) - 12)
      .sort((a, b) => a.x0 - b.x0).map((t) => t.str).join(' ');
    regions.push({ ...panel, kind: 'chart', labels: words, printedBars: rows, caption: title });
  }
  return regions;
}

// Find unframed charts from intersecting axes and readable ticks.
export function extractAxisBarPanels(page) {
  const out = [];
  const { h = [], v = [] } = page.segments || {};
  const baselines = h.filter((s) => s.to - s.from >= 105);
  const rectangles = (page.fills || []).filter((f) => f.isRect && f.bbox.x1 - f.bbox.x0 >= 5);
  if (!baselines.length || rectangles.length < 3) return out;
  const center = (b) => (b.x0 + b.x1) / 2;
  const number = /^-?\d+(?:\.\d+)?%?$/;
  for (const axis of v) {
    const height = axis.to - axis.from;
    if (height < 48) continue;
    for (const base of baselines) {
      const width = base.to - base.from;
      if (width < 105 || Math.abs(axis.to - base.pos) > 1.5 || Math.abs(axis.pos - base.from) > 1.5) continue;
      const ticks = page.words.filter((t) => number.test(t.str) && t.x1 <= axis.pos - 2 && t.x1 >= axis.pos - 26 &&
        t.y >= axis.from - 1 && t.y <= axis.to + 7).sort((a, b) => b.y - a.y);
      if (ticks.length < 3 || ticks.length > 14) continue;
      const first = ticks[0], last = ticks.at(-1);
      const min = parseFloat(first.str), max = parseFloat(last.str);
      const step = (max - min) / (first.y - last.y);
      const percent = first.str.endsWith('%');
      if (!(step > 0) || first.y - last.y < height * 0.65 || Math.abs(first.y - base.pos) > 7 ||
        ticks.some((t, i) => t.str.endsWith('%') !== percent ||
          (i > 0 && ticks[i - 1].y - t.y < 7) ||
          Math.abs(min + (first.y - t.y) * step - parseFloat(t.str)) > (max - min) * 0.017)) continue;
      const bars = rectangles.filter(({ bbox: b }) => b.x0 > base.from + 3 &&
        b.x1 <= base.to + 1 && b.x1 - b.x0 >= 5 && b.x1 - b.x0 < width * 0.26 &&
        b.y0 >= axis.from - 2 && b.y0 <= base.pos - 4 && Math.abs(b.y1 - base.pos) <= 1.5)
        .map(({ bbox }) => bbox).sort((a, b) => a.x0 - b.x0);
      if (bars.length < 3 || bars.length > 24 || bars.some((b, i) => i > 0 && b.x0 - bars[i - 1].x1 < 3)) continue;
      const rows = [];
      const labels = new Set(ticks);
      for (const [i, b] of bars.entries()) {
        const x = center(b);
        const radius = 0.48 * Math.min(i ? x - center(bars[i - 1]) : Infinity,
          i + 1 < bars.length ? center(bars[i + 1]) - x : Infinity);
        const categories = page.words.filter((t) => Math.abs(center(t) - x) < radius &&
          t.y > base.pos + 4 && t.y <= base.pos + 22);
        const label = categories.sort((a, b) => a.x0 - b.x0).map((t) => t.str).join(' ');
        if (!label || !/\p{L}/u.test(label)) break;
        const estimated = min + (base.pos - b.y0) * step;
        const printed = page.words.filter((t) => number.test(t.str) && Math.abs(center(t) - x) < (b.x1 - b.x0) * 0.55 &&
          t.y >= b.y0 - 14 && t.y <= b.y0 + 1 && t.str.endsWith('%') === percent &&
          Math.abs(parseFloat(t.str) - estimated) <= (max - min) * 0.04);
        const source = printed.length === 1 ? printed[0] : null;
        for (const t of categories) labels.add(t);
        if (source) labels.add(source);
        rows.push([label, source ? source.str : '~' + Math.round(estimated * 10) / 10 + (percent ? '%' : '')]);
      }
      if (rows.length !== bars.length || new Set(rows.map((r) => r[0])).size !== bars.length) continue;
      const bbox = { x0: Math.min(axis.pos, ...ticks.map((t) => t.x0)) - 3, x1: base.to + 3,
        y0: axis.from - 11, y1: base.pos + 24 };
      if (out.some((r) => Math.abs(r.x0 - bbox.x0) < 3 && Math.abs(r.y0 - bbox.y0) < 3)) continue;
      out.push({ ...bbox, kind: 'chart', sourcePanel: true, labels: [...labels], rH: [base], rV: [axis],
        axisBars: { rows, approximate: rows.some(([, value]) => value.startsWith('~')) } });
    }
  }
  return out;
}

export function extractHierarchyPanels(page) {
  const regions = [];
  for (const { bbox: r, isRect } of page.fills || []) {
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    if (!isRect || w < 140 || w > 0.48 * page.width || h < 75 || h > 220) continue;
    const inside = (b) => b.x0 > r.x0 + 2 && b.x1 < r.x1 - 2 && b.y0 > r.y0 + 3 && b.y1 < r.y1;
    const nodes = page.fills.filter((f) => inside(f.bbox) && f.bbox.x1 - f.bbox.x0 > 35 &&
      f.bbox.y1 - f.bbox.y0 >= 12 && f.bbox.y1 - f.bbox.y0 <= 35).flatMap(({ bbox: b }) => {
      const text = page.words.filter((t) => t.x0 >= b.x0 && t.x1 <= b.x1 && t.y > b.y0 + 2 && t.y < b.y1)
        .sort((a, b) => a.x0 - b.x0).map((t) => t.str).join(' ');
      return text ? [{ b, text, x: (b.x0 + b.x1) / 2 }] : [];
    }).sort((a, b) => a.b.y0 - b.b.y0 || a.x - b.x);
    if (nodes.length < 3 || nodes.length > 12 || new Set(nodes.map((n) => n.text)).size !== nodes.length) continue;
    const near = (a, b) => Math.abs(a - b) <= 2;
    const edges = [];
    for (const [i, a] of nodes.entries()) for (const [j, b] of nodes.entries()) {
      const gap = b.b.y0 - a.b.y1;
      if (gap < 4 || gap > 36) continue;
      const middle = page.segments.h.find((s) => s.pos > a.b.y1 + 2 && s.pos < b.b.y0 - 2 &&
        s.from <= Math.min(a.x, b.x) + 2 && s.to >= Math.max(a.x, b.x) - 2 &&
        page.segments.v.some((v) => near(v.pos, a.x) && near(v.from, a.b.y1) && near(v.to, s.pos)) &&
        page.segments.v.some((v) => near(v.pos, b.x) && near(v.from, s.pos) && near(v.to, b.b.y0)));
      const diagonal = page.fills.some((f) => !f.isRect && inside(f.bbox) && f.pts.length >= 4 && (
        near(f.pts[0], a.x) && near(f.pts[1], a.b.y1) && near(f.pts[2], b.x) && near(f.pts[3], b.b.y0) ||
        near(f.pts[2], a.x) && near(f.pts[3], a.b.y1) && near(f.pts[0], b.x) && near(f.pts[1], b.b.y0)));
      if (!middle && !diagonal) continue;
      const weights = page.words.filter((t) => {
        if (!/^\d+(?:\.\d+)?%$/.test(t.str) || t.y <= a.b.y1 || t.y >= b.b.y0) return false;
        const x = (t.x0 + t.x1) / 2;
        if (middle) return Math.abs(x - b.x) < 23;
        return Math.abs(x - a.x) < 23;
      });
      edges.push([i, j, weights.length === 1 ? weights[0].str : '']);
    }
    const participating = new Set(edges.flatMap(([a, b]) => [a, b]));
    if (edges.length < 2 || participating.size !== nodes.length) continue;
    const mermaid = ['flowchart TD', ...nodes.map((n, i) => '  N' + i + '["' + safeMermaid(n.text) + '"]'),
      ...edges.map(([a, b, label]) => '  N' + a + ' -->' + (label ? '|' + label + '|' : '') + ' N' + b)].join('\n');
    regions.push({ ...r, kind: 'diagram', hierarchy: { mermaid, edges } });
  }
  return regions;
}

function compactXYChart(rows, mark = 'bar') {
  if (rows.length < 2 || rows.length > 12 ||
      rows.some(([label, value]) => !/^[\p{L}\d][\p{L}\d ._&()-]{0,22}$/u.test(label) ||
        !/^~?[+-]?\d+(?:,\d{3})*(?:\.\d+)?%?$/.test(value))) return null;
  const cells = rows.map(([, value]) => value);
  const percent = cells[0].endsWith('%');
  if (cells.some((value) => value.endsWith('%') !== percent)) return null;
  const values = cells.map((value) => Number(value.replace(/[~,%]/g, '')));
  if (values.some((v) => !Number.isFinite(v))) return null;
  const top = Math.max(0, ...values), bottom = Math.min(0, ...values);
  return ['xychart-beta', '  x-axis [' + rows.map(([label]) => '"' + label + '"').join(', ') + ']',
    '  y-axis "' + (percent ? 'Percent' : 'Value') + '" ' + bottom + ' --> ' + (top || (bottom ? 0 : 1)),
    '  ' + mark + ' [' + values.join(', ') + ']'].join('\n');
}

export function analyzeFigure(page, r) {
  if (r.circuit) return { kind2: 'circuit', structured: true, ...r.circuit,
    tableMd: mdTable(['Component', 'Connection 1', 'Connection 2', 'Output'], r.circuit.rows.map((row) => row.map(cellOf))),
    data: { connections: r.circuit.rows } };
  if (r.pinout) return { kind2: 'pinout', structured: true, tableMd: r.pinout.tableMd,
    mermaid: r.pinout.mermaid, data: { pins: r.pinout.rows } };
  if (r.standaloneFlow) return { kind2: 'flowchart', mermaid: r.standaloneFlow, structured: true };
  if (r.axisBars) {
    const { rows, approximate } = r.axisBars;
    return { kind2: 'bar', structured: true, mermaid: compactXYChart(rows),
      tableMd: mdTable(['Category', approximate ? 'Value' : 'Printed value'], rows.map((row) => row.map(cellOf))),
      data: { rows, ...(approximate ? { approximateColumns: ['Value'] } : {}) } };
  }
  const pattern = reconstructVisualPattern(page, r);
  if (pattern) {
    // Keep paired series in the table because Mermaid XY has no legend.
    const series = pattern.kind2 === 'line-series' && pattern.data.rows[0]?.length === 2
      ? compactXYChart(pattern.data.rows, 'line') : null;
    return { ...pattern, ...(series ? { mermaid: series } : {}), structured: true };
  }
  if (r.hierarchy) return { kind2: 'flowchart', mermaid: r.hierarchy.mermaid, data: { edges: r.hierarchy.edges } };
  if (r.printedBars) return { kind2: 'chart',
    mermaid: r.printedBars.every(([, value]) => !/^[+\u2212-]/.test(value)) ? compactXYChart(r.printedBars) : null,
    tableMd: mdTable(['Category', 'Printed value'],
    r.printedBars.map((r) => r.map(cellOf))), data: { bars: r.printedBars } };
  if (r.sourcePanel && r.kind !== 'chart') {
    const panel = reconstructPanel(page, r);
    if (panel) return panel;
  }
  if (r.kind === 'photo') return null;
  const kind2 = r.sourcePanel && r.kind === 'chart' ? 'chart' : classifyFigure(page, r);
  let out = null;
  try {
    switch (kind2) {
      case 'circuit': out = reconstructCircuit(page, r); break;
      case 'timing': out = reconstructTiming(page, r); break;
      case 'pinout': out = reconstructPinout(page, r); break;
      case 'gauge': out = reconstructGauge(page, r); break;
      case 'chart': out = reconstructChart(page, r); break;
      case 'flowchart': out = reconstructFlowchart(page, r); break;
      case 'uml': out = reconstructUml(page, r); break;
      case 'geometry': out = reconstructGeometry(page, r); break;
      case 'gantt': out = reconstructGantt(page, r); break;
      case 'sankey': out = reconstructSankey(page, r); break;
      default: break;
    }
  } catch (e) {
    console.warn('ingestlab: figure reconstruction failed:', String(e?.message || e).slice(0, 120));
    return null;
  }
  if (!out) return null;
  return { kind2, ...out };
}
