
import { cluster1d } from './util.js';

const WORKSHEET_CODE_RE = /^(\d{1,3}[a-z]?|[a-z])[\.\s]\s*(.+)$/;
const DOT_LEADER_RE = /\.{3,}/;
const hasLeader = (t) => /\.{3,}/.test(t) || (String(t).match(/\./g) || []).length >= 4;
const AMOUNT_RE = /^[($€£¥₫-]*[\d.,]+[)%€£¥₫]*$/;
const RANGE_TOKENS = /\b(low|normal|high|abnormal|borderline)\b/i;

const insideAny = (x0, y0, x1, y1, boxes, pad = 2) =>
  boxes.some(
    (b) => x0 >= b.x0 - pad && x1 <= b.x1 + pad && y0 >= b.y0 - pad && y1 <= b.y1 + pad
  );

const overlapX = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);

// Used to keep form controls out of figure detection.
export function looksLikeFormPage(pageData) {
  const { fills = [], curves = [], primitives = [], width: W = 612, height: H = 792 } = pageData;
  const fieldRects = fills.filter((f) => {
    if (!f.isRect) return false;
    const w = f.bbox.x1 - f.bbox.x0;
    const h = f.bbox.y1 - f.bbox.y0;
    return h >= 7 && h <= 26 && w >= 20 && w < 0.5 * W;
  });
  if (fieldRects.length < 12 || curves.length > 12 || primitives.length > 6) return false;
  // Form fields span the page; shaded table cells often stay in one band.
  const x0 = Math.min(...fieldRects.map((f) => f.bbox.x0));
  const x1 = Math.max(...fieldRects.map((f) => f.bbox.x1));
  const y0 = Math.min(...fieldRects.map((f) => f.bbox.y0));
  const y1 = Math.max(...fieldRects.map((f) => f.bbox.y1));
  const covW = (x1 - x0) / W;
  const covH = (y1 - y0) / H;
  return covW >= 0.45 && covH >= 0.6;
}

function blockText(b) {
  if (b.text) return b.text;
  return '';
}

function wordsIn(words, r) {
  return words.filter((w) => {
    const cx = (w.x0 + w.x1) / 2;
    return cx >= r.x0 - 2 && cx <= r.x1 + 2 && w.y >= r.y0 - 2 && w.y <= r.y1 + 2;
  });
}

