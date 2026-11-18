import { groupLines } from './layout.js';

const cx = (b) => (b.x0 + b.x1) / 2;
const inside = (b, x, y, pad = 0) => x >= b.x0 - pad && x <= b.x1 + pad &&
  y >= b.y0 - pad && y <= b.y1 + pad;
const realWord = (w) => !/^[\u2610\u2611\u2612\u25cb\u25c9]$/.test(w.str);

export function figureLabels(words, split = true) {
  return groupLines((words || []).filter(realWord).map((w) => ({ ...w }))).flatMap((line) => {
    if (!split) return [line.text.trim()];
    const chunks = [];
    for (const w of line.words.slice().sort((a, b) => a.x0 - b.x0)) {
      const last = chunks.at(-1);
      if (!last || w.x0 - last.x1 > Math.max(12, 1.4 * w.size)) chunks.push({ text: w.str, x1: w.x1 });
      else {
        last.text += ' ' + w.str;
        last.x1 = w.x1;
      }
    }
    return chunks.map(({ text }) => text.trim());
  }).filter(Boolean);
}

export function describeConnections(page, region, { directedOnly = false } = {}) {
  const labels = (region.labels || []).filter(realWord);
  if (labels.length < 3) return null;
  const fits = ({ x0, y0, x1, y1 }) => inside(region, x0, y0, -2) && inside(region, x1, y1, -2);
  const nodes = [];
  for (const { bbox: b, pts, isRect } of page.fills || []) {
    if (!fits(b) || (!isRect && pts.length < 30) ||
      b.x1 - b.x0 < 37 || b.y1 - b.y0 < 15 ||
      b.x1 - b.x0 > (region.x1 - region.x0) * 0.58 ||
      b.y1 - b.y0 > (region.y1 - region.y0) * 0.63) continue;
    const words = labels.filter((w) => w.x0 >= b.x0 && w.x1 <= b.x1 && w.y >= b.y0 + 3 && w.y <= b.y1 - 1);
    const lines = figureLabels(words, false);
    if (!lines.length || lines.length > 6 || words.length > 24 || !lines.some((s) => /\p{L}/u.test(s))) continue;
    if (nodes.some((n) => Math.abs(n.b.x0 - b.x0) < 2 && Math.abs(n.b.y0 - b.y0) < 2)) continue;
    nodes.push({ b, label: lines.join('; '), words });
  }
  if (nodes.length < 2 || nodes.length > 20 || nodes.some((a, i) => nodes.some((b, j) =>
    i !== j && inside(b.b, cx(a.b), (a.b.y0 + a.b.y1) / 2)))) return null;
  nodes.sort((a, b) => a.b.x0 - b.b.x0 || a.b.y0 - b.b.y0);
  const atEnd = (x, y) => {
    const matches = nodes.flatMap(({ b }, i) => inside(b, x, y, 2.5) &&
      Math.min(Math.abs(x - b.x0), Math.abs(x - b.x1), Math.abs(y - b.y0), Math.abs(y - b.y1)) <= 2.5 ? [i] : []);
    return matches.length === 1 ? matches[0] : -1;
  };
  // Some exporters encode a straight diagonal as a thin filled path.
  const strokes = [
    ...(region.rH || []).map(({ pos, from, to }) => [from, pos, to, pos]),
    ...(region.rV || []).map(({ pos, from, to }) => [pos, from, pos, to]),
    ...(page.fills || []).filter(({ bbox, pts }) => pts.length === 4 && fits(bbox)).map((f) => f.pts),
  ].filter(([x1, y1, x2, y2]) => Math.hypot(x2 - x1, y2 - y1) >= 10);
  const edges = new Map();
  const put = (a, b, directed) => {
    if (a < 0 || b < 0 || a === b) return;
    const key = [Math.min(a, b), Math.max(a, b)].join(':');
    if (!edges.has(key)) edges.set(key, []);
    const links = edges.get(key);
    if (directed && !links.some((e) => e.directed && e.a === a)) {
      if (links[0] && !links[0].directed) links.length = 0;
      links.push({ a, b, directed });
    } else if (!links.length) links.push({ a, b, directed });
  };
  if (!directedOnly) for (const [x1, y1, x2, y2] of strokes) put(atEnd(x1, y1), atEnd(x2, y2), false);
  for (const { tip, base, type } of page.primitives || []) {
    if (type !== 'arrow' || !tip || !base || !inside(region, tip.x, tip.y)) continue;
    const dest = atEnd(tip.x, tip.y);
    if (dest < 0) continue;
    const vx = tip.x - base.x, vy = tip.y - base.y;
    const distance = Math.hypot(vx, vy);
    if (distance < 2) continue;
    for (const [x1, y1, x2, y2] of strokes) {
      const d1 = Math.hypot(x1 - base.x, y1 - base.y), d2 = Math.hypot(x2 - base.x, y2 - base.y);
      const [sx, sy, ex, ey] = d1 > d2 ? [x1, y1, x2, y2] : [x2, y2, x1, y1];
      if (Math.min(d1, d2) > 3 ||
          ((ex - sx) * vx + (ey - sy) * vy) / (Math.hypot(ex - sx, ey - sy) * distance) < 0.95) continue;
      put(atEnd(sx, sy), dest, true);
    }
  }
  const links = [...edges.values()].flat();
  const linked = new Set(links.flatMap(({ a, b }) => [a, b]));
  if (!links.length || (!directedOnly && linked.size < Math.ceil(nodes.length * 0.65))) return null;
  const used = new Set(nodes.flatMap((n) => n.words));
  return { nodes: nodes.map((n) => n.label), links,
    ...(directedOnly ? { nodeGeometry: nodes } : { labels: figureLabels(labels.filter((w) => !used.has(w))) }) };
}

