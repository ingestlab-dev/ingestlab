import { isMathLine } from './math.js';
import { looksLikeFormPage } from './forms.js';
import { groupLines } from './layout.js';

const CELL = 16;
const MERGE_GAP = 10;

export function isFigureCaption(text) {
  return /^(?:(?:figure|fig\.?|hình|sơ đồ|biểu đồ|chart|graph|diagram)\s+\d+(?:\.\d+)*(?:\s*\([^)]{1,60}\))?\s*[:.–-]|(?:fig\.|figure)\s+\d+(?:\.\d+)*\s+[A-Z])/iu.test(text.trim());
}

function captionedPanels(page) {
  const { words, fills = [], segments, width, height } = page;
  const frames = fills.filter((f) => f.isRect && f.bbox.x1 - f.bbox.x0 > width * 0.4).map((f) => f.bbox);
  if (!frames.length) return [];
  const used = new Set(), panels = [];
  const add = (bbox, caption, top, bottom) => {
    const labels = words.filter((w) => (w.x0 + w.x1) / 2 >= bbox.x0 &&
      (w.x0 + w.x1) / 2 <= bbox.x1 && w.y >= top && w.y < bottom);
    if (!labels.length || labels.length > 240) return;
    const rH = (segments?.h || []).filter((s) => s.pos >= top && s.pos < bottom && s.from >= bbox.x0 - 2 && s.to <= bbox.x1 + 2);
    const rV = (segments?.v || []).filter((s) => s.pos >= bbox.x0 && s.pos <= bbox.x1 && s.from >= top - 2 && s.to < bottom + 2);
    const kind = classify({ c: bbox, ink: rH.length + rV.length, area: 1, imgArea: 0, labels, hs: rH, vs: rV });
    used.add(bbox);
    panels.push({ ...bbox, kind, caption, labels, rH, rV, sourcePanel: true });
  };
  const lines = groupLines(words);
  for (const line of lines.filter((l) => isFigureCaption(l.text))) {
    const panel = frames.filter((b) => b.y1 - b.y0 > 50 && b.y1 - b.y0 < height * 0.55 &&
      !used.has(b) && line.x0 >= b.x0 - 3 && line.x1 <= b.x1 + 3 && line.y >= b.y1 - 32 && line.y <= b.y1 + 26
    ).sort((a, b) => Math.abs(a.y1 - line.y) - Math.abs(b.y1 - line.y))[0];
    if (panel) {
      const caption = wrappedCaption(lines, line, panel);
      add(panel, caption, panel.y0, line.y - line.size);
    }
  }
  // A level heading alone doesn't identify a figure.
  for (const line of lines.filter((l) => isPanelTitle(l.text))) {
    const card = frames.find((b) => !used.has(b) && b.x1 - b.x0 > width * 0.65 &&
      line.x0 >= b.x0 && line.y > b.y0 && line.y < b.y0 + 24 && b.y1 - b.y0 >= 95);
    if (!card) continue;
    const visual = frames.find((b) => b.x0 > card.x0 && b.x1 < card.x1 && b.x1 - b.x0 > width * 0.65 &&
      b.y0 > line.y + 12 && b.y0 < line.y + 40 && b.y1 <= card.y1 - 2 && b.y1 - b.y0 >= 65);
    if (!visual) continue;
    const caption = panelTitle(words, card, line.y, visual.y0);
    add(card, caption, visual.y0, visual.y1 + 1);
  }
  for (const { bbox, caption } of page.carriedPanels || []) add(bbox, caption, bbox.y0, bbox.y1);
  return panels;
}

function wrappedCaption(lines, first, panel) {
  const parts = [first.text];
  let last = first;
  const center = (line) => (line.x0 + line.x1) / 2;
  for (const line of lines.slice(lines.indexOf(first) + 1)) {
    if (line.y <= last.y || line.y - last.y > first.size * 1.65 || line.y > panel.y1 + 2 ||
        Math.abs(first.size - line.size) > first.size * 0.2 || line.x0 < panel.x0 - 3 || line.x1 > panel.x1 + 3 ||
        isFigureCaption(line.text) || isPanelTitle(line.text) ||
        (Math.abs(center(first) - center(line)) > 36 && Math.abs(first.x0 - line.x0) > 8)) break;
    parts.push(line.text);
    last = line;
  }
  return parts.join(' ');
}

