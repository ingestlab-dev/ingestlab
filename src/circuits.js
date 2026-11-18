import { groupLines } from './layout.js';

const EPS = 0.8;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const near = (a, b) => distance(a, b) <= EPS;
const center = (w) => [(w.x0 + w.x1) / 2, w.y - w.size * 0.32];
const bounds = (points) => ({
  x0: Math.min(...points.map(([x]) => x)), x1: Math.max(...points.map(([x]) => x)),
  y0: Math.min(...points.map(([, y]) => y)), y1: Math.max(...points.map(([, y]) => y)),
});
const signal = /^\+?V(?:_?(?:IN|OUT|O|I)\d*|sup[+-])$/i;
const ref = /^R(?:\d+\*?|I|IN|F|G|L|S)?$/i;
const value = /^\d+(?:\.\d+)?\s*(?:[kM\u03A9]|k\u03A9|M\u03A9)$/i;
const escape = (s) => s.replace(/[<>&"#|]/g, (c) => '#' + c.charCodeAt(0) + ';');

function projection(p, { a, b }) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return [a[0] + t * dx, a[1] + t * dy];
}

function addResistors(strokes, take) {
  const diagonals = strokes.filter((s) => !s.used && !s.axis && s.length < 32);
  for (const first of diagonals) {
    if (first.used) continue;
    for (const axis of [0, 1]) {
      const perp = 1 - axis;
      const forward = (s) => s.a[axis] <= s.b[axis] ? [s.a, s.b] : [s.b, s.a];
      const chain = [first];
      const [start, next] = forward(first);
      let end = next, sign = Math.sign(end[perp] - start[perp]);
      while (chain.length < 12) {
        const choices = diagonals.filter((s) => {
          if (s.used || chain.includes(s)) return false;
          const [a, b] = forward(s);
          return b[axis] - a[axis] > 0.35 && near(a, end) && Math.sign(b[perp] - a[perp]) === -sign;
        });
        if (choices.length !== 1) break;
        chain.push(choices[0]);
        end = forward(choices[0])[1];
        sign = -sign;
        if (chain.length >= 5 && Math.abs(end[perp] - start[perp]) < EPS &&
            Math.abs(end[axis] - start[axis]) >= 5 &&
            [start, end].every((p) => strokes.some((s) => s.axis === axis + 1 && !s.used &&
              (near(s.a, p) || near(s.b, p))))) {
          take({ kind: 'resistor', points: [start, end], anchor: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2] }, chain);
          break;
        }
      }
      if (first.used) break;
    }
  }
}

function addGrounds(strokes, take) {
  const bars = strokes.filter((s) => !s.used && s.axis === 1 && s.length < 22);
  const x = (s) => (s.a[0] + s.b[0]) / 2;
  for (const bar of bars) {
    if (bar.used) continue;
    const p = [x(bar), bar.a[1]];
    const below = bars.filter((s) => !s.used && Math.abs(x(s) - p[0]) < 1.1 && s.a[1] > p[1] + 0.6 &&
      s.a[1] < p[1] + 8 && s.length < bar.length - 0.5).sort((a, b) => a.a[1] - b.a[1]);
    if (!below.length || (below.length > 1 && below[0].length <= below[1].length + 0.5) ||
        (below.length === 1 && (bar.length > 6 || below[0].length > bar.length * 0.8 || below[0].a[1] > p[1] + 2))) continue;
    if (!strokes.some((s) => s.axis === 2 && (near(s.a, p) || near(s.b, p)))) continue;
    take({ kind: 'ground', points: [p] }, [bar, ...below.slice(0, 2)]);
  }
}

function wordsNear(items, words, match, limit, getPoint) {
  const candidates = items.flatMap((item) => words.filter((w) => match(w.str)).map((w) => ({
    item, w, d: distance(getPoint(item), center(w)),
  })).filter(({ d }) => d < limit)).sort((a, b) => a.d - b.d);
  const result = new Map(), used = new Set();
  for (const { item, w } of candidates) {
    if (!result.has(item) && !used.has(w)) {
      result.set(item, w);
      used.add(w);
    }
  }
  return result;
}

