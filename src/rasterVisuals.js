import { fitCircle } from './pdfio.js';
import { detectRuledTables } from './tables.js';
import { figureLabels } from './visualText.js';

const range = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const mid = (lo, hi) => (lo + hi) / 2;
const overlap = (a, b, c, d) => Math.min(b, d) - Math.max(a, c);
const inside = (b, x, y) => x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1;
const compact = (s) => s.replace(/\s+/g, ' ').trim();

function components({ data, width, height }, select) {
  const mask = new Uint8Array(width * height);
  const queue = new Int32Array(mask.length);
  for (let p = 0; p < mask.length; p++) {
    const i = p * 4;
    mask[p] = +select(data[i], data[i + 1], data[i + 2]);
  }
  const out = [];
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    let count = 1, x0 = width, y0 = height, x1 = 0, y1 = 0;
    queue[0] = p;
    mask[p] = 0;
    const add = (i) => {
      if (mask[i]) { mask[i] = 0; queue[count++] = i; }
    };
    for (let j = 0; j < count; j++) {
      const q = queue[j], x = q % width, y = Math.floor(q / width);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      if (x) add(q - 1);
      if (x + 1 < width) add(q + 1);
      add(q - width);
      add(q + width);
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (count < 65 || w < 13 || h < 11) continue;
    const pts = [];
    for (let j = 0; j < count; j += Math.max(1, Math.floor(count / 1100))) {
      pts.push(queue[j] % width, Math.floor(queue[j] / width));
    }
    out.push({ x0, y0, x1, y1, w, h, count, pts });
  }
  return out;
}

function ink(image, coloredBorder = false) {
  const { width: w, height: h, data } = image;
  return (x, y) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= w || y < 0 || y >= h) return false;
    const i = (y * w + x) * 4;
    const hi = Math.max(data[i], data[i + 1], data[i + 2]);
    const lo = Math.min(data[i], data[i + 1], data[i + 2]);
    return hi < 132 || coloredBorder && lo < 100 && hi - lo > 85;
  };
}

function borderedBox(b, dark) {
  const sides = [[b.y0, -1], [b.y1, 1], [b.x0, -1], [b.x1, 1]];
  return sides.every(([pos, sign], i) => {
    const start = i < 2 ? b.x0 : b.y0, end = i < 2 ? b.x1 : b.y1;
    let hits = 0;
    for (let j = 1; j <= 7; j++) {
      const p = start + (end - start) * j / 8;
      for (let d = 0; d <= 4; d++) {
        const q = pos + sign * d;
        if (i < 2 ? dark(p, q) : dark(q, p)) { hits++; break; }
      }
    }
    return hits >= 6;
  });
}

function straightArrow(a, b, nodes, dark, dim) {
  const axis = (box, side) => box[(dim ? 'y' : 'x') + side];
  const cross = (box, side) => box[(dim ? 'x' : 'y') + side];
  const dir = axis(b, 0) > axis(a, 1) ? 1 : axis(a, 0) > axis(b, 1) ? -1 : 0;
  if (!dir) return 0;
  const start = axis(a, dir > 0 ? 1 : 0), end = axis(b, dir > 0 ? 0 : 1);
  const len = Math.abs(end - start);
  const lo = Math.ceil(Math.max(cross(a, 0), cross(b, 0)) + 2);
  const hi = Math.min(cross(a, 1), cross(b, 1)) - 2;
  if (len < 9 || len > 480 || lo > hi) return 0;
  const dot = (p, q) => dim ? dark(q, p) : dark(p, q);
  let score = 0;
  for (let q = lo; q <= hi; q++) {
    if (nodes.some((n) => n !== a && n !== b && q > cross(n, 0) && q < cross(n, 1) &&
        overlap(Math.min(start, end) + 3, Math.max(start, end) - 3, axis(n, 0), axis(n, 1)) > 1)) continue;
    let hits = 0, gap = 0, broken = false;
    for (let d = 8; d < len - 8; d++) {
      if (dot(start + d * dir, q)) { hits++; gap = 0; }
      else if (++gap >= 5) { broken = true; break; }
    }
    if (broken || hits < Math.max(1, (len - 16) * 0.84)) continue;
    // An arrowhead widens symmetrically behind its tip. A plain connector,
    // a box edge or the reverse direction alone is not enough evidence.
    const width = (p) => {
      let l = 0, r = 0;
      for (let i = 1; i <= 12; i++) { l += +dot(p, q - i); r += +dot(p, q + i); }
      return [l + r + +dot(p, q), Math.min(l, r)];
    };
    const widths = Array.from({ length: Math.min(Math.floor(len) - 4, 32) }, (_, i) => width(end - (i + 4) * dir));
    for (let i = 7; i < widths.length - 6; i++) {
      const [head, symmetry] = widths[i];
      const stem = mid(widths[i + 4][0], widths[i + 6][0]);
      if (head < 7 || head >= 21 || symmetry < 2 || stem < 2 || stem >= 11 || head - stem < 4) continue;
      const taper = widths.slice(i - 7, i).map(([n]) => n);
      if (taper.some((n) => n >= 21) || taper[0] + 4 > head ||
          !taper.slice(1, 5).some((n) => n >= taper[0] + 2 && n <= head - 2) ||
          taper.filter((n, j) => j && n + 1 < taper[j - 1]).length > 1) continue;
      score = Math.max(score, head - stem - i * 0.1);
    }
  }
  return score;
}