const isPanelTitle = (s) => /^Level\s+\d+\s*[\u2013\u2014:-]\s+\p{L}/u.test(s);
const panelTitle = (words, frame, start, end) => groupLines(words.filter((w) =>
  w.y >= start - 3 && w.y < end - 3 && w.x0 >= frame.x0 &&
  w.x1 <= frame.x1 - Math.min(85, (frame.x1 - frame.x0) * 0.18))).map((l) => l.text).join(' ');

export function linkContinuedFigures(pages) {
  for (let i = 1; i < pages.length; i++) {
    const next = pages[i], prev = pages[i - 1];
    if (!next.fills?.length || !prev.fills?.length) continue;
    const frames = (page) => page.fills.filter((f) => f.isRect &&
      f.bbox.x1 - f.bbox.x0 > page.width * 0.7).map((f) => f.bbox);
    const previous = frames(prev);
    const previousLines = groupLines(prev.words);
    const prevCaptions = previousLines.filter((l) => isFigureCaption(l.text));
    const lines = groupLines(next.words);
    const nextFrames = frames(next);
    for (const frame of nextFrames.filter((f) => f.y0 < next.height * 0.12)) {
      const sameWidth = (b) => Math.abs(b.x0 - frame.x0) < 3 && Math.abs(b.x1 - frame.x1) < 3;
      if (frame.y1 - frame.y0 >= 15 && frame.y1 - frame.y0 <= 43) {
        const title = lines.find((l) => l.y >= frame.y0 && l.y <= frame.y1 && isFigureCaption(l.text));
        if (!title) continue;
        const bbox = previous.find((b) => sameWidth(b) && b.y1 > prev.height * 0.82 && b.y1 - b.y0 >= 80 &&
          !prevCaptions.some((l) => l.y >= b.y0 && l.y <= b.y1 + 6));
        if (bbox && prev.words.some((w) => w.y > bbox.y0 + 15 && w.y < bbox.y1 - 8)) {
          (prev.carriedPanels ||= []).push({ bbox, caption: wrappedCaption(lines, title, frame) });
        }
      } else if (frame.y1 - frame.y0 >= 90 &&
        !lines.some((l) => l.y > frame.y0 && l.y < frame.y0 + 27 && isPanelTitle(l.text)) &&
        nextFrames.some((b) => b.x0 > frame.x0 && b.x1 < frame.x1 && b.y0 > frame.y0 &&
          b.y0 < frame.y0 + 25 && b.y1 <= frame.y1 - 2 && b.y1 > frame.y1 - 20)) {
        const header = previous.find((b) => sameWidth(b) && b.y1 - b.y0 >= 24 && b.y1 - b.y0 <= 57 &&
          b.y0 > prev.height * 0.68 && previousLines.some((l) => l.y > b.y0 && l.y < b.y0 + 24 && isPanelTitle(l.text)));
        if (!header) continue;
        const title = previousLines.find((l) => l.y > header.y0 && l.y < header.y0 + 24 && isPanelTitle(l.text));
        (next.carriedPanels ||= []).push({ bbox: frame, caption: panelTitle(prev.words, header, title.y, header.y1) });
      }
    }
  }
}

// Split paired charts by their own axes even when they share a frame.
export function findParallelPanels(page) {
  const frames = (page.fills || []).filter(({ isRect, bbox: b }) => isRect &&
    b.x1 - b.x0 >= page.width * 0.29 && b.x1 - b.x0 <= page.width * 0.48 &&
    b.y1 - b.y0 >= 72 && b.y1 - b.y0 <= 200).map(({ bbox }) => bbox);
  const panels = [];
  const title = (b) => groupLines(page.words.filter((w) => w.x0 >= b.x0 && w.x1 <= b.x1 &&
    w.y > b.y0 + 5 && w.y < b.y0 + 19).map((w) => ({ ...w })))[0]?.text;
  for (const a of frames) {
    const first = title(a);
    if (!/^A\.\s/.test(first || '')) continue;
    const b = frames.find((p) => p.x0 > a.x1 && p.x0 - a.x1 < 24 &&
      Math.abs(a.y0 - p.y0) <= 2 && Math.abs(a.y1 - p.y1) <= 2 && /^B\.\s/.test(title(p) || ''));
    if (!b) continue;
    for (const panel of [a, b]) panels.push({
      ...panel, kind: 'diagram', caption: title(panel), sourcePanel: true, standalonePanel: true,
      labels: page.words.filter((w) => w.x0 >= panel.x0 && w.x1 <= panel.x1 && w.y >= panel.y0 && w.y <= panel.y1),
      rH: (page.segments?.h || []).filter((s) => s.pos >= panel.y0 && s.pos <= panel.y1 && s.from >= panel.x0 && s.to <= panel.x1),
      rV: (page.segments?.v || []).filter((s) => s.pos >= panel.x0 && s.pos <= panel.x1 && s.from >= panel.y0 && s.to <= panel.y1),
    });
  }
  return panels;
}