const isBoldish = (line, bodySize) =>
  line.size >= bodySize * 1.08 || /^[A-Z0-9 "&'/()\-,.]{3,}$/.test(line.text.trim());


function detectRails(pageData, lines, ruledBboxes) {
  const { width: W, segments } = pageData;
  const bands = [
    { side: 'left', x0: 0, x1: 0.24 * W },
    { side: 'right', x0: 0.8 * W, x1: W },
  ];
  const out = [];
  for (const band of bands) {
    const railLines = lines
      .filter((l) => l.x0 >= band.x0 - 2 && l.x1 <= band.x1 + 8 && l.x1 - l.x0 < 0.3 * W)
      .filter((l) => !insideAny(l.x0, l.y, l.x1, l.y, ruledBboxes))
      .sort((a, b) => a.y - b.y);
    if (railLines.length < 2) continue;
    const bodyX0 = Math.min(
      ...lines.filter((l) => l.x0 > band.x1 - 4).map((l) => l.x0).concat([band.side === 'left' ? W : 0])
    );
    const vRule = (segments?.v || []).some(
      (s) => s.to - s.from > 0.25 * pageData.height && s.pos > band.x1 - 6 && s.pos < band.x1 + 40
    );
    const separated = band.side === 'left' ? bodyX0 >= band.x1 + 2 || vRule : true;
    if (!separated && railLines.length < 4) continue;
    const bodySize = Math.max(7, ...railLines.map((l) => l.size));
    const runs = [];
    for (const l of railLines) {
      const last = runs[runs.length - 1];
      if (last && l.y - last._y <= 3.4 * Math.max(l.size, bodySize)) {
        last.lines.push(l);
        last._y = l.y;
      } else runs.push({ lines: [l], _y: l.y });
    }
    for (const run of runs) {
      const [head, ...rest] = run.lines;
      const notes = rest.filter((l) => l.size <= 7.9);
      const note = notes.map((l) => l.text.trim()).join(' ');
      const isTitle = isBoldish(head, bodySize) || head.text.length <= 34;
      // Require an instruction beside the heading to identify a section rail.
      if (!isTitle || !notes.length) continue;
      const y0 = run.lines[0].y - run.lines[0].size;
      const y1 = run.lines[run.lines.length - 1].y + 3;
      const x0 = Math.min(...run.lines.map((l) => l.x0));
      const x1 = Math.max(...run.lines.map((l) => l.x1));
      out.push({
        type: 'form_section',
        title: head.text.trim().replace(/[.:]\s*$/, ''),
        note: note.slice(0, 160),
        bbox: { x0: x0 - 2, y0, x1: x1 + 2, y1 },
        _side: band.side,
        text: run.lines.map((l) => l.text).join(' '),
      });
    }
  }
  return out;
}


function detectFieldGrids(pageData, lines, ruledBboxes, bodySize) {
  const { fills = [], primitives = [], annotations = [], words = [], width: W } = pageData;
  const boxes = [];
  for (const f of fills) {
    if (!f.isRect) continue;
    const w = f.bbox.x1 - f.bbox.x0;
    const h = f.bbox.y1 - f.bbox.y0;
    if (w < 22 || w > 0.55 * W || h < 7 || h > 26) continue;
    if (insideAny(f.bbox.x0, f.bbox.y0, f.bbox.x1, f.bbox.y1, ruledBboxes)) continue;
    boxes.push(f.bbox);
  }
  // Collect small comb cells separately from single-slot boxes.
  const smallCells = fills
    .filter((f) => {
    if (!f.isRect) return false;
    const w = f.bbox.x1 - f.bbox.x0;
    const h = f.bbox.y1 - f.bbox.y0;
    return w >= 10 && w < 22 && h >= 7 && h <= 26;
  })
    .map((f) => f.bbox);
  for (const p of primitives) {
    if (p.type !== 'comb') continue;
    if (insideAny(p.bbox.x0, p.bbox.y0, p.bbox.x1, p.bbox.y1, ruledBboxes)) continue;
    boxes.push({ ...p.bbox, comb: p.cellCount });
  }
  // Group adjacent character boxes before matching labels.
  const combInput = [...boxes, ...smallCells].sort((a, b2) => a.y0 - b2.y0 || a.x0 - b2.x0);
  const combBoxes = [];
  const skip = new Set();
  for (const b of combInput) {
    if (skip.has(b)) continue;
    const row = [b];
    let cur = b;
    for (;;) {
      const nxt = combInput.find(
        (o) =>
          !skip.has(o) &&
          !row.includes(o) &&
          Math.abs(o.y0 - cur.y0) <= 3 &&
          Math.abs(o.x1 - o.x0 - (cur.x1 - cur.x0)) <= 3 &&
          o.x0 - cur.x1 >= 0 &&
          o.x0 - cur.x1 <= 6
      );
      if (!nxt) break;
      row.push(nxt);
      cur = nxt;
    }
    if (row.length >= 3) {
      const merged = {
        x0: row[0].x0,
        y0: Math.min(...row.map((r) => r.y0)),
        x1: row[row.length - 1].x1,
        y1: Math.max(...row.map((r) => r.y1)),
        comb: row.length,
      };
      row.forEach((r) => skip.add(r));
      combBoxes.push(merged);
    } else if (b.x1 - b.x0 >= 22) combBoxes.push(b);
  }
  boxes.length = 0;
  boxes.push(...combBoxes);

  for (const a of annotations) {
    if (a.fieldType === 'Tx' || a.fieldType === 'Ch') {
      const w = a.bbox.x1 - a.bbox.x0;
      const h = a.bbox.y1 - a.bbox.y0;
      if (w >= 14 && h >= 6 && w < 0.6 * W) boxes.push({ ...a.bbox, value: a.fieldValue ?? '' });
    }
  }

  // Assign each word to at most one field.
  const boxWords = new Map();
  const interior = new Set();
  for (const b of boxes) {
    const inside = wordsIn(words, { x0: b.x0 + 2, y0: b.y0 + 1, x1: b.x1 - 2, y1: b.y1 - 1 }).filter((w) => w.size > 6.5);
    boxWords.set(b, inside);
    for (const w of inside) interior.add(w);
  }
  const pairs = [];
  for (const b of boxes) {
    for (const w of words) {
      if (w.size > Math.max(7.9, bodySize * 1.05) || interior.has(w)) continue;
      if (w.y >= b.y0 - 3 && w.y <= b.y1 + 4 && w.x1 <= b.x0 + 2 && b.x0 - w.x1 <= 1.8 * w.size) {
        pairs.push({ w, b, gap: 0.5 });
        continue;
      }
      const ox = overlapX(w.x0, w.x1, b.x0 - 4, b.x1 + 4);
      if (ox <= 0.4 * (w.x1 - w.x0)) continue;
      const gapAbove = b.y0 - w.y;
      const gapBelow = w.y - b.y1;
      let gap = null;
      if (gapAbove >= 2 && gapAbove <= 11) gap = gapAbove;
      else if (gapBelow >= 1 && gapBelow <= 9) gap = gapBelow;
      if (gap === null) continue;
      pairs.push({ w, b, gap });
    }
  }
  pairs.sort((a, b2) => a.gap - b2.gap);
  const byBox = new Map();
  for (const { w, b } of pairs) {
    if (!byBox.has(b)) byBox.set(b, []);
    byBox.get(b).push(w);
  }
  for (const ws of byBox.values()) ws.sort((a, b2) => a.x0 - b2.x0);
  const labelOf = new Map();
  const usedWord = new Set();
  for (const { w, b } of pairs) {
    if (usedWord.has(w)) continue;
    if (labelOf.has(b)) continue;
    const line = byBox.get(b) || [w];
    const group = [w];
    usedWord.add(w);
    const i0 = line.indexOf(w);
    for (let k = i0 + 1; k < line.length; k++) {
      const prev = group[group.length - 1];
      const cand = line[k];
      if (usedWord.has(cand)) break;
      if (Math.abs(cand.y - prev.y) <= 1.5 && cand.x0 - prev.x1 <= 1.6 * cand.size) {
        group.push(cand);
        usedWord.add(cand);
      } else break;
    }
    labelOf.set(b, group);
  }
  const fields = [];
  for (const b of boxes) {
    const labelWords = (labelOf.get(b) || []).sort((a, b2) => a.x0 - b2.x0);
    const label = labelWords.map((w) => w.str).join(' ').slice(0, 60);
    const value = b.value ?? boxWords.get(b).sort((a, b2) => a.x0 - b2.x0).map((w) => w.str).join(' ').slice(0, 80);
    fields.push({ bbox: b, label, value, comb: b.comb, width: Math.round(b.x1 - b.x0) });
  }
  // Fold adjacent, unlabeled date boxes into the same input.
  fields.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  const merged = [];
  for (const f of fields) {
    const hasOwn = f.label || (f.value && f.value.trim()) || f.comb;
    const last = merged[merged.length - 1];
    const lastRight = last && last.parts ? last.parts[last.parts.length - 1].x1 : last?.bbox.x1;
    const gap = lastRight != null ? f.bbox.x0 - lastRight : Infinity;
    if (!hasOwn && last && last.label && Math.abs(f.bbox.y0 - last.bbox.y0) <= 5 && gap >= 1 && gap <= 22 && (last.parts?.length || 0) < 5) {
      (last.parts ||= []).push({ width: f.width, value: (f.value || '').trim(), x1: f.bbox.x1 });
      continue;
    }
    merged.push(f);
  }
  let real = merged
    .filter((f) => f.label || (f.value && f.value.trim()) || f.comb || f.parts)
    .filter((f) => !f.label || f.label.split(/\s+/).length <= 7);
  const keptFields = [];
  for (const f of real) {
    const dup = keptFields.find((k) => {
      const ox = overlapX(k.bbox.x0, k.bbox.x1, f.bbox.x0, f.bbox.x1);
      const oy = Math.max(0, Math.min(k.bbox.y1, f.bbox.y1) - Math.max(k.bbox.y0, f.bbox.y0));
      const smaller = Math.min((k.bbox.x1 - k.bbox.x0) * (k.bbox.y1 - k.bbox.y0), (f.bbox.x1 - f.bbox.x0) * (f.bbox.y1 - f.bbox.y0));
      return smaller > 0 && (ox * oy) / smaller > 0.4;
    });
    if (!dup) keptFields.push(f);
    else if (!dup.label && f.label) keptFields[keptFields.indexOf(dup)] = f;
  }
  real = keptFields;
  const labeledRatio = real.filter((f) => f.label).length / real.length;
  const hasComb = real.some((f) => f.comb);
  const labeled = real.filter((f) => f.label).length;
  if (real.length < 3 || real.length > 48 || labeledRatio < 0.5) {
    if (!(real.length === 2 && hasComb && labeled >= 1)) return [];
  }

  real.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  const rows = [];
  for (const f of real) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(f.bbox.y0 - last._y) <= 5) {
      last.fields.push(f);
      last._y = (last._y + f.bbox.y0) / 2;
    } else rows.push({ fields: [f], _y: f.bbox.y0 });
  }
  let title = null;
  const firstY = rows[0].fields[0].bbox.y0;
  const firstX0 = Math.min(...rows[0].fields.map((f) => f.bbox.x0));
  for (const l of lines) {
    if (l.y > firstY || l.y < firstY - 34) continue;
    if (l.x0 > firstX0 + 30) continue;
    if (isBoldish(l, bodySize) && l.words.length <= 9) {
      title = l.text.trim().slice(0, 70);
      break;
    }
  }
  const y0 = Math.min(...real.map((f) => f.bbox.y0)) - 4;
  const y1 = Math.max(...real.map((f) => f.bbox.y1)) + 6;
  const x0 = Math.min(...real.map((f) => f.bbox.x0)) - 6;
  const x1 = Math.max(...real.map((f) => f.bbox.x1)) + 6;
  let top = y0;
  if (title) {
    const tl = lines.find((l) => l.text.trim() === title);
    if (tl) top = Math.min(top, tl.y - tl.size - 1);
  }
  const covered = lines
    .filter((l) => {
      const cx = (l.x0 + l.x1) / 2;
      return cx >= x0 - 6 && cx <= x1 + 6 && l.y >= top - 2 && l.y <= y1 + 2;
    })
    .map((l) => l.text)
    .join(' ');
  return [
    {
      type: 'form_grid',
      title,
      rows: rows.map((r) =>
        r.fields.map((f) => ({
          label: f.label,
          value: (f.value || '').trim(),
          comb: f.comb || undefined,
        }))
      ),
      bbox: { x0, y0: top, x1, y1 },
      text: covered || title || '',
    },
  ];
}