function straightConnector(a, b, nodes, dark, dim) {
  if (!dim) [a, b] = a.x0 <= b.x0 ? [a, b] : [b, a];
  else [a, b] = a.y0 <= b.y0 ? [a, b] : [b, a];
  const [start, end, lo, hi] = dim
    ? [a.y1, b.y0, Math.max(a.x0, b.x0), Math.min(a.x1, b.x1)]
    : [a.x1, b.x0, Math.max(a.y0, b.y0), Math.min(a.y1, b.y1)];
  if (end - start < 8 || end - start > 95 || hi - lo < 18) return false;
  for (let q = lo + 7; q < hi - 7; q++) {
    if (nodes.some((n) => n !== a && n !== b && (dim
      ? q > n.x0 && q < n.x1 && overlap(start, end, n.y0, n.y1) > 1
      : q > n.y0 && q < n.y1 && overlap(start, end, n.x0, n.x1) > 1))) continue;
    let core = 0;
    for (let p = start + 4; p < end - 3; p++) {
      const dot = (cross) => dim ? dark(cross, p) : dark(p, cross);
      if (!dot(q) || (dot(q - 8) && dot(q + 8))) break;
      core++;
    }
    if (core === end - start - 7) return true;
  }
  return false;
}

async function diagram(image, words, recognize) {
  const dark = ink(image);
  const border = ink(image, true);
  const colored = components(image, (r, g, b) => Math.min(r, g, b) >= 135 &&
    Math.max(r, g, b) - Math.min(r, g, b) >= 10 && Math.max(r, g, b) >= 185);
  const neutral = components(image, (r, g, b) => Math.min(r, g, b) >= 185 && Math.max(r, g, b) <= 253 &&
    Math.max(r, g, b) - Math.min(r, g, b) < 16);
  const boxes = [...colored, ...neutral]
    .filter((b) => b.count > b.w * b.h * 0.5 && b.w >= 36 && b.h >= 20 && b.w / b.h > 1.35 && b.w / b.h < 13 &&
      b.w < image.width * 0.83 && b.h < image.height * 0.58 && borderedBox(b, border))
    .filter((b, i, all) => !all.slice(0, i).some((a) => Math.abs(a.x0 - b.x0) < 7 && Math.abs(a.x1 - b.x1) < 7 &&
      Math.abs(a.y0 - b.y0) < 7 && Math.abs(a.y1 - b.y1) < 7))
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  if (boxes.length < 3 || boxes.length > 28) return null;
  const edgeSet = [];
  const terminals = words.filter((w) => w.conf >= 40 && /^(?:[A-Z]|Inputs|Outputs)$/i.test(w.str) &&
      !boxes.some((b) => inside(b, mid(w.x0, w.x1), w.y - w.size / 2)))
    .map((w) => ({ x0: w.x0 - 2, x1: w.x1 + 2, y0: w.y - w.size, y1: w.y + 2, label: w.str }));
  const all = [...boxes, ...terminals];
  for (const [i, a] of all.entries()) for (const b of all.slice(i + 1)) {
    if (!boxes.includes(a) && !boxes.includes(b)) continue;
    const ab = Math.max(straightArrow(a, b, all, dark, 1), straightArrow(a, b, all, dark, 0));
    const ba = Math.max(straightArrow(b, a, all, dark, 1), straightArrow(b, a, all, dark, 0));
    if (ab >= 3 && ab - ba >= 2.5) edgeSet.push([a, b, true]);
    else if (ba >= 3 && ba - ab >= 2.5) edgeSet.push([b, a, true]);
    else if (boxes.includes(a) && boxes.includes(b) &&
      (straightConnector(a, b, all, dark, 1) || straightConnector(a, b, all, dark, 0))) edgeSet.push([a, b, false]);
  }
  if (edgeSet.length < 2 || !edgeSet.some(([, , directed]) => directed)) return null;
  for (const b of boxes) {
    const inset = 3;
    const result = await recognize({ x0: b.x0 + inset, y0: b.y0 + inset, x1: b.x1 - inset, y1: b.y1 - inset }, '6', 'ink');
    const text = compact(result.text).replace(/^[^\p{L}\p{N}([]+|[^\p{L}\p{N})\].!?]+$/gu, '');
    if (text.length >= 2 && text.length < 80 && /\p{L}{2}/u.test(text) &&
        result.words.some((w) => w.conf >= 62 && /\p{L}{2}/u.test(w.str))) b.label = text;
  }
  const nodes = all.filter((b) => b.label && (boxes.includes(b) || edgeSet.some(([a, z]) => a === b || z === b)));
  const edges = edgeSet.filter(([a, b]) => a.label && b.label).map(([a, b, directed]) =>
    [nodes.indexOf(a), nodes.indexOf(b), directed]);
  if (edges.length < 2 || !edges.some(([, , directed]) => directed)) return null;
  const unmatched = words.filter((w) => w.conf >= 65 &&
    !nodes.some((b) => inside(b, mid(w.x0, w.x1), w.y - w.size / 2)));
  return { kind: 'diagram', nodes: nodes.map((b) => b.label), edges, labels: figureLabels(unmatched)
    .filter((s) => /\p{L}{2}/u.test(s) && !nodes.some((b) => b.label === s)) };
}