export function extractStandaloneFlows(page) {
  const arrows = page.primitives?.filter((p) => p.type === 'arrow') || [];
  if (arrows.length < 2 || arrows.length > 30) return [];
  const graph = describeConnections(page, {
    x0: 0, x1: page.width, y0: 0, y1: page.height, labels: page.words,
    rH: page.segments?.h, rV: page.segments?.v,
  }, { directedOnly: true });
  if (!graph) return [];
  const { nodeGeometry: nodes, links } = graph;
  const unseen = new Set(links.flatMap(({ a, b }) => [a, b]));
  const regions = [];
  while (unseen.size) {
    const members = new Set([unseen.values().next().value]);
    for (const node of members)
      for (const { a, b } of links) if (a === node || b === node) members.add(a === node ? b : a);
    for (const node of members) unseen.delete(node);
    if (members.size < 3) continue;
    const ids = [...members].sort((a, b) => a - b);
    const group = ids.map((id) => nodes[id]);
    const bbox = { x0: Math.min(...group.map(({ b }) => b.x0)) - 3, y0: Math.min(...group.map(({ b }) => b.y0)) - 3,
      x1: Math.max(...group.map(({ b }) => b.x1)) + 3, y1: Math.max(...group.map(({ b }) => b.y1)) + 3 };
    if (nodes.some(({ b }, i) => !members.has(i) && inside(bbox, cx(b), (b.y0 + b.y1) / 2))) continue;
    // Untested free text can be edge labels; leave those diagrams to the
    // existing region analyzer rather than dropping the conditions.
    const labels = new Set(group.flatMap((n) => n.words));
    if (page.words.some((w) => realWord(w) && inside(bbox, cx(w), w.y) && !labels.has(w))) continue;
    const clean = (label) => label.replace(/[#"\[\]{}<>|\x60\\]/g, (c) => '#' + c.charCodeAt(0) + ';');
    const mermaid = ['flowchart ' + (bbox.x1 - bbox.x0 >= bbox.y1 - bbox.y0 ? 'LR' : 'TD'),
      ...ids.map((id, i) => '  N' + i + '["' + clean(nodes[id].label) + '"]'),
      ...links.filter(({ a, b }) => members.has(a) && members.has(b))
        .map(({ a, b }) => '  N' + ids.indexOf(a) + ' --> N' + ids.indexOf(b))].join('\n');
    regions.push({ ...bbox, kind: 'diagram', sourcePanel: true, labels: [...labels], rH: [], rV: [], standaloneFlow: mermaid });
  }
  return regions;
}