function detectOptionMatrix(pageData, lines, ruledBboxes) {
  const { primitives = [], words = [] } = pageData;
  const prims = primitives.filter(
    (p) =>
      (p.type === 'checkbox' || p.type === 'radio') &&
      !insideAny(p.bbox.x0, p.bbox.y0, p.bbox.x1, p.bbox.y1, ruledBboxes)
  );
  if (prims.length < 3) return [];
  const glyphOf = (p) => {
    const base = p.type === 'radio' ? (p.checked ? '◉' : '○') : p.checked ? '☑' : '☐';
    return base;
  };
  const options = [];
  for (const p of prims) {
    const y = p.bbox.y1;
    const size = Math.max(6, p.bbox.y1 - p.bbox.y0);
    const labelWords = words
      .filter((w) => Math.abs(w.y - y) <= Math.max(3.5, 0.55 * w.size))
      .filter((w) => w.x0 >= p.bbox.x1 - 2 && w.x0 <= p.bbox.x1 + 16)
      .sort((a, b) => a.x0 - b.x0);
    const chained = [];
    let prev = null;
    for (const w of labelWords) {
      if (prev && w.x0 - prev.x1 > 1.6 * w.size) break;
      chained.push(w);
      prev = w;
      if (chained.length >= 8) break;
    }
    const label = chained.map((w) => w.str).join(' ').slice(0, 60);
    if (!label) continue;
    options.push({
      x: p.bbox.x0,
      y,
      label,
      checked: !!p.checked,
      glyph: glyphOf(p),
      size,
      _x1: chained.length ? chained[chained.length - 1].x1 : p.bbox.x1 + 30,
    });
  }
  if (options.length < 3) return [];

  options.sort((a, b) => a.x - b.x || a.y - b.y);
  const stacks = [];
  for (const o of options) {
    const last = stacks[stacks.length - 1];
    if (last && Math.abs(o.x - last.x) <= 10 && o.y - last._y <= 3.2 * o.size) {
      last.items.push(o);
      last._y = o.y;
    } else stacks.push({ x: o.x, items: [o], _y: o.y });
  }
  const big = stacks.filter((s) => s.items.length >= 3);
  if (!big.length) return [];

  const out = [];
  if (big.length >= 2) {
    const allY = [...new Set(big.flatMap((s) => s.items.map((i) => Math.round(i.y / 10))))].sort((a, b) => a - b);
    const rows = [];
    for (const yk of allY) {
      const row = [];
      let any = false;
      for (const s of big) {
        const item = s.items.find((i) => Math.abs(i.y / 10 - yk) <= 0.6);
        row.push(item ? `${item.glyph} ${item.label}` : '');
        if (item) any = true;
      }
      if (any) rows.push(row);
    }
    if (rows.length >= 3) {
      const y0 = Math.min(...big.flatMap((s) => s.items.map((i) => i.y))) - 10;
      const y1 = Math.max(...big.flatMap((s) => s.items.map((i) => i.y))) + 6;
      out.push({
        type: 'form_matrix',
        rows,
        bbox: { x0: big[0].x - 6, y0, x1: Math.max(...big.flatMap((s) => s.items.map((i) => i._x1))) + 8, y1 },
        text: big.flatMap((s) => s.items.map((i) => i.label)).join(' '),
      });
      return out;
    }
  }
  for (const s of big) {
    const y0 = s.items[0].y - s.items[0].size - 6;
    const y1 = s.items[s.items.length - 1].y + 6;
    let title = null;
    for (const l of lines) {
      if (l.y > y0 || l.y < y0 - 26) continue;
      if (isBoldish(l, Math.max(...s.items.map((i) => i.size))) && l.words.length <= 8) {
        title = l.text.trim().slice(0, 60);
        break;
      }
    }
    out.push({
      type: 'form_matrix',
      title,
      rows: s.items.map((i) => [`${i.glyph} ${i.label}`]),
      bbox: { x0: s.x - 6, y0, x1: Math.max(...s.items.map((i) => i._x1)) + 8, y1 },
      text: s.items.map((i) => i.label).join(' '),
    });
  }
  return out;
}