export function extractCircuitPanels(page) {
  const { words, strokes: raw = [] } = page;
  if (raw.length < 10 || raw.length > 12000 ||
      !words.some((w) => /^(?:\+|VIN|VOUT|VCC|GND)$/i.test(w.str))) return [];
  const byKey = new Map();
  for (const [x, y, u, v, dashed] of raw) {
    const length = Math.hypot(u - x, v - y);
    if (dashed || length < 0.65 || length > 350) continue;
    const [a, b] = x < u || (x === u && y < v) ? [[x, y], [u, v]] : [[u, v], [x, y]];
    const key = [...a, ...b].map((n) => Math.round(n * 5)).join(',');
    byKey.set(key, { a, b, length, axis: Math.abs(y - v) < 0.25 ? 1 : Math.abs(x - u) < 0.25 ? 2 : 0 });
  }
  const strokes = [...byKey.values()];
  const diagonals = strokes.filter((s) => !s.axis && s.length > 14 && s.length < 110);
  const symbols = [];
  const take = (symbol, parts) => {
    for (const s of parts) s.used = true;
    symbols.push(symbol);
  };
  for (const base of strokes.filter((s) => s.axis === 2 && s.length >= 15 && s.length <= 75)) {
    if (base.used) continue;
    const top = diagonals.find((s) => !s.used && [s.a, s.b].some((p) => near(p, base.a)));
    if (!top) continue;
    const tip = near(top.a, base.a) ? top.b : top.a;
    if (Math.abs(tip[0] - base.a[0]) < 18 || tip[1] < base.a[1] + base.length * 0.28 ||
        tip[1] > base.b[1] - base.length * 0.28) continue;
    const bottom = diagonals.find((s) => !s.used && s !== top &&
      ((near(s.a, tip) && near(s.b, base.b)) || (near(s.b, tip) && near(s.a, base.b))));
    if (!bottom) continue;
    const box = bounds([base.a, base.b, tip]);
    const leads = strokes.filter((s) => s.axis === 1 && s.length > 2 && !s.used &&
      [s.a, s.b].some((p) => Math.abs(p[0] - base.a[0]) < EPS && p[1] > box.y0 + 2 && p[1] < box.y1 - 2) &&
      [s.a, s.b].some((p) => (p[0] - base.a[0]) * Math.sign(tip[0] - base.a[0]) < -2));
    const inputs = leads.map((s) => Math.abs(s.a[0] - base.a[0]) < EPS ? s.a : s.b).sort((a, b) => a[1] - b[1]);
    const ports = inputs.filter((p, i) => i === 0 || !near(p, inputs[i - 1]));
    if (ports.length !== 2 || !strokes.some((s) => s.axis === 1 && s.length > 2 && (near(s.a, tip) || near(s.b, tip)))) continue;
    const plus = words.find((w) => w.str === '+' && w.x0 > box.x0 && w.x1 < box.x1 && w.y > box.y0 && w.y < box.y1);
    const minus = strokes.find((s) => s.axis === 1 && s.length <= 9 && [s.a, s.b].every(([x, y]) =>
      x > box.x0 + 1 && x < box.x1 - 1 && y > box.y0 && y < box.y1));
    const positive = plus ? (Math.abs(plus.y - ports[0][1]) < Math.abs(plus.y - ports[1][1]) ? 0 : 1) :
      minus ? (Math.abs(minus.a[1] - ports[0][1]) < Math.abs(minus.a[1] - ports[1][1]) ? 1 : 0) : -1;
    if (positive < 0) continue;
    take({ kind: 'opamp', points: [ports[positive], ports[1 - positive], tip], outline: [base.a, base.b] },
      [base, top, bottom]);
  }
  if (!symbols.length || strokes.length > 2600) return [];
  addResistors(strokes, take);
  addGrounds(strokes, take);

  const wires = strokes.filter((s) => !s.used && s.axis);
  const parent = wires.map((_, i) => i);
  const junctions = (page.primitives || []).filter((p) => p.type === 'junction').map(({ x, y }) => [x, y]);
  const root = (i) => {
    while (i !== parent[i]) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  for (let i = 0; i < wires.length; i++) {
    const a = wires[i];
    for (let j = i + 1; j < wires.length; j++) {
      const b = wires[j];
      if (Math.max(a.a[0], b.a[0]) > Math.min(a.b[0], b.b[0]) + EPS ||
          Math.max(Math.min(a.a[1], a.b[1]), Math.min(b.a[1], b.b[1])) >
          Math.min(Math.max(a.a[1], a.b[1]), Math.max(b.a[1], b.b[1])) + EPS) continue;
      // Crossing wires aren't joined without a junction dot or a shared endpoint.
      if ([a.a, a.b].some((p) => near(p, projection(p, b))) ||
          [b.a, b.b].some((p) => near(p, projection(p, a))) ||
          (a.axis !== b.axis && junctions.some((p) => near(p, projection(p, a)) && near(p, projection(p, b))))) {
        parent[root(j)] = root(i);
      }
    }
  }
  for (const symbol of symbols) {
    symbol.nets = symbol.points.map((p) => {
      const i = wires.findIndex((s) => near(p, projection(p, s)));
      return i < 0 ? null : root(i);
    });
  }
  const amps = symbols.filter((s) => s.kind === 'opamp' && s.nets.every((n) => n != null));
  const out = [];
  for (const amp of amps) {
    if (amp.emitted) continue;
    const nets = new Set(amp.nets), parts = new Set([amp]);
    for (let changed = true; changed;) {
      changed = false;
      for (const s of symbols) {
        if (parts.has(s) || s.nets.some((n) => n == null) || !s.nets.some((n) => nets.has(n))) continue;
        if (s.kind === 'resistor' && s.nets[0] === s.nets[1]) continue;
        parts.add(s);
        for (const n of s.nets) nets.add(n);
        changed = true;
      }
    }
    const connectedWires = wires.filter((_, i) => nets.has(root(i)));
    if (parts.size < 2 && amp.nets[1] !== amp.nets[2]) continue;
    const box = bounds([...parts].flatMap((s) => [...s.points, ...(s.outline || [])]).concat(connectedWires.flatMap((s) => [s.a, s.b])));
    if (box.x1 - box.x0 > page.width * 0.88 || box.y1 - box.y0 > 240) continue;
    const labels = words.filter((w) => w.x1 >= box.x0 - 35 && w.x0 <= box.x1 + 35 &&
      w.y >= box.y0 - 15 && w.y <= box.y1 + 10);
    const resistors = [...parts].filter((s) => s.kind === 'resistor');
    const refs = wordsNear(resistors, labels, (s) => ref.test(s), 25, (s) => s.anchor);
    const values = wordsNear(resistors, labels, (s) => value.test(s), 20, (s) => s.anchor);
    const named = new Map();
    for (const w of labels) {
      const suffix = labels.find((v) => v !== w && /^(?:IN|OUT|I|O)\d*$/i.test(v.str) &&
        v.x0 >= w.x1 - 1 && v.x0 <= w.x1 + 3.2 && Math.abs(v.y - w.y) < 5);
      const name = /^[+]?V$/i.test(w.str) && suffix ? w.str + suffix.str : w.str;
      if (!signal.test(name) || /sup/i.test(name)) continue;
      let best = 42, net;
      for (const s of connectedWires) {
        const d = Math.min(distance(center(w), s.a), distance(center(w), s.b));
        const i = wires.indexOf(s);
        if (d < best && (/(?:OUT|O)\d*$/i.test(name) ? amps.some((a) => parts.has(a) && a.nets[2] === root(i)) : true)) {
          best = d;
          net = root(i);
        }
      }
      if (net !== undefined) named.set(net, name);
    }
    const main = [...parts].filter((s) => s.kind === 'opamp');
    if (!named.has(amp.nets[2])) named.set(amp.nets[2], 'Output');
    for (const s of parts) {
      if (s.kind === 'ground') named.set(s.nets[0], 'GND');
      if (s.kind === 'opamp') s.emitted = true;
    }
    const netIds = new Map([...nets].map((n, i) => [n, 'N' + (i + 1)]));
    const nameOf = (n) => named.get(n) || 'Net ' + netIds.get(n).slice(1);
    const mermaid = ['flowchart LR', ...[...nets].map((n) => `  ${netIds.get(n)}["${escape(nameOf(n))}"]`)];
    const rows = [];
    main.forEach((s, i) => {
      const id = 'U' + (i + 1);
      mermaid.push(`  ${id}["Op-amp ${i + 1}"]`, `  ${netIds.get(s.nets[0])} -->|+| ${id}`,
        `  ${netIds.get(s.nets[1])} -->|-| ${id}`, `  ${id} -->|OUT| ${netIds.get(s.nets[2])}`);
      rows.push([id, '+: ' + nameOf(s.nets[0]), '-: ' + nameOf(s.nets[1]), 'OUT: ' + nameOf(s.nets[2])]);
    });
    resistors.forEach((s, i) => {
      const id = refs.get(s)?.str || 'Resistor ' + (i + 1);
      const val = values.get(s)?.str || '';
      mermaid.push(`  ${netIds.get(s.nets[0])} --- R${i + 1}["${escape([id, val].filter(Boolean).join(' '))}"] --- ${netIds.get(s.nets[1])}`);
      rows.push([[id, val].filter(Boolean).join(' '), nameOf(s.nets[0]), nameOf(s.nets[1]), '']);
    });
    const nearby = words.filter((w) => w.y > box.y1 + 2 && w.y < box.y1 + 44);
    const caption = groupLines(nearby).filter((l) =>
      l.x1 > box.x0 + 10 && l.x0 < box.x1 - 8 &&
      (/^Fig(?:ure)?\.?\s+\d/i.test(l.text) ||
        (l.x1 - l.x0 < box.x1 - box.x0 + 40 &&
          /^.{0,50}(?:Amplifier|Follower|Oscillator|Generator|Driver|Sources?|Monitor|Gain)(?:\s*\([^)]*\))?\s*$/i.test(l.text))))
      .sort((a, b) => a.y - b.y)[0];
    out.push({ ...box, x0: box.x0 - 18, x1: box.x1 + 18,
      y0: box.y0 - 12, y1: box.y1 + 4, labels, kind: 'circuit',
      caption: caption?.text || 'Op-amp schematic (traced connections)',
      circuit: { rows, mermaid: mermaid.join('\n') } });
  }
  return out;
}