function radialRings(image) {
  const colors = components(image, (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) > 90)
    .map((b) => ({ ...b, circle: fitCircle(b.pts) }))
    .filter(({ circle: c, w, h, pts }) => c && c.r > 17 && c.r < image.width * 0.51 &&
      w > c.r * 0.55 && h > c.r * 0.55 &&
      pts.filter((_, i) => !(i % 2) && Math.abs(Math.hypot(pts[i] - c.cx, pts[i + 1] - c.cy) - c.r) < c.r * 0.08).length >= pts.length * 0.41)
    .sort((a, b) => b.circle.r - a.circle.r);
  for (const ring of colors) {
    const c = ring.circle;
    const getAngle = (x, y, fit) => (Math.atan2(y - fit.cy, x - fit.cx) + Math.PI * 2.5) % (Math.PI * 2);
    const group = colors.filter(({ circle }) => Math.hypot(circle.cx - c.cx, circle.cy - c.cy) < c.r * 0.05 &&
      circle.r > c.r * 0.43 && circle.r <= c.r + 0.5);
    const rings = group.map(({ circle, pts }) => {
      const angles = [];
      for (let i = 0; i < pts.length; i += 2) angles.push(getAngle(pts[i], pts[i + 1], circle));
      const span = angles.filter((a) => a < 5.4).sort((a, b) => a - b);
      const start = span[Math.floor(span.length * 0.025)], end = span[Math.floor(span.length * 0.975)];
      return { ...circle, start, end };
    });
    const valid = rings.filter(({ start, end }) => start < 0.32 && end > 0.8 && end < 4.85);
    if (valid.length >= 2) return valid;
  }
  return colors.slice(0, 1).map((b) => b.circle);
}