export function findFigureRegions(page, ruledBboxes = [], opts = {}) {
  const maxPerPage = opts.maxPerPage ?? Infinity;
  const { width: W, height: H, words = [], drawPts, images = [], segments, rotated = [] } = page;
  if ((!drawPts || drawPts.length < 16) && images.length === 0) return [];

  const panels = captionedPanels(page);
  if (looksLikeFormPage(page)) return panels.slice(0, maxPerPage);

  const cols = Math.max(1, Math.ceil(W / CELL));
  const rows = Math.max(1, Math.ceil(H / CELL));
  const drawCount = new Uint16Array(cols * rows);
  const wordCount = new Uint16Array(cols * rows);
  const imageMark = new Uint8Array(cols * rows);

  for (let i = 0; i + 1 < drawPts.length; i += 2) {
    const cx = Math.floor(drawPts[i] / CELL);
    const cy = Math.floor(drawPts[i + 1] / CELL);
    if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) drawCount[cy * cols + cx]++;
  }
  for (const w of words) {
    const cx = Math.floor(((w.x0 + w.x1) / 2) / CELL);
    const cy = Math.floor(w.y / CELL);
    if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) wordCount[cy * cols + cx]++;
  }

  const overlap = (a, b) => {
    const ox = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
    const oy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    return (ox * oy) / Math.max(1, (a.x1 - a.x0) * (a.y1 - a.y0));
  };
  // Don't classify audit stamps and signature overlays as figures.
  const isStamp = (im) => {
    const w = im.x1 - im.x0;
    const h = im.y1 - im.y0;
    if (w > 150 || h > 150) return false;
    const ar = Math.min(w, h) / Math.max(w, h);
    const bottomZone = im.y1 > 0.72 * H;
    const onTable = ruledBboxes.some((rb) => overlap(im, rb) > 0.3);
    return ar > 0.55 && (onTable || (bottomZone && ar > 0.7));
  };

  const pageArea = W * H;
  for (const im of images) {
    const area = (im.x1 - im.x0) * (im.y1 - im.y0);
    if (area > 0.85 * pageArea) continue;
    if (isStamp(im)) continue;
    const x0 = Math.max(0, Math.floor(im.x0 / CELL));
    const x1 = Math.min(cols - 1, Math.floor(im.x1 / CELL));
    const y0 = Math.max(0, Math.floor(im.y0 / CELL));
    const y1 = Math.min(rows - 1, Math.floor(im.y1 / CELL));
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) imageMark[cy * cols + cx] = 1;
  }

  // neighborhood sums (3x3): ink density vs word density
  const blur = (grid) => {
    const out = new Uint16Array(cols * rows);
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx >= 0 && nx < cols && ny >= 0 && ny < rows) sum += grid[ny * cols + nx];
          }
        }
        out[cy * cols + cx] = sum;
      }
    }
    return out;
  };
  const drawBlur = blur(drawCount);
  const wordBlur = blur(wordCount);

  // Labels overlap drawings, so text counts alone can't separate figures from prose.
  const isFigureCell = (cx, cy) => {
    const k = cy * cols + cx;
    const px = cx * CELL;
    const py = cy * CELL;
    if (px < 24 || px > W - 24 || py < 36 || py > H - 30) return false;
    if (imageMark[k] === 1) return true;
    if (drawCount[k] < 3) return false;
    return wordBlur[k] <= 0.9 * drawBlur[k] + 5;
  };

  // connected components over figure cells (8-conn)
  const seen = new Uint8Array(cols * rows);
  const comps = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const k = cy * cols + cx;
      if (seen[k] || !isFigureCell(cx, cy)) continue;
      const stack = [[cx, cy]];
      seen[k] = 1;
      let x0 = cx, x1 = cx, y0 = cy, y1 = cy;
      while (stack.length) {
        const [px, py] = stack.pop();
        x0 = Math.min(x0, px); x1 = Math.max(x1, px);
        y0 = Math.min(y0, py); y1 = Math.max(y1, py);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx, ny = py + dy;
            if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
            const nk = ny * cols + nx;
            if (seen[nk] || !isFigureCell(nx, ny)) continue;
            seen[nk] = 1;
            stack.push([nx, ny]);
          }
        }
      }
      comps.push({
        x0: x0 * CELL, y0: y0 * CELL,
        x1: (x1 + 1) * CELL, y1: (y1 + 1) * CELL,
      });
    }
  }

  // Join nearby components so one schematic isn't split at small gaps.
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < comps.length; i++) {
      for (let j = i + 1; j < comps.length; j++) {
        const a = comps[i], b = comps[j];
        const dx = Math.max(a.x0 - b.x1, b.x0 - a.x1, 0);
        const dy = Math.max(a.y0 - b.y1, b.y0 - a.y1, 0);
        if (Math.max(dx, dy) <= MERGE_GAP) {
          comps[i] = {
            x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
            x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
          };
          comps.splice(j, 1);
          merged = true;
          break;
        }
      }
      if (merged) break;
    }
  }

  const splitPanels = (box, depth) => {
    const cx0 = Math.max(0, Math.floor(box.x0 / CELL));
    const cx1 = Math.min(cols - 1, Math.floor((box.x1 - 0.1) / CELL));
    const cy0 = Math.max(0, Math.floor(box.y0 / CELL));
    const cy1 = Math.min(rows - 1, Math.floor((box.y1 - 0.1) / CELL));
    const colInk = (cx) => {
      let n = 0;
      for (let cy = cy0; cy <= cy1; cy++) n += drawCount[cy * cols + cx] + (imageMark[cy * cols + cx] ? 2 : 0);
      return n;
    };
    const rowInk = (cy) => {
      let n = 0;
      for (let cx = cx0; cx <= cx1; cx++) n += drawCount[cy * cols + cx] + (imageMark[cy * cols + cx] ? 2 : 0);
      return n;
    };
    for (let cx = cx0 + 1; cx < cx1; cx++) {
      if (colInk(cx) === 0 && colInk(cx + 1) === 0 && cx + 1 < cx1) {
        const cut = (cx + 1.5) * CELL;
        const left = { x0: box.x0, y0: box.y0, x1: cut - 4, y1: box.y1 };
        const right = { x0: cut + 4, y0: box.y0, x1: box.x1, y1: box.y1 };
        if (okPanel(left) && okPanel(right)) {
          return depth < 2
            ? [...splitPanels(left, depth + 1), ...splitPanels(right, depth + 1)]
            : [left, right];
        }
      }
    }
    for (let cy = cy0 + 1; cy < cy1; cy++) {
      if (rowInk(cy) === 0 && rowInk(cy + 1) === 0 && cy + 1 < cy1) {
        const cut = (cy + 1.5) * CELL;
        const top = { x0: box.x0, y0: box.y0, x1: box.x1, y1: cut - 4 };
        const bot = { x0: box.x0, y0: cut + 4, x1: box.x1, y1: box.y1 };
        if (okPanel(top) && okPanel(bot)) {
          return depth < 2
            ? [...splitPanels(top, depth + 1), ...splitPanels(bot, depth + 1)]
            : [top, bot];
        }
      }
    }
    return [box];
  };
  const okPanel = (b) => {
    const w = b.x1 - b.x0;
    const h = b.y1 - b.y0;
    if (w < 80 || h < 50) return false;
    let ink = 0;
    for (let cy = Math.max(0, Math.floor(b.y0 / CELL)); cy <= Math.min(rows - 1, Math.floor((b.y1 - 0.1) / CELL)); cy++) {
      for (let cx = Math.max(0, Math.floor(b.x0 / CELL)); cx <= Math.min(cols - 1, Math.floor((b.x1 - 0.1) / CELL)); cx++) {
        ink += drawCount[cy * cols + cx];
      }
    }
    return ink >= 12;
  };

  const hs = segments?.h ?? [];
  const vs = segments?.v ?? [];

  const regions = [];
  for (let c0 of comps) {
    const panels = splitPanels(c0, 0);
    for (let c of panels) {
      const w = c.x1 - c.x0;
      const h = c.y1 - c.y0;
      if (w < 60 || h < 45) continue;
      if (w > 0.92 * W && h > 0.92 * H) continue;
      const area = w * h;

      let ink = 0;
      if (drawPts) {
        for (let i = 0; i + 1 < drawPts.length; i += 2) {
          if (drawPts[i] >= c.x0 && drawPts[i] <= c.x1 && drawPts[i + 1] >= c.y0 && drawPts[i + 1] <= c.y1) ink++;
        }
      }
      let imgArea = 0;
      for (const im of images) {
        if (isStamp(im)) continue;
        const ox = Math.max(0, Math.min(c.x1, im.x1) - Math.max(c.x0, im.x0));
        const oy = Math.max(0, Math.min(c.y1, im.y1) - Math.max(c.y0, im.y0));
        imgArea += ox * oy;
      }
      if (imgArea < 0.25 * area && ink < 8) continue;

      let ruledOverlap = 0;
      for (const rb of ruledBboxes) {
        ruledOverlap = Math.max(ruledOverlap, overlap(c, rb));
      }
      if (ruledOverlap > 0.35) continue;

      let wc = 0;
      const labels = [];
      for (const word of words) {
        const cx = (word.x0 + word.x1) / 2;
        if (cx >= c.x0 && cx <= c.x1 && word.y >= c.y0 && word.y <= c.y1) {
          wc++;
          if (labels.length < 120) labels.push(word);
        }
      }
      if (wc > Math.max(30, area / 750)) continue;

      let tx0 = Infinity, ty0 = Infinity, tx1 = -Infinity, ty1 = -Infinity;
      if (drawPts) {
        for (let i = 0; i + 1 < drawPts.length; i += 2) {
          if (drawPts[i] >= c.x0 - 2 && drawPts[i] <= c.x1 + 2 && drawPts[i + 1] >= c.y0 - 2 && drawPts[i + 1] <= c.y1 + 2) {
            tx0 = Math.min(tx0, drawPts[i]); tx1 = Math.max(tx1, drawPts[i]);
            ty0 = Math.min(ty0, drawPts[i + 1]); ty1 = Math.max(ty1, drawPts[i + 1]);
          }
        }
      }
      for (const im of images) {
        if (isStamp(im)) continue;
        const imx = (im.x0 + im.x1) / 2;
        const imy = (im.y0 + im.y1) / 2;
        if (imx >= c.x0 && imx <= c.x1 && imy >= c.y0 && imy <= c.y1) {
          tx0 = Math.min(tx0, im.x0); tx1 = Math.max(tx1, im.x1);
          ty0 = Math.min(ty0, im.y0); ty1 = Math.max(ty1, im.y1);
        }
      }
      if (Number.isFinite(tx0)) {
        c = {
          x0: Math.max(c.x0, tx0 - 8), y0: Math.max(c.y0, ty0 - 8),
          x1: Math.min(c.x1, tx1 + 8), y1: Math.min(c.y1, ty1 + 8),
        };
      }

      const kind = classify({ c, ink, imgArea, area, labels, hs, vs });
      const verticalEvidence = vs.some((segment) => segment.to - segment.from > 0.2 * (c.y1 - c.y0));
      if (kind === 'schematic' && !verticalEvidence && labels.length > 50) continue;
      const rH = hs.filter((sg) => sg.pos >= c.y0 - 2 && sg.pos <= c.y1 + 2 && sg.to - sg.from >= 16);
      const rV = vs.filter((sg) => sg.pos >= c.x0 - 2 && sg.pos <= c.x1 + 2 && sg.to - sg.from >= 16);
      const rotatedLabels = rotated
        .filter((r) => r.x0 + r.x1 >= 2 * c.x0 - 30 && r.x0 + r.x1 <= 2 * c.x1 + 30 && r.y >= c.y0 - 10 && r.y <= c.y1 + 10)
        .slice(0, 8);
      regions.push({ ...c, kind, labels, rotatedLabels, rH, rV });
    }
  }

  regions.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
  return [...panels, ...regions.filter((r) => !panels.some((p) => overlap(r, p) > 0.35))].slice(0, maxPerPage);
}