function detectWorksheets(pageData, lines, ruledBboxes, formPage = false) {
  const hSegs = pageData.segments?.h || [];
  const out = [];
  let run = null;
  let title = null;

  const underlineFor = (l) => {
    let single = false;
    let double = false;
    for (const s of hSegs) {
      if (s.pos >= l.y + 0.5 && s.pos <= l.y + 5.5 && overlapX(s.from, s.to, Math.max(l.x0, l.x1 - 80), l.x1 + 6) > 24) {
        single = true;
        for (const s2 of hSegs) {
          const d = Math.abs(s2.pos - s.pos);
          if (d > 1.2 && d <= 5 && overlapX(s2.from, s2.to, s.from, s.to) > 24) double = true;
        }
      }
    }
    return double ? 'double' : single ? 'single' : false;
  };

  const mkRow = (code, label, l, leader, underline) => {
    const lastWord = l.words[l.words.length - 1];
    let amt = null;
    if (lastWord && AMOUNT_RE.test(lastWord.str) && /\d/.test(lastWord.str) && label.endsWith(lastWord.str)) {
      amt = lastWord.str;
      label = label.slice(0, label.length - lastWord.str.length).trim();
    }
    return {
      code,
      label: label.replace(DOT_LEADER_RE, '').replace(/\s{2,}/g, ' ').slice(0, 320),
      amount: amt,
      leader,
      underline,
      bbox: { x0: l.x0, y0: l.y - l.size, x1: l.x1, y1: l.y + 3 },
      _x0: l.x0,
    };
  };

  const flush = () => {
    if (run && run.rows.length >= 3) {
      // Bare digits 1 to 4 can label dependents rather than worksheet rows.
      const codes = run.rows.map((r) => r.code).filter(Boolean);
      if (!codes.length || !(codes.every((c) => /^\d$/.test(c) && +c <= 4) && codes.length >= 3)) {
        const indentBase = Math.min(...run.rows.map((r) => r._x0));
        const rowsOut = run.rows.map((r) => ({
          code: r.code,
          label: r.label,
          amount: r.amount,
          leader: r.leader,
          underline: r.underline,
          indent: r._x0 - indentBase > 1.1 * 9,
        }));
        let top = run.rows[0].bbox.y0 - 4;
        let allText = rowsOut.map((r) => `${r.code} ${r.label} ${r.amount || ''}`).join(' ');
        if (title) {
          const tl = lines.find((l) => l.text.trim() === title);
          if (tl) {
            top = Math.min(top, tl.y - tl.size - 1);
            allText += ' ' + title;
          }
        }
        // Require dot leaders or aligned amounts to distinguish worksheets from numbered prose.
        const evidence = rowsOut.filter((r) => r.leader || r.amount).length;
        if (evidence < Math.max(2, 0.4 * rowsOut.length)) {
          run = null;
          title = null;
          return;
        }
        out.push({
          type: 'worksheet',
          title,
          rows: rowsOut,
          bbox: {
            x0: Math.min(...run.rows.map((r) => r.bbox.x0)) - 4,
            y0: top,
            x1: Math.max(...run.rows.map((r) => r.bbox.x1)) + 4,
            y1: run.rows[run.rows.length - 1].bbox.y1 + 4,
          },
          text: allText,
        });
      }
    }
    run = null;
    title = null;
  };

  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    if (insideAny(l.x0, l.y, l.x1, l.y, ruledBboxes)) {
      flush();
      continue;
    }
    const t = l.text.trim();
    let m = t.match(WORKSHEET_CODE_RE);
    if (!m && formPage) {
      const m2 = t.match(/\s(\d{1,3}[a-z]?)\s+(?=[A-Z("“])/);
      if (m2) m = { 1: m2[1], 2: t.slice(m2.index + m2[0].length) };
    }
    if (!m) {
      // Keep instructions between worksheet rows on form pages.
      if (
        formPage &&
        run &&
        run.rows.length &&
        l.y - run._lastY > 0 &&
        l.y - run._lastY <= 5 * l.size &&
        t.length <= 320 &&
        l.words.length <= 60 &&
        !/^[☐☑☒]/.test(t)
      ) {
        run.rows.push(mkRow('', t.replace(DOT_LEADER_RE, '').trim(), l, hasLeader(t), false));
        run._lastY = l.y;
        continue;
      }
      const next = lines[li + 1];
      const nextCoded =
        next &&
        !insideAny(next.x0, next.y, next.x1, next.y, ruledBboxes) &&
        WORKSHEET_CODE_RE.test(next.text.trim());
      if (nextCoded && t.length <= 64 && l.words.length <= 9 && isBoldish(l, l.size)) {
        flush();
        title = t;
        continue;
      }
      flush();
      continue;
    }
    const leader = hasLeader(t);
    const underline = underlineFor(l);
    run ||= { rows: [], _lastY: l.y };
    const mid = m[2].match(/\s(\d{1,3}[a-z]|[b-z])[\.\s]\s*(?=[A-Z(])/);
    if (mid) {
      run.rows.push(mkRow(m[1], m[2].slice(0, mid.index), l, leader, underline));
      const second = m[2].slice(mid.index + 1);
      const mb = second.match(/^(\d{1,3}[a-z]?|[a-z])[\.\s]\s*(.+)$/);
      if (mb) run.rows.push(mkRow(mb[1], mb[2], l, false, underline));
    } else {
      run.rows.push(mkRow(m[1], m[2], l, leader, underline));
    }
    run._lastY = l.y;
  }
  flush();
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i];
    const b = out[i + 1];
    if (!a || !b || a.type !== 'worksheet' || b.type !== 'worksheet') continue;
    const ox = overlapX(a.bbox.x0, a.bbox.x1, b.bbox.x0, b.bbox.x1);
    if (b.bbox.y0 - a.bbox.y1 > 26 || ox < 0.5 * Math.min(a.bbox.x1 - a.bbox.x0, b.bbox.x1 - b.bbox.x0)) continue;
    a.rows = a.rows.concat(b.rows);
    a.bbox = {
      x0: Math.min(a.bbox.x0, b.bbox.x0),
      y0: a.bbox.y0,
      x1: Math.max(a.bbox.x1, b.bbox.x1),
      y1: b.bbox.y1,
    };
    a.text = `${a.text} ${b.text}`;
    out.splice(i + 1, 1);
    i--;
  }
  return out;
}


// Recover input boxes from short ruled strokes on scans.
export function ocrFieldBoxes(segments) {
  const H = (segments?.boxH?.length ? segments.boxH : segments?.h || []).filter(
    (s) => s.to - s.from >= 10 && s.to - s.from <= 340
  );
  if (H.length < 2) return [];
  const rows = cluster1d(H, (s) => s.pos, 3).sort((a, b) => a.key - b.key);
  const boxes = [];
  const seen = [];
  for (let i = 0; i < rows.length && boxes.length < 60; i++) {
    for (let j = i + 1; j < rows.length && boxes.length < 60; j++) {
      const dy = rows[j].key - rows[i].key;
      if (dy < 7) continue;
      if (dy > 28) break;
      for (const a of rows[i].items) {
        for (const b of rows[j].items) {
          if (Math.abs(a.from - b.from) > 4 || Math.abs(a.to - b.to) > 4) continue;
          const bbox = { x0: a.from, y0: rows[i].key, x1: a.to, y1: rows[j].key };
          if (seen.some((s) => Math.abs(s.x0 - bbox.x0) < 4 && Math.abs(s.y0 - bbox.y0) < 4)) continue;
          seen.push(bbox);
          boxes.push({ bbox, isRect: true });
        }
      }
    }
  }
  return boxes;
}

const UNDERSCORE_FIELD_RE = /(^|[\s:]+)([^_\n]{2,70}?)[\s:]*([_\u2013\u2014\u2015]{3,})(?=\s|$)/g;

// Underscore runs can mark input slots on scanned forms.
function detectUnderscoreFields(pageData, lines, ruledBboxes) {
  const blocks = [];
  let run = null;
  const flush = () => {
    if (run && run.rows.length) {
      blocks.push({
        type: 'form_grid',
        rows: run.rows,
        bbox: run.bbox,
        text: run.texts.join(' '),
      });
    }
    run = null;
  };
  const DATE_SUB = /^(ngay|thang|nam|ngay|thang|nam|date|day|month|year)$/i;
  for (const l of lines) {
    if (insideAny(l.x0, l.y, l.x1, l.y, ruledBboxes)) {
      flush();
      continue;
    }
    const t = l.text.trim();
    const matches = [...t.matchAll(UNDERSCORE_FIELD_RE)].filter((m) => {
      const label = m[2].replace(/[.:,\s]+$/, '').trim();
      return label && !/^[\d([)]/.test(label) && label.length >= 2;
    });
    if (!matches.length) {
      flush();
      continue;
    }
    run ||= { rows: [], texts: [], bbox: { x0: l.x0, y0: l.y - l.size, x1: l.x1, y1: l.y + 3 } };
    run.texts.push(t);
    run.bbox.y1 = l.y + 3;
    run.bbox.x1 = Math.max(run.bbox.x1, l.x1);
    run.bbox.x0 = Math.min(run.bbox.x0, l.x0);
    const fields = matches.map((m) => {
      const label = m[2].replace(/[.:,\s]+$/, '').trim().slice(0, 60);
      const runLen = m[3].length;
      const width = Math.max(20, Math.min(340, runLen * Math.max(3, l.size) * 0.5));
      return { label, width, value: '' };
    });
    const row = [fields[0]];
    for (const f of fields.slice(1)) {
      const isDatePart = DATE_SUB.test(f.label) && row.length === 1;
      if (isDatePart) (row[0].parts ||= []).push({ width: f.width, value: '', x1: f.width });
      else row.push(f);
    }
    run.rows.push(row);
  }
  flush();
  return blocks;
}


function detectKvPanels(pageData, lines, ruledBboxes) {
  const { height: H } = pageData;
  const rows = [];
  let run = null;
  const flush = () => {
    if (run && run.rows.length >= 2) {
      const y0 = run._y0 - 8;
      const y1 = run._y1 + 6;
      rows.push({
        type: 'kv_panel',
        rows: run.rows,
        bbox: { x0: 0.04 * pageData.width, y0, x1: 0.96 * pageData.width, y1 },
        text: run.rows.flat().join(' '),
      });
    }
    run = null;
  };
  const head = lines
    .filter((l) => !insideAny(l.x0, l.y, l.x1, l.y, ruledBboxes))
    .filter((l) => l.y < 0.4 * H || RANGE_TOKENS.test(l.text));
  for (const l of head) {
    const cells = [];
    let cur = '';
    let prev = null;
    for (const w of l.words) {
      if (prev && w.x0 - prev.x1 > 2.0 * l.size) {
        cells.push(cur.trim());
        cur = '';
      } else if (cur.endsWith(':') && w.str !== prev?.str) {
        cells.push(cur.trim());
        cur = '';
      }
      cur += w.str + ' ';
      prev = w;
    }
    cells.push(cur.trim());
    const clean = cells.filter(Boolean);
    if (clean.length < 4) {
      flush();
      continue;
    }
    const pairs = [];
    for (let i = 0; i < clean.length; i++) {
      const c = clean[i];
      if (/:$/.test(c) && i + 1 < clean.length) {
        pairs.push(c.replace(/:$/, ''), clean[i + 1]);
        i++;
      } else if (i + 1 < clean.length && clean[i + 1].includes(':')) {
        pairs.push(c, clean[i + 1]);
        i++;
      }
    }
    if (pairs.length < 4) {
      flush();
      continue;
    }
    run ||= { rows: [], _y0: l.y, _y1: l.y };
    run.rows.push(pairs);
    run._y1 = l.y;
  }
  flush();
  return rows;
}


export function extractFormBlocks(pageData, lines, ruledBboxes = [], formPage = false) {
  const blocks = [];
  if (!lines || lines.length < 2) return blocks;
  const bodySize = Math.max(7, ...lines.map((l) => l.size));
  let pd = pageData;
  try {
    if (!pd.fills?.length && !pd.annotations?.length && pd.segments) {
      const boxFills = ocrFieldBoxes(pd.segments);
      if (boxFills.length) pd = { ...pd, fills: boxFills };
    }
  } catch {
  }
  const formProv = pd.annotations?.length
    ? 'acroForm'
    : (pd.primitives || []).some((p2) => p2.type === 'checkbox')
      ? 'skiaCheckbox'
      : 'geometricFallback';
  const tag = (bs) => bs.map((b) => ({ ...b, prov: b.prov || formProv }));
  try {
    blocks.push(...tag(detectUnderscoreFields(pd, lines, ruledBboxes)));
  } catch (e) {
    console.warn('ingestlab: underscore field detection failed:', String(e?.message || e).slice(0, 120));
  }
  try {
    if (!formPage) blocks.push(...detectRails(pageData, lines, ruledBboxes));
  } catch (e) {
    console.warn('ingestlab: form rail detection failed:', String(e?.message || e).slice(0, 120));
  }
  try {
    blocks.push(...tag(detectFieldGrids(pd, lines, ruledBboxes, bodySize)));
  } catch (e) {
    console.warn('ingestlab: form field-grid detection failed:', String(e?.message || e).slice(0, 120));
  }
  try {
    blocks.push(...detectOptionMatrix(pageData, lines, ruledBboxes));
  } catch (e) {
    console.warn('ingestlab: form option-matrix detection failed:', String(e?.message || e).slice(0, 120));
  }
  try {
    blocks.push(...detectWorksheets(pageData, lines, ruledBboxes, formPage));
  } catch (e) {
    console.warn('ingestlab: worksheet detection failed:', String(e?.message || e).slice(0, 120));
  }
  try {
    blocks.push(...detectKvPanels(pageData, lines, ruledBboxes));
  } catch (e) {
    console.warn('ingestlab: kv-panel detection failed:', String(e?.message || e).slice(0, 120));
  }
  blocks.sort((a, b) => (a.bbox?.y0 ?? 0) - (b.bbox?.y0 ?? 0));
  const kept = [];
  for (const b of blocks) {
    if (!b.bbox) continue;
    const dup = kept.some(
      (k) =>
        overlapX(k.bbox.x0, k.bbox.x1, b.bbox.x0, b.bbox.x1) > 0.5 * Math.min(k.bbox.x1 - k.bbox.x0, b.bbox.x1 - b.bbox.x0) &&
        overlapX(k.bbox.y0, k.bbox.y1, b.bbox.y0, b.bbox.y1) > 0.5 * Math.min(k.bbox.y1 - k.bbox.y0, b.bbox.y1 - b.bbox.y0)
    );
    if (!dup) kept.push(b);
  }
  for (const b of kept) if (!blockText(b)) b.text = b.title || '';
  return kept;
}