async function radial(image, recognize, caption) {
  const rings = radialRings(image);
  if (!rings.length || (rings.length < 2 && (!caption || Math.abs(image.width / image.height - 1) > 0.12 ||
      rings[0].r < image.width * 0.32))) return null;
  const { cx, cy, r } = rings.at(-1);
  const left = { x0: 0, y0: 0, x1: cx - r * 0.04, y1: Math.min(...rings.map((c) => c.cy - c.r)) + r * 0.65 };
  const labelsRead = rings.length >= 2 ? await recognize(left, '6', 'ink') : { text: '' };
  const labels = labelsRead.text.split('\n').map(compact).filter((s) => /\p{L}{2}/u.test(s));
  if (labels.length === rings.length && labels.every((s) => s.length > 3)) {
    const values = [];
    for (const c of rings) {
      const x = c.cx + c.r * Math.sin(c.end), y = c.cy - c.r * Math.cos(c.end);
      const radius = c.r * 0.19;
      const probe = await recognize({ x0: x - radius, y0: y - radius, x1: x + radius, y1: y + radius }, '11', 'ink');
      const hits = probe.words.filter((w) => /^\d{1,3}$/.test(w.str) && +w.str <= 100 && w.conf >= 40)
        .sort((a, b) => Math.hypot(mid(a.x0, a.x1) - x, a.y - a.size / 2 - y) - Math.hypot(mid(b.x0, b.x1) - x, b.y - b.size / 2 - y));
      // Accept a printed number only if it also agrees with the observed
      // endpoint on a 0-to-100, three-quarter-turn gauge.
      const estimate = c.end * 100 / (1.5 * Math.PI);
      values.push(hits.find((w) => Math.abs(+w.str - estimate) <= 6)?.str || '');
    }
    if (values.filter(Boolean).length >= 2) return { kind: 'radial', headers: ['Series', 'Printed value'],
      rows: labels.map((l, i) => [l, values[i]]), partial: values.some((v) => !v) };
  }
  const d = r * 0.32;
  const result = await recognize({ x0: cx - d, y0: cy - d, x1: cx + d, y1: cy + d }, '7', 'ink');
  const score = compact(result.text);
  if (!/^\d{1,3}$/.test(score) || +score > 100 || !result.words.some((w) => w.conf > 60)) return null;
  return { kind: 'radial-score', headers: ['Metric', 'Printed value'], rows: [[caption || 'Overall score', score]] };
}

function geometryImage(image, maxWidth) {
  const scale = Math.min(1, maxWidth / image.width);
  if (scale === 1) return { image, scale };
  const width = Math.round(image.width * scale), height = Math.round(image.height * scale);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = (Math.floor(y / scale) * image.width + Math.floor(x / scale)) * 4;
    const to = (y * width + x) * 4;
    for (let k = 0; k < 4; k++) data[to + k] = image.data[from + k];
  }
  return { image: { width, height, data }, scale };
}

async function gridTable(rules, recognize) {
  const near = (a, b, tolerance = 8) => Math.abs(a - b) < tolerance;
  for (const top of rules.h) {
    const rows = rules.h.filter((r) => near(r.from, top.from) && near(r.to, top.to))
      .map((r) => r.pos).sort((a, b) => a - b);
    if (rows.length < 4 || rows.length > 17 || rows.some((r, i) => i && r - rows[i - 1] < 34)) continue;
    const cols = rules.v.filter((c) => near(c.from, rows[0]) && near(c.to, rows.at(-1)) &&
      c.pos >= top.from - 8 && c.pos <= top.to + 8).map((c) => c.pos).sort((a, b) => a - b);
    if (cols.length < 3 || cols.length > 9 || (rows.length - 1) * (cols.length - 1) > 50 ||
        !near(cols[0], top.from) || !near(cols.at(-1), top.to) ||
        cols.some((c, i) => i && c - cols[i - 1] < 48)) continue;
    const output = [];
    for (let y = 1; y < rows.length; y++) {
      const row = [];
      for (let x = 1; x < cols.length; x++) {
        const result = await recognize({ x0: cols[x - 1] + 9, x1: cols[x] - 9,
          y0: rows[y - 1] + 9, y1: rows[y] - 9 }, '6');
        row.push(result.words.filter((w) => w.conf >= 55).map((w) => w.str).join(' '));
      }
      output.push(row);
    }
    if (output[0].every((x) => /\p{L}/u.test(x)) && output.slice(1).every((r) => r.filter(Boolean).length >= 2)) {
      return { kind: 'table', headers: output[0], rows: output.slice(1), partial: output.some((r) => r.some((x) => !x)) };
    }
    break;
  }
  return null;
}