function classify({ c, ink, imgArea, area, labels, hs, vs }) {
  const rw = c.x1 - c.x0;
  const rh = c.y1 - c.y0;
  const longV = vs.some((s) => s.to - s.from > 0.5 * rh && s.pos >= c.x0 - 4 && s.pos <= c.x1 + 4);
  const longH = hs.some((s) => s.to - s.from > 0.5 * rw && s.pos >= c.y0 - 4 && s.pos <= c.y1 + 4);
  const numeric = labels.filter((l) => /^[\d.,%+\-µμkKmM°]{1,7}$/.test(l.str.trim())).length;
  if ((longV || longH) && numeric >= 5) return 'chart';
  if (imgArea > 0.45 * area && ink < 40) return 'photo';
  const midH = hs.filter((s) => s.to - s.from >= 30 && s.to - s.from <= 0.85 * rw).length;
  const midV = vs.filter((s) => s.to - s.from >= 30 && s.to - s.from <= 0.85 * rh).length;
  if (ink < 260 && midH + midV >= 4 && labels.length <= 26) return 'diagram';
  return 'schematic';
}

export function trimFloatingText(region, lines, drawPts, opts = {}) {
  let inkY0 = Infinity, inkY1 = -Infinity, inkX0 = Infinity, inkX1 = -Infinity;
  if (drawPts) {
    for (let i = 0; i + 1 < drawPts.length; i += 2) {
      if (drawPts[i] >= region.x0 - 2 && drawPts[i] <= region.x1 + 2 && drawPts[i + 1] >= region.y0 - 2 && drawPts[i + 1] <= region.y1 + 2) {
        inkY0 = Math.min(inkY0, drawPts[i + 1]); inkY1 = Math.max(inkY1, drawPts[i + 1]);
        inkX0 = Math.min(inkX0, drawPts[i]); inkX1 = Math.max(inkX1, drawPts[i]);
      }
    }
  }
  if (!Number.isFinite(inkY0)) return { x0: region.x0, y0: region.y0, x1: region.x1, y1: region.y1 };
  const box = {
    x0: Math.max(region.x0, inkX0 - 10),
    y0: Math.max(region.y0, inkY0 - 10),
    x1: Math.min(region.x1, inkX1 + 10),
    y1: Math.min(region.y1, inkY1 + 10),
  };
  const H = opts.pageH ?? region.y1 + 200;
  const nearCaptionY = (y) => Math.abs(y - (inkY1 + 14)) < 14 || Math.abs(y - (inkY0 - 14)) < 14;
  const blockedByRule = (wx0, wy, wx1) => {
    const hs = opts.segments?.h || [];
    const vs = opts.segments?.v || [];
    // A horizontal rule can separate a table label from the figure.
    for (const s of hs) {
      if (s.to - s.from < 0.5 * (inkX1 - inkX0)) continue;
      const midY = (wy + (wy < inkY0 ? inkY0 : inkY1)) / 2;
      if (s.pos > Math.min(wy, midY) && s.pos < Math.max(wy, midY) && s.from <= wx1 && s.to >= wx0) return true;
    }
    for (const s of vs) {
      if (s.to - s.from < 0.5 * (inkY1 - inkY0)) continue;
      const midX = (wx0 + wx1 + (wx0 > inkX1 ? inkX1 - wx0 : inkX0 - wx1)) / 2;
      if (s.pos > Math.min(wx0, midX) && s.pos < Math.max(wx1, midX) && s.pos > wx0 && s.pos < wx1) return true;
    }
    return false;
  };
  const isMathWord = new Set((lines || []).filter((l) => isMathLine(l)).flatMap((l) => l.words || []));
  for (const l of lines || []) {
    if (l.text && l.text.trim().length > 60) continue;
    for (const w of l.words || []) {
      const cx = (w.x0 + w.x1) / 2;
      const insideInk = cx >= inkX0 - 4 && cx <= inkX1 + 4 && w.y >= inkY0 - 4 && w.y <= inkY1 + 4;
      if (insideInk || isMathWord.has(w)) continue;
      const dx = Math.max(inkX0 - cx, cx - inkX1, 0);
      const dy = Math.max(inkY0 - w.y, w.y - inkY1, 0);
      if (Math.hypot(dx, dy) > 28) continue;
      if (w.y < 40 || w.y > H - 34) continue;
      if (nearCaptionY(w.y)) continue;
      if (blockedByRule(w.x0, w.y, w.x1)) continue;
      box.x0 = Math.min(box.x0, w.x0 - 6);
      box.x1 = Math.max(box.x1, w.x1 + 6);
      box.y0 = Math.min(box.y0, w.y - w.size - 4);
      box.y1 = Math.max(box.y1, w.y + 4);
    }
  }
  if (box.x1 - box.x0 < 60 || box.y1 - box.y0 < 45) {
    return { x0: region.x0, y0: region.y0, x1: region.x1, y1: region.y1 };
  }
  return box;
}

