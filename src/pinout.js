export function extractDualInlinePinouts(page) {
  const rails = new Map();
  const near = (a, b, d = 1.6) => Math.abs(a - b) <= d;
  const clean = (s) => s.replace(/[|]/g, '\\|');
  for (const w of page.words) {
    if (!/^[1-8]$/.test(w.str)) continue;
    const x = (w.x0 + w.x1) / 2;
    const k = [...rails.keys()].find((a) => near(a, x)) ?? x;
    if (!rails.has(k)) rails.set(k, []);
    rails.get(k).push(w);
  }
  const sequences = (words, order) => words.flatMap((start) => {
    if (start.str !== order[0]) return [];
    const candidates = words.filter((w) => w.str === order[1] &&
      w.y - start.y > 6 && w.y - start.y < 27);
    return candidates.flatMap((next) => {
      const step = next.y - start.y;
      const sequence = order.map((n, i) => words.find((w) => w.str === n && near(w.y, start.y + i * step, 2)));
      return sequence.every(Boolean) ? [sequence] : [];
    });
  });
  const result = [];
  for (const [left, words] of rails) for (const a of sequences(words, ['1', '2', '3', '4'])) {
    for (const [right, candidates] of rails) {
      if (right - left < 25 || right - left > 105) continue;
      for (const b of sequences(candidates, ['8', '7', '6', '5'])) {
        if (!a.every((pin, i) => near(pin.y, b[i].y, 2))) continue;
        const pitch = a[1].y - a[0].y;
        const bbox = { x0: left - 6, x1: right + 6, y0: a[0].y - 1.5 * pitch, y1: a[3].y + 0.6 * pitch };
        const h = page.segments?.h || [];
        if (!h.some((l) => l.pos >= bbox.y0 - 4 && l.pos <= bbox.y1 + 4 &&
          l.from <= left + (right - left) * 0.65 && l.to >= left + (right - left) * 0.35 &&
          l.to - l.from > (right - left) * 0.48)) continue;
        const pins = [...a, ...b];
        const signal = (pin, leftSide) => {
          const words = page.words.filter((w) => !pins.includes(w) && !/^[☐☑☒○◉]$/.test(w.str) &&
            near(w.y, pin.y, 2.3) && (leftSide ? w.x1 <= pin.x0 && w.x1 >= pin.x0 - 100 :
              w.x0 >= pin.x1 && w.x0 <= pin.x1 + 100))
            .sort((x, y) => leftSide ? y.x1 - x.x1 : x.x0 - y.x0);
          if (!words.length || (leftSide ? pin.x0 - words[0].x1 : words[0].x0 - pin.x1) > 47) return null;
          const taken = [words[0]];
          for (const w of words.slice(1)) {
            const gap = leftSide ? taken.at(-1).x0 - w.x1 : w.x0 - taken.at(-1).x1;
            if (gap > Math.max(5, w.size * 0.72)) break;
            taken.push(w);
          }
          if (!leftSide && taken.length === 1 && /^V$/i.test(taken[0].str)) {
            const v = taken[0];
            const sup = page.words.find((w) => /^[+−-]$/.test(w.str) && w.x0 >= v.x1 - 1 &&
              w.x0 <= v.x1 + 2 && w.y < v.y && w.y >= v.y - 6);
            if (sup) taken.push(sup);
          }
          const label = taken.sort((x, y) => x.x0 - y.x0).map((w) => w.str).join(' ')
            .replace(/\s+([+\u00b1\u2212-])$/u, '$1');
          return { label, taken };
        };
        const raw = pins.map((pin, i) => signal(pin, i < 4));
        if (raw.some((s) => !s || s.label.length > 42) ||
            !/OUT(?:PUT)?\s*1/i.test(raw[0].label) || !/OUT(?:PUT)?\s*2/i.test(raw[5].label) ||
            ![1, 2, 6, 7].every((i) => /INPUT|IN[12]/i.test(raw[i].label)) ||
            !/^(?:GND|V[ +−±-]*)$/i.test(raw[3].label)) continue;
        const labels = [...pins, ...raw.flatMap((s) => s.taken)];
        bbox.x0 = Math.min(bbox.x0, ...labels.map((w) => w.x0)) - 2;
        bbox.x1 = Math.max(bbox.x1, ...labels.map((w) => w.x1)) + 2;
        const rows = pins.map((pin, i) => [pin.str, raw[i].label]).sort(([x], [y]) => Number(x) - Number(y));
        for (const [negative, positive] of [[1, 2], [3, 7], [5, 4]]) {
          const s = rows[negative][1];
          if (/^(?:IN[12]|V)\u00b1$/i.test(s) && rows[positive][1] === s.slice(0, -1) + '+') {
            rows[negative][1] = s.slice(0, -1) + '\u2212';
          }
        }
        if (result.some((r) => near(r.y0, bbox.y0, 3) && near(r.x0, bbox.x0, 6))) continue;
        const tableMd = '| Pin | Printed signal |\n| --- | --- |\n' +
          rows.map(([n, s]) => '| ' + n + ' | ' + clean(s) + ' |').join('\n');
        const pin = (n) => 'P' + n + '["' + n + ': ' + rows[Number(n) - 1][1].replace(/["<>\[\]#]/g, '') + '"]';
        const mermaid = ['flowchart LR', '  subgraph package["8-pin package"]', '    direction LR',
          ...a.map((w) => '    ' + pin(w.str)), ...b.map((w) => '    ' + pin(w.str)), '  end'].join('\n');
        result.push({ ...bbox, sourcePanel: true, caption: '8-pin package pin assignments',
          kind: 'pinout', pinout: { rows, tableMd, mermaid }, labels, rH: [], rV: [] });
      }
    }
  }
  return result;
}