function barChart(image, words) {
  if (words.length < 6) return null;
  const numeric = (s) => /^[+-]?\d+(?:\.\d+)?$/.test(s);
  const readable = words.filter((w) => w.conf >= 55);
  const marks = components(image, (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) > 100);
  const bars = marks
    .filter((b) => b.count > b.w * b.h * 0.86 && b.w > image.width * 0.025 && b.h > image.height * 0.075 &&
      b.w < image.width * 0.27 && b.h < image.height * 0.9).sort((a, b) => a.x0 - b.x0);
  if (bars.length < 3 || bars.length > 15 || bars.some((b, i) => i > 0 && b.x0 <= bars[i - 1].x1 + 2) ||
      bars.some((b) => Math.abs(b.y1 - bars[0].y1) > 5)) return null;
  const baseline = bars[0].y1, left = bars[0].x0, maxSize = Math.max(...readable.map((w) => w.size), 1);
  const right = bars.at(-1).x1;
  if (marks.some((b) => !bars.includes(b) && b.w > (right - left) * 0.4 &&
      b.y0 < baseline && b.y1 > Math.min(...bars.map((bar) => bar.y0))) ||
      words.filter((w) => w.conf >= 33 && numeric(w.str) && w.x0 > right + 4 && w.y < baseline &&
        w.y > Math.min(...bars.map((b) => b.y0)) - maxSize * 2).length >= 2) return null;
  const ticks = readable.filter((w) => numeric(w.str) && w.x1 < left && left - w.x1 < image.width * 0.2 &&
      w.y <= baseline + w.size).sort((a, b) => a.y - b.y);
  if (ticks.length < 3 || Math.max(...ticks.map((w) => w.x1)) - Math.min(...ticks.map((w) => w.x1)) > maxSize) return null;
  const a = ticks[0], z = ticks.at(-1);
  const y = (w) => w.y - w.size / 2;
  const scale = (+a.str - +z.str) / (y(z) - y(a));
  const value = (pos) => +z.str + (y(z) - pos) * scale;
  const step = (+a.str - +z.str) / (ticks.length - 1);
  const atBaseline = value(baseline);
  if (!(step > 0) || ticks.some((w) => Math.abs(value(y(w)) - +w.str) > step * 0.13) ||
      Math.abs(y(z) - baseline) > maxSize * 0.8 &&
      (Math.abs(atBaseline) > step * 0.12 || Math.abs(+z.str - step) > step * 0.12)) return null;
  const rows = [];
  for (const b of bars) {
    const x = mid(b.x0, b.x1);
    const candidates = readable.filter((w) => w.y > baseline + 2 && w.y - w.size < baseline + maxSize * 1.8 &&
      Math.abs(mid(w.x0, w.x1) - x) <= Math.max(b.w * 0.42, 12));
    if (candidates.length !== 1) return null;
    const printed = readable.filter((w) => numeric(w.str) && w.y <= b.y0 + 2 && b.y0 - w.y < maxSize * 1.1 &&
      Math.abs(mid(w.x0, w.x1) - x) <= b.w / 2 && Math.abs(+w.str - value(b.y0)) < step * 0.25);
    if (value(b.y0) > +a.str + step * 0.15) return null;
    rows.push([candidates[0].str, printed.length === 1 ? printed[0].str : '~' + Number(value(b.y0).toPrecision(2))]);
  }
  if (new Set(rows.map(([k]) => k)).size !== rows.length) return null;
  return { kind: 'bar', headers: ['Category', 'Value'], rows, approximate: rows.some((r) => r[1].startsWith('~')) };
}