const CAPTION_RE = /^(figure|fig\.?|hình|sơ đồ|biểu đồ|chart|graph|diagram|vẽ)\b/i;

export function figureCaption(lines, region) {
  let prefixed = null;
  let titled = null;
  let bestDist = Infinity;
  let bestTitleDist = Infinity;
  for (const l of lines) {
    const t = l.text.trim();
    if (!t || t.length > 110 || /^\d{1,4}$/.test(t)) continue;
    const below = l.y >= region.y1 - 2 && l.y <= region.y1 + 26;
    const above = l.y <= region.y0 + 2 && l.y >= region.y0 - 26;
    if (!below && !above) continue;
    const overlap = Math.min(l.x1, region.x1) - Math.max(l.x0, region.x0);
    if (overlap < 0.35 * (region.x1 - region.x0)) continue;
    const dist = below ? l.y - region.y1 : region.y0 - l.y;
    if (CAPTION_RE.test(t)) {
      if (dist < bestDist) {
        bestDist = dist;
        prefixed = t;
      }
    } else if (/^[A-Z0-9"“(]/.test(t)) {
      if (t.split(/\s+/).length <= 14 && dist < bestTitleDist) {
        bestTitleDist = dist;
        titled = t;
      }
    }
  }
  return prefixed || titled || null;
}

export function figureMetadata(lines, region) {
  if (!['chart', 'schematic', 'gauge', 'circuit', 'timing', 'pinout'].includes(region.kind) && !region.kind2) return null;
  const yLabel = (region.rotatedLabels || []).map((r) => r.str.trim()).filter(Boolean).join(' ');
  let xLabel = null;
  for (const l of lines) {
    const t = l.text.trim();
    if (!t || t.length > 60 || /^\d{1,4}$/.test(t)) continue;
    if (l.y >= region.y1 && l.y <= region.y1 + 16) {
      const overlap = Math.min(l.x1, region.x1) - Math.max(l.x0, region.x0);
      if (overlap > 0.3 * (region.x1 - region.x0) && !CAPTION_RE.test(t)) xLabel = t;
    }
  }
  const series = [];
  const ticks = [];
  for (const w of region.labels || []) {
    const t = w.str.trim();
    if (!t) continue;
    if (/^[\d.,%+\-−µμ°]{1,8}$/.test(t) || /^(\d+[kKmM]|[\d.]+(p|n|u|µ|k|M)(F|A|V|Hz))$/.test(t)) {
      if (ticks.length < 24) ticks.push(t);
    } else if (/^[A-Za-z][A-Za-z0-9_\-=<>/ ]{1,22}$/.test(t) && !series.includes(t)) {
      series.push(t);
    }
  }
  if (!yLabel && !xLabel && series.length === 0 && ticks.length === 0) return null;
  return {
    kind: region.kind2 || region.kind,
    yLabel: yLabel || null,
    xLabel,
    series: series.slice(0, 8),
    ticks,
  };
}



export function diagramMermaid(region) {
  if (region.kind !== 'diagram') return null;
  const clusters = [];
  for (const w of region.labels || []) {
    let placed = false;
    for (const b of clusters) {
      if (Math.abs(w.x0 - b.cx) < 60 && Math.abs(w.y - b.cy) < 20) {
        b.texts.push(w.str);
        b.n++;
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ cx: w.x0, cy: w.y, texts: [w.str], n: 1 });
  }
  const nodes = clusters
    .filter((b) => b.n >= 1)
    .slice(0, 8)
    .map((b) => ({
      ...b,
      box: { x0: b.cx - 58, y0: b.cy - 18, x1: b.cx + 58, y1: b.cy + 18 },
    }));
  if (nodes.length < 2) return null;
  const label = (n) =>
    n.texts
      .join(' ')
      .replace(/["`|<>{}\[\]\\]/g, '')
      .slice(0, 40)
      .trim() || 'node';
  const near = (x, y, b) => x >= b.x0 - 8 && x <= b.x1 + 8 && y >= b.y0 - 8 && y <= b.y1 + 8;
  // Require a drawn stroke between nodes before emitting an edge.
  const strokes = [];
  for (const sg of region.rH || []) strokes.push([sg.from, sg.pos, sg.to, sg.pos]);
  for (const sg of region.rV || []) strokes.push([sg.pos, sg.from, sg.pos, sg.to]);
  const edges = [];
  for (const [x1, y1, x2, y2] of strokes) {
    const a = nodes.findIndex((n) => near(x1, y1, n.box));
    const b = nodes.findIndex((n) => near(x2, y2, n.box));
    if (a === b || a < 0 || b < 0) continue;
    if (edges.some(([p, q]) => (p === a && q === b) || (p === b && q === a))) continue;
    edges.push([a, b]);
    if (edges.length >= 12) break;
  }
  // Sequence diagrams have at least three parallel lifelines with
  // horizontal strokes joining DISTINCT lifelines — emit sequenceDiagram
  const vsegs = region.rV || [];
  const hsegs = region.rH || [];
  if (vsegs.length >= 3 && hsegs.length >= 2) {
    const ys0 = Math.min(...vsegs.map((sg) => sg.from));
    const ys1 = Math.max(...vsegs.map((sg) => sg.to));
    const tall = vsegs
      .filter((sg) => sg.to - sg.from >= 0.45 * (ys1 - ys0))
      .sort((a, b) => a.pos - b.pos);
    const lifelines = [];
    for (const sg of tall) {
      const last = lifelines[lifelines.length - 1];
      if (last && sg.pos - last.pos < 14) last.pos = (last.pos + sg.pos) / 2;
      else lifelines.push({ pos: sg.pos });
    }
    if (lifelines.length >= 3 && lifelines.length <= 8) {
      const msgs = [];
      for (const hs of hsegs) {
        const from = Math.min(hs.from, hs.to);
        const to = Math.max(hs.from, hs.to);
        if (to - from < 40) continue;
        const a = lifelines.findIndex((l) => Math.abs(l.pos - from) <= 25);
        const b = lifelines.findIndex((l) => Math.abs(l.pos - to) <= 25);
        if (a < 0 || b < 0 || a === b) continue;
        if (msgs.some(([p2, q2]) => (p2 === a && q2 === b) || (p2 === b && q2 === a))) continue;
        msgs.push([a, b, hs.pos]);
        if (msgs.length >= 12) break;
      }
      if (msgs.length >= 2) {
        const name = (i) => {
          const cand = clusters
            .slice()
            .sort((p2, q2) => Math.abs(p2.cx - lifelines[i].pos) - Math.abs(q2.cx - lifelines[i].pos))[0];
          return cand ? label({ texts: cand.texts }) : `P${i}`;
        };
        const out2 = ['sequenceDiagram'];
        lifelines.forEach((l, i) => out2.push(`  participant P${i} as ${name(i)}`));
        msgs
          .sort((p2, q2) => p2[2] - q2[2])
          .forEach(([a, b]) => out2.push(`  P${a}->>P${b}: msg`));
        return out2.join('\n') + '\n';
      }
    }
  }
  const lines = ['flowchart LR'];
  nodes.forEach((n, i) => lines.push(`  N${i}["${label(n)}"]`));
  for (const [a, b] of edges) lines.push(`  N${a} --> N${b}`);
  return lines.join('\n') + '\n';
}