async function pieChart(image, recognize) {
  const saturated = components(image, (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) > 92);
  const areas = saturated.filter((b) => b.count > image.width * image.height * 0.009 && b.w > 35 && b.h > 35);
  if (areas.length < 3 || areas.length > 7) return null;
  const colors = ({ pts }) => {
    const rgb = [[], [], []];
    for (let i = 0; i < pts.length; i += 2) {
      const offset = (pts[i + 1] * image.width + pts[i]) * 4;
      for (let k = 0; k < 3; k++) rgb[k].push(image.data[offset + k]);
    }
    return rgb.map((channel) => channel.sort((a, b) => a - b)[channel.length >> 1]);
  };
  const chart = { x0: Math.min(...areas.map((b) => b.x0)), y0: Math.min(...areas.map((b) => b.y0)),
    x1: Math.max(...areas.map((b) => b.x1)), y1: Math.max(...areas.map((b) => b.y1)) };
  const radius = mid(chart.x1 - chart.x0, chart.y1 - chart.y0) / 2;
  const total = areas.reduce((n, b) => n + b.count, 0);
  if (Math.abs(chart.x1 - chart.x0 - (chart.y1 - chart.y0)) > radius * 0.22 ||
      Math.abs(total / (Math.PI * radius ** 2) - 1) > 0.2) return null;
  const legend = saturated.filter((b) => b.x0 > chart.x1 + 8 && b.w / b.h > 0.45 && b.w / b.h < 2.2 &&
    b.h < radius * 0.35 && b.count > b.w * b.h * 0.78).sort((a, b) => a.y0 - b.y0);
  if (legend.length !== areas.length || legend.some((b) => Math.abs(b.x0 - legend[0].x0) > 6)) return null;
  const shades = areas.map(colors), assigned = new Set();
  const rows = [];
  for (const b of legend) {
    const c = colors(b);
    const candidates = shades.map((s, i) => [Math.hypot(...s.map((v, j) => v - c[j])), i]).sort(([a], [z]) => a - z);
    const [distance, index] = candidates[0];
    if (distance > 42 || candidates[1][0] - distance < 12 || assigned.has(index)) return null;
    assigned.add(index);
    const result = await recognize({ x0: b.x1 + 2, x1: image.width, y0: b.y0 - b.h * 0.45, y1: b.y1 + b.h * 0.5 }, '7');
    const parts = compact(result.text).match(/^(.+?)\s*[-\u2013\u2014:]?\s+(\d{1,3}(?:\.\d+)?)\s*%$/u);
    if (!parts || !/\p{L}/u.test(parts[1]) || Math.abs(+parts[2] - areas[index].count * 100 / total) > 5) return null;
    rows.push([parts[1].replace(/\s*[-\u2013\u2014:]\s*$/u, ''), parts[2]]);
  }
  return Math.abs(rows.reduce((n, [, value]) => n + Number(value), 0) - 100) <= 1 ?
    { kind: 'pie', headers: ['Category', 'Value'], rows } : null;
}

export async function reconstructRaster(image, words, recognize, rules, caption) {
  const chart = await radial(image, recognize, caption);
  if (chart) return chart;
  const geometry = geometryImage(image, 900);
  const s = geometry.scale;
  const flow = await diagram(geometry.image, words.map((w) => ({ ...w, x0: w.x0 * s, x1: w.x1 * s, y: w.y * s, size: w.size * s })),
    (b, ...args) => recognize({ x0: b.x0 / s, x1: b.x1 / s, y0: b.y0 / s, y1: b.y1 / s }, ...args));
  if (flow) return flow;
  const bars = barChart(image, words);
  if (bars) return bars;
  if (words.filter((w) => /%/.test(w.str)).length >= 3) {
    const pie = await pieChart(image, recognize);
    if (pie) return pie;
  }
  const segments = rules();
  if (words.length < 6) return gridTable(segments, recognize);
  const table = detectRuledTables(words.filter((w) => w.conf >= 52), segments, image.width, image.height).find((t) =>
    t.rows.length >= 3 && t.rows.every((r) => r.length === t.rows[0].length) &&
    t.rows.slice(1).every((r) => r.filter((c) => c.trim()).length >= 2));
  return table ? { kind: 'table', headers: table.rows[0], rows: table.rows.slice(1) } : gridTable(segments, recognize);
}

export function rasterCaption(words, box) {
  const h = box.y1 - box.y0;
  const above = words.filter((w) => w.y < box.y0 + 0.5 && w.y >= box.y0 - Math.min(30, h * 0.35) &&
    w.x0 >= box.x0 - 2 && w.x1 <= box.x1 + 2);
  const labels = figureLabels(above, false);
  return labels.join(' ').trim();
}

export function cropBounds(b, w, h) {
  return [range(Math.floor(b.x0), 0, w), range(Math.floor(b.y0), 0, h),
    range(Math.ceil(b.x1), 0, w), range(Math.ceil(b.y1), 0, h)];
}
