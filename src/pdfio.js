import { remapGlyphs } from './math.js';
import { dedupFauxBold } from './spans.js';

// Some PDFs draw checkbox edges as separate strokes.
function detectSquareBoxes(seg, tol = 3) {
  const H = seg.h || [];
  const V = seg.v || [];
  const diags = seg.diags || [];
  const out = [];
  const used = new Set();
  for (let i = 0; i < H.length; i++) {
    for (let j = i + 1; j < H.length; j++) {
      const a = H[i];
      const b = H[j];
      const dy = Math.abs(a.pos - b.pos);
      if (dy < 5 || dy > 20) continue;
      const x0 = Math.max(Math.min(a.from, a.to), Math.min(b.from, b.to));
      const x1 = Math.min(Math.max(a.from, a.to), Math.max(b.from, b.to));
      const w = x1 - x0;
      if (w < 5 || w > 20 || w / dy < 0.6 || dy / w > 1.6) continue;
      const y0 = Math.min(a.pos, b.pos);
      const y1 = Math.max(a.pos, b.pos);
      const closes = (s) => Math.abs(s.pos - x0) <= tol && s.from <= y0 + tol && s.to >= y1 - tol;
      const closesR = (s) => Math.abs(s.pos - x1) <= tol && s.from <= y0 + tol && s.to >= y1 - tol;
      if (!V.some(closes) || !V.some(closesR)) continue;
      const key = `${Math.round(x0)}:${Math.round(y0)}`;
      if (used.has(key)) continue;
      used.add(key);
      const insideH = H.some((sg) => sg !== a && sg !== b && sg.pos > y0 + 1.2 && sg.pos < y1 - 1.2 && sg.from >= x0 - 1 && sg.to <= x1 + 1);
      const insideV = V.some((sg) => sg.pos > x0 + 1.2 && sg.pos < x1 - 1.2 && sg.from >= y0 - 1 && sg.to <= y1 + 1);
      const insideD = diags.some((d) => d[0] >= x0 && d[0] <= x1 && d[1] >= y0 && d[1] <= y1);
      out.push({ type: 'checkbox', checked: insideH || insideV || insideD, bbox: { x0, y0, x1, y1 } });
    }
  }
  // Multiple edge pairs can describe the same checkbox.
  const uniq = [];
  for (const b of out) {
    const cx = (b.bbox.x0 + b.bbox.x1) / 2;
    const cy = (b.bbox.y0 + b.bbox.y1) / 2;
    if (uniq.some((u) => Math.abs((u.bbox.x0 + u.bbox.x1) / 2 - cx) < 4 && Math.abs((u.bbox.y0 + u.bbox.y1) / 2 - cy) < 4)) continue;
    uniq.push(b);
  }
  return uniq;
}


/** Resolve a pdf.js entry point: injected global first, then the npm peer. */
export async function loadPdfjs() {
  if (globalThis.pdfjsLib) return globalThis.pdfjsLib;
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    if (typeof window !== 'undefined' && !pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc =
        `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/legacy/build/pdf.worker.min.mjs`;
    }
    return pdfjs;
  } catch {
    throw new Error(
      'IngestLab needs pdf.js — pass { pdfjs } to IngestLab.init(), set globalThis.pdfjsLib, or install the pdfjs-dist peer'
    );
  }
}

// Copy the bytes before PDF.js transfers the buffer to its worker.
export async function openDocument(bytes, opts = {}) {
  const pdfjs = opts.pdfjsModule || await loadPdfjs();
  const docOpts = { ...opts.docOpts, data: bytes.slice() };
  if (opts.pdfjs) Object.assign(docOpts, opts.pdfjs);
  const isNode = typeof process !== 'undefined' && !!process.versions?.node;
  if (!docOpts.standardFontDataUrl) {
    // Base 14 fonts need PDF.js's standard font data.
    try {
      const { createRequire } = await import('node:module');
      const req = createRequire(import.meta.url);
      const pkgPath = req.resolve('pdfjs-dist/package.json');
      const path = await import('node:path');
      const dir = path.join(path.dirname(pkgPath), 'standard_fonts');
      // The Node font factory expects a filesystem path, not a URL.
      docOpts.standardFontDataUrl = isNode ? dir + path.sep : new URL(`file://${dir}/`).href;
    } catch {
    }
  }
  if (!docOpts.wasmUrl) {
    // PDF.js needs its WASM files to decode some scanned images.
    if (isNode) {
      try {
        const { createRequire } = await import('node:module');
        const req = createRequire(import.meta.url);
        const pkgPath = req.resolve('pdfjs-dist/package.json');
        const path = await import('node:path');
        docOpts.wasmUrl = path.join(path.dirname(pkgPath), 'wasm') + path.sep;
      } catch {
      }
    } else if (pdfjs.GlobalWorkerOptions?.workerSrc) {
      docOpts.wasmUrl = pdfjs.GlobalWorkerOptions.workerSrc.replace(/build\/[^/]+$/, 'wasm/');
    }
  }
  if (pdfjs.GlobalWorkerOptions?.workerSrc?.includes('/build/')) {
    const worker = pdfjs.GlobalWorkerOptions.workerSrc;
    docOpts.cMapUrl ??= worker.replace(/build\/[^/]+$/, 'cmaps/');
    docOpts.standardFontDataUrl ??= worker.replace(/build\/[^/]+$/, 'standard_fonts/');
    docOpts.iccUrl ??= worker.replace(/build\/[^/]+$/, 'iccs/');
  }
  const task = pdfjs.getDocument(docOpts);
  const doc = await task.promise;
  return { doc, pdfjs, task };
}


const NARROW = "iljtI.,:;'\"|!()[]{}-";
const WIDE = 'mwMW';

function charWeight(ch) {
  if (NARROW.includes(ch)) return 0.34;
  if (WIDE.includes(ch)) return 1.6;
  if (/[A-Z0-9@#%&$]/.test(ch)) return 0.72;
  return 0.5;
}

const CHAR_W = new Map();
function weightOf(ch) {
  let w = CHAR_W.get(ch);
  if (w === undefined) {
    w = charWeight(ch);
    CHAR_W.set(ch, w);
  }
  return w;
}

// Map private-use Symbol glyphs back to readable characters.
const PUA_GLYPHS = new Map([
  [0xf061, 'α'], [0xf062, 'β'], [0xf064, 'δ'], [0xf065, 'ε'], [0xf067, 'γ'],
  [0xf06c, 'λ'], [0xf06d, 'μ'], [0xf070, 'π'], [0xf072, 'ρ'], [0xf073, 'σ'],
  [0xf074, 'τ'], [0xf077, 'ω'], [0xf044, '∆'], [0xf053, 'Σ'], [0xf057, 'Ω'],
  [0xf0ae, 'Ω'], [0xf0b5, 'μ'],
  [0xf0a3, '≤'], [0xf0b3, '≥'], [0xf0b9, '≠'], [0xf0bb, '≈'],
  [0xf0b1, '±'], [0xf0b4, '×'], [0xf0b8, '÷'], [0xf0d6, '√'],
  [0xf0b0, '°'], [0xf0a5, '∞'], [0xf0b7, '•'],
]);

export function normalizeGlyphs(str) {
  let out = '';
  let changed = false;
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (PUA_GLYPHS.has(c)) {
      out += PUA_GLYPHS.get(c);
      changed = true;
    } else if (c >= 0xe000 && c <= 0xf8ff) {
      changed = true;
    } else {
      out += ch;
    }
  }
  return changed ? out : str;
}

function splitItem(item, tx, styles) {
  const size = Math.hypot(tx[2], tx[3]) || item.height || 10;
  const style = styles[item.fontName] || {};
  const mono = style.fontFamily === 'monospace';
  const font = String(style.fontFamily || '');
  const str = remapGlyphs(normalizeGlyphs(item.str), font);
  const total = [...str].reduce((s, ch) => s + weightOf(ch), 0);
  const unit = total > 0 && item.width > 0 ? item.width / total : 0;
  const words = [];
  const chars = [...str];
  let acc = 0;
  for (let i = 0; i < chars.length; ) {
    const ch = chars[i];
    if (/\s/.test(ch)) {
      acc += weightOf(ch);
      i++;
      continue;
    }
    const start = acc;
    let j = i;
    let w = 0;
    while (j < chars.length && !/\s/.test(chars[j])) {
      w += weightOf(chars[j]);
      j++;
    }
    words.push({
      str: chars.slice(i, j).join(''),
      x0: tx[4] + start * unit,
      x1: tx[4] + (start + w) * unit,
      y: tx[5],
      size,
      mono,
      font,
    });
    acc = start + w;
    i = j;
  }
  return words;
}


const hex2 = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');

export function grayToHex(g) {
  const v = hex2(Array.isArray(g) ? g[0] : g);
  return `#${v}${v}${v}`;
}

export function rgbToHex(r, g, b) {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

export function cmykToHex(c, m, y, k) {
  return rgbToHex((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));
}


// Fit a circle to a flat [x, y, ...] polyline using the Kasa method.
export function fitCircle(pts) {
  const n = pts.length / 2;
  if (n < 6) return null;
  let Sxx = 0, Sxy = 0, Syy = 0, Sx = 0, Sy = 0, Sxz = 0, Syz = 0, Sz = 0;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = pts[i];
    const y = pts[i + 1];
    const z = x * x + y * y;
    Sxx += x * x; Sxy += x * y; Syy += y * y;
    Sx += x; Sy += y;
    Sxz += x * z; Syz += y * z; Sz += z;
  }
  // Solve M·u = v with M = [[Sxx,Sxy,Sx],[Sxy,Syy,Sy],[Sx,Sy,n]], v = [Sxz,Syz,Sz]
  const m11 = Sxx, m12 = Sxy, m13 = Sx, m22 = Syy, m23 = Sy, m33 = n;
  const det = m11 * (m22 * m33 - m23 * m23) - m12 * (m12 * m33 - m23 * m13) + m13 * (m12 * m23 - m22 * m13);
  if (Math.abs(det) < 1e-9) return null;
  const v1 = Sxz, v2 = Syz, v3 = Sz;
  const a =
    (v1 * (m22 * m33 - m23 * m23) - m12 * (v2 * m33 - m23 * v3) + m13 * (v2 * m23 - m22 * v3)) / det;
  const b =
    (m11 * (v2 * m33 - m23 * v3) - v1 * (m12 * m33 - m23 * m13) + m13 * (m12 * v3 - v2 * m13)) / det;
  const c =
    (m11 * (m22 * v3 - v2 * m23) - m12 * (m12 * v3 - v2 * m13) + v1 * (m12 * m23 - m22 * m13)) / det;
  const cx = a / 2;
  const cy = b / 2;
  const r2 = c + cx * cx + cy * cy;
  if (!(r2 > 1e-6)) return null;
  const r = Math.sqrt(r2);
  if (!Number.isFinite(r) || r > 1e5) return null;
  let err = 0;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const d = Math.abs(Math.hypot(pts[i] - cx, pts[i + 1] - cy) - r);
    err += d;
  }
  err /= n;
  if (err > 0.14 * r + 0.6) return null;
  const a0 = Math.atan2(pts[1] - cy, pts[0] - cx);
  let sweep = 0;
  let prev = a0;
  for (let i = 2; i + 1 < pts.length; i += 2) {
    let t = Math.atan2(pts[i + 1] - cy, pts[i] - cx);
    let d = t - prev;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    sweep += d;
    prev = t;
  }
  const abs = Math.abs(sweep);
  return {
    cx,
    cy,
    r,
    startAngle: a0,
    endAngle: prev,
    sweep: abs >= 5.9 ? Math.PI * 2 : abs,
    direction: sweep < 0 ? -1 : 1,
  };
}

// If the circle fit fails, try an axis-aligned ellipse.
export function fitArc(pts) {
  const c = fitCircle(pts);
  if (c) return { ...c, rx: c.r, ry: c.r, isCircle: true };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]);
    y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]);
  }
  const sx = (x1 - x0) / 2;
  const sy = (y1 - y0) / 2;
  if (sx < 1 || sy < 1) return null;
  const ratio = Math.max(sx, sy) / Math.min(sx, sy);
  if (ratio < 1.25 || ratio > 12) return null;
  const norm = [];
  for (let i = 0; i + 1 < pts.length; i += 2) norm.push((pts[i] - x0 - sx) / sx, (pts[i + 1] - y0 - sy) / sy);
  const e = fitCircle(norm);
  if (!e) return null;
  return {
    cx: e.cx * sx + x0 + sx,
    cy: e.cy * sy + y0 + sy,
    rx: e.r * sx,
    ry: e.r * sy,
    startAngle: e.startAngle,
    sweep: e.sweep,
    isCircle: false,
  };
}


const MAX_CURVES = 3000;
const MAX_FILLS = 1600;
const DRAW_CAP = 50000;

const isStrokeOp = (op, OPS) => op === OPS.stroke || op === OPS.closeStroke || op === OPS.fillStroke || op === OPS.eoFillStroke;
const isFillOp = (op, OPS) => op === OPS.fill || op === OPS.eoFill || op === OPS.fillStroke || op === OPS.eoFillStroke;
const isPaint = (op, OPS) => isStrokeOp(op, OPS) || isFillOp(op, OPS);

function isRectPts(pts) {
  const n = pts.length / 2;
  if (n < 4 || n > 5) return false;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = Math.abs(pts[i * 2] - pts[j * 2]);
    const dy = Math.abs(pts[i * 2 + 1] - pts[j * 2 + 1]);
    if (dx > 0.6 && dy > 0.6) return false;
  }
  return true;
}

function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]);
    y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]);
  }
  return { x0, y0, x1, y1 };
}

function extractSegments(page, pdfjs, viewport, pageW, pageH) {
  return page.getOperatorList().then(({ fnArray, argsArray }) => finish(fnArray, argsArray));

  function finish(fnArray2, argsArray2) {
    const OPS = pdfjs.OPS;
    const base = viewport.transform;
    // The first PDF transform can look like the viewport matrix without being one.
    const mkState = () => ({ ctm: [1, 0, 0, 1, 0, 0], stroke: '#000000', fill: '#000000', lineWidth: 1, dash: false });
    let st = mkState();
    const stack = [];
    const pushState = () => stack.push({ ...st, ctm: [...st.ctm] });
    const popState = () => {
      const s = stack.pop();
      if (s) st = s;
    };
    const toDev = (x, y) => apply6(base, ...apply6(st.ctm, x, y));

    const raw = [];
    const drawPts = [];
    const images = [];
    const boxes = [];
    const diags = [];
    const curves = [];
    const fills = [];

    const push = (ax, ay, bx, by) => {
      // The subpath walker already converts these points to device space.
      raw.push([ax, ay, bx, by, st.dash ? 1 : 0]);
      if (drawPts.length < DRAW_CAP) {
        drawPts.push(ax, ay, bx, by);
      }
    };
    const pushBezier = (cur, c1, c2, e, sink) => {
      const pt = (t) => {
        const u = 1 - t;
        const x = u * u * u * cur[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * e[0];
        const y = u * u * u * cur[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * e[1];
        return [x, y];
      };
      if (sink === drawPts) {
        for (const q of [c1, c2, e]) {
          if (drawPts.length < DRAW_CAP) drawPts.push(q[0], q[1]);
        }
        return;
      }
      for (const t of [0.25, 0.5, 0.75]) {
        const d = pt(t);
        sink.push(d[0], d[1]);
      }
    };
    const noteDiag = (x1, y1, x2, y2) => {
      const dx = Math.abs(x2 - x1);
      const dy = Math.abs(y2 - y1);
      if (dx > 1.5 && dy > 1.5 && dx < 24 && dy < 24) diags.push([x1, y1, x2, y2]);
    };
    const noteBox = (bx0, by0, bx1, by1) => {
      const w = Math.abs(bx1 - bx0);
      const hh = Math.abs(by1 - by0);
      if (w < 5 || hh < 5 || w > 20 || hh > 20) return;
      const r = Math.min(w, hh) / Math.max(w, hh);
      if (r < 0.68) return;
      boxes.push({ x0: Math.min(bx0, bx1), y0: Math.min(by0, by1), x1: Math.max(bx0, bx1), y1: Math.max(by0, by1) });
    };

    const emitPaint = (paintOp, subs) => {
      const stroked = isStrokeOp(paintOp, OPS);
      const filled = isFillOp(paintOp, OPS);
      for (const s of subs) {
        if (filled && fills.length < MAX_FILLS) {
          const bbox = bboxOf(s.pts);
          const w = bbox.x1 - bbox.x0;
          const hh = bbox.y1 - bbox.y0;
          if (w * hh >= 1.5 && w * hh < 0.9 * pageW * pageH) {
            const arc = s.hasCurve || s.closed ? fitArc(s.pts) : null;
            fills.push({
              bbox,
              fillColor: st.fill,
              isRect: !s.hasCurve && isRectPts(s.pts),
              isDot: !!(arc && arc.sweep > 5.5 && arc.rx <= 3.6 && arc.ry <= 3.6),
              pts: s.pts.length <= 80 ? s.pts : s.pts.slice(0, 80),
            });
          }
        }
        if (s.hasCurve && curves.length < MAX_CURVES) {
          const arcFit = s.pts.length >= 12 ? fitArc(s.pts) : null;
          curves.push({
            pts: s.pts,
            strokeColor: stroked ? st.stroke : st.fill,
            fillColor: filled ? st.fill : null,
            lineWidth: st.lineWidth,
            dashed: st.dash,
            isClosed: s.closed,
            arcFit,
          });
        }
      }
    };

    const IMAGE_OPS = new Set(
      [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintJpegXObject].filter(Boolean)
    );

    let pend = [];

    for (let i = 0; i < fnArray2.length; i++) {
      const fn = fnArray2[i];
      const args = argsArray2[i];
      if (fn === OPS.save) {
        pushState();
        continue;
      }
      if (fn === OPS.restore) {
        popState();
        continue;
      }
      if (fn === OPS.transform) {
        // Apply the new transform before the accumulated matrix.
        st.ctm = mul6(st.ctm, Array.from(args));
        continue;
      }
      if (fn === OPS.setLineWidth) {
        if (typeof args[0] === 'number' && args[0] > 0) st.lineWidth = args[0];
        continue;
      }
      if (fn === OPS.setDash) {
        const arr = Array.isArray(args[0]) ? args[0] : [];
        st.dash = arr.some((v) => v > 0.01);
        continue;
      }
      if (fn === OPS.setGState) {
        // extended graphics state: [[ 'LW', w ], [ 'D', [arr, phase] ], ...]
        for (const entry of args[0] || []) {
          if (!Array.isArray(entry)) continue;
          const [key, value] = entry;
          if (key === 'LW' && typeof value === 'number' && value > 0) st.lineWidth = value;
          else if (key === 'D' && Array.isArray(value)) st.dash = (value[0] || []).some((v) => v > 0.01);
        }
        continue;
      }
      if (fn === OPS.setFillRGBColor || fn === OPS.setStrokeRGBColor) {
        const hex = typeof args[0] === 'string' ? args[0] : rgbToHex(args[0], args[1], args[2]);
        if (fn === OPS.setFillRGBColor) st.fill = hex;
        else st.stroke = hex;
        continue;
      }
      if (fn === OPS.setFillGray || fn === OPS.setStrokeGray) {
        const hex = grayToHex(args[0]);
        if (fn === OPS.setFillGray) st.fill = hex;
        else st.stroke = hex;
        continue;
      }
      if (fn === OPS.setFillCMYKColor || fn === OPS.setStrokeCMYKColor) {
        const hex = cmykToHex(args[0], args[1], args[2], args[3]);
        if (fn === OPS.setFillCMYKColor) st.fill = hex;
        else st.stroke = hex;
        continue;
      }
      if (fn === OPS.setFillN || fn === OPS.setStrokeN) {
        const comps = (args || []).filter((v) => typeof v === 'number');
        if (comps.length >= 3) {
          const hex = rgbToHex(comps[0], comps[1], comps[2]);
          if (fn === OPS.setFillN) st.fill = hex;
          else st.stroke = hex;
        }
        continue;
      }
      if (fn === OPS.paintFormXObjectBegin) {
        // Apply the form's matrix in its own saved graphics state.
        pushState();
        if (args?.[0]?.length === 6) st.ctm = mul6(st.ctm, args[0]);
        continue;
      }
      if (fn === OPS.paintFormXObjectEnd) {
        popState();
        continue;
      }
      if (IMAGE_OPS.has(fn)) {
        const dev = toDev;
        const c = [dev(0, 0), dev(1, 0), dev(1, 1), dev(0, 1)];
        const xs = c.map((p) => p[0]);
        const ys = c.map((p) => p[1]);
        const bbox = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
        if (bbox.x1 > bbox.x0 && bbox.y1 > bbox.y0) images.push(bbox);
        continue;
      }
      if (isPaint(fn, OPS) && pend.length) {
        emitPaint(fn, pend);
        pend = [];
        continue;
      }
      if (fn !== OPS.constructPath) continue;

      const runSubpath = (read) => {
        let cur = null;
        let pts = [];
        let hasCurve = false;
        const subs = [];
        const finish = (closed = false) => {
          if (pts.length >= 4) subs.push({ pts, hasCurve, closed });
          pts = [];
          hasCurve = false;
          cur = null;
        };
        for (;;) {
          const r = read();
          if (!r) break;
          if (r.close) {
            if (cur && pts.length >= 6) {
              const [x, y] = pts;
              push(cur[0], cur[1], x, y);
              noteDiag(cur[0], cur[1], x, y);
              if (cur[0] !== x || cur[1] !== y) pts.push(x, y);
              const box = bboxOf(pts);
              if (isRectPts(pts)) noteBox(box.x0, box.y0, box.x1, box.y1);
            }
            finish(true);
            continue;
          }
          if (!r.curve && !r.quadratic) {
            if (r.move) finish();
            if (r.noJoin) {
              finish();
              continue;
            }
            const q = toDev(r.x, r.y);
            if (cur) {
              push(cur[0], cur[1], q[0], q[1]);
              noteDiag(cur[0], cur[1], q[0], q[1]);
            }
            cur = q;
          } else {
            const q = toDev(r.x, r.y);
            if (cur) {
              const qc = r.quadratic && toDev(...r.quadratic);
              const c1 = qc ? cur.map((v, i) => (v + 2 * qc[i]) / 3) : toDev(...r.curve.c1);
              const c2 = qc ? q.map((v, i) => (v + 2 * qc[i]) / 3) : toDev(...r.curve.c2);
              pushBezier(cur, c1, c2, q, drawPts);
              pushBezier(cur, c1, c2, q, pts);
              hasCurve = true;
            }
            cur = q;
          }
          pts.push(cur[0], cur[1]);
        }
        finish();
        return subs;
      };

      if (typeof args[0] === 'number') {
        // PDF.js 6 packs subpaths and their paint operation together.
        if (!isPaint(args[0], OPS)) continue;
        const subs = [];
        for (const p of args[1]) {
          if (!p) continue;
          let k = 0;
          subs.push(...runSubpath(() => {
            if (k >= p.length) return null;
            const op = p[k++];
            if (op === 0) return { x: p[k++], y: p[k++], curve: null, move: true };
            if (op === 1) return { x: p[k++], y: p[k++], curve: null };
            if (op === 2) {
              const r = { x: p[k + 4], y: p[k + 5], curve: { c1: [p[k], p[k + 1]], c2: [p[k + 2], p[k + 3]] } };
              k += 6;
              return r;
            }
            if (op === 3) {
              const r = { x: p[k + 2], y: p[k + 3], quadratic: [p[k], p[k + 1]] };
              k += 4;
              return r;
            }
            if (op === 4) return { close: true };
            k = p.length;
            return null;
          }));
        }
        emitPaint(args[0], subs);
      } else {
        // Older PDF.js versions send the path and paint operation separately.
        const ops = args[0];
        const coords = args[1];
        if (!ops || !coords) continue;
        let k = 0;
        let c = 0;
        const sub = runSubpath(() => {
          if (k >= ops.length) return null;
          const op = ops[k++];
          if (op === OPS.moveTo) return { x: coords[c++], y: coords[c++], curve: null, move: true };
          if (op === OPS.lineTo) return { x: coords[c++], y: coords[c++], curve: null };
          if (op === OPS.curveTo) {
            const r = {
              x: coords[c + 4],
              y: coords[c + 5],
              curve: { c1: [coords[c], coords[c + 1]], c2: [coords[c + 2], coords[c + 3]] },
            };
            c += 6;
            return r;
          }
          if (op === OPS.curveTo1 || op === OPS.curveTo2) {
            const r = { x: coords[c + 2], y: coords[c + 3], curve: { c1: [coords[c], coords[c + 1]], c2: [coords[c], coords[c + 1]] } };
            c += 4;
            return r;
          }
          if (op === OPS.rectangle) {
            const x = coords[c++];
            const y = coords[c++];
            const w = coords[c++];
            const hh = coords[c++];
            if (w * hh < 0.45 * pageW * pageH) {
              const sub0 = {
                pts: [x, y, x + w, y, x + w, y + hh, x, y + hh, x, y].map((v) => v),
                hasCurve: false,
                closed: true,
              };
              const dpts = [];
              for (let q = 0; q + 1 < sub0.pts.length; q += 2) {
                const d = toDev(sub0.pts[q], sub0.pts[q + 1]);
                dpts.push(d[0], d[1]);
              }
              sub0.pts = dpts;
              for (let q = 0; q + 1 < dpts.length - 2; q += 2) {
                push(dpts[q], dpts[q + 1], dpts[q + 2], dpts[q + 3]);
                noteDiag(dpts[q], dpts[q + 1], dpts[q + 2], dpts[q + 3]);
              }
              noteBox(dpts[0], dpts[1], dpts[4], dpts[5]);
              if (pend.length < 200) pend.push({ pts: dpts, hasCurve: false, closed: true });
            }
            return { noJoin: true };
          }
          if (op === OPS.closePath) return { close: true };
          k = ops.length;
          return null;
        });
        for (const s of sub) pend.push(s);
        if (pend.length > 400) pend.length = 400;
      }
    }

    const h = [];
    const v = [];
    for (const [xa, ya, xb, yb, dashed] of raw) {
      const dx = Math.abs(xa - xb);
      const dy = Math.abs(ya - yb);
      if (dy <= 0.75 && dx >= 3) {
        h.push({ pos: (ya + yb) / 2, from: Math.min(xa, xb), to: Math.max(xa, xb), dashed: !!dashed });
      } else if (dx <= 0.75 && dy >= 3) {
        v.push({ pos: (xa + xb) / 2, from: Math.min(ya, yb), to: Math.max(ya, yb), dashed: !!dashed });
      }
    }
    return { h, v, drawPts, images, boxes, diags, curves, fills, strokes: raw };
  }
}

function mul6(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function apply6(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}


export function detectPrimitives({ boxes, diags, fills, curves }) {
  const out = [];

  // Group segmented inputs before detecting individual checkboxes.
  const usedBoxes = new Set();
  const rest = [...boxes].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  let group = [];
  const flushComb = () => {
    if (group.length >= 3 && group.length <= 16) {
      const widths = group.map((b) => b.x1 - b.x0);
      const meanW = widths.reduce((s, v) => s + v, 0) / widths.length;
      const uniform = widths.every((w) => Math.abs(w - meanW) <= 2.5);
      if (uniform && meanW >= 8 && meanW <= 18) {
        out.push({
          type: 'comb',
          bbox: { x0: group[0].x0, y0: group[0].y0, x1: group[group.length - 1].x1, y1: group[0].y1 },
          cellCount: group.length,
          cells: group.map((b) => ({ ...b })),
        });
        for (const b of group) usedBoxes.add(b);
      }
    }
    group = [];
  };
  for (const b of rest) {
    const last = group[group.length - 1];
    if (
      last &&
      Math.abs(b.y0 - last.y0) <= 2 &&
      Math.abs(b.y1 - last.y1) <= 2 &&
      Math.abs(b.y1 - b.y0 - (last.y1 - last.y0)) <= 2 &&
      b.x0 - last.x1 <= 2.5 &&
      b.x0 - last.x1 >= -1
    ) {
      group.push(b);
    } else {
      flushComb();
      group = [b];
    }
  }
  flushComb();

  for (const b of boxes) {
    if (usedBoxes.has(b)) continue;
    const w = b.x1 - b.x0;
    const hh = b.y1 - b.y0;
    if (w < 5 || hh < 5 || w > 14 || hh > 14) continue;
    if (Math.min(w, hh) / Math.max(w, hh) < 0.85) continue;
    let marks = 0;
    for (const [dx1, dy1, dx2, dy2] of diags) {
      const mx = (dx1 + dx2) / 2;
      const my = (dy1 + dy2) / 2;
      if (mx >= b.x0 && mx <= b.x1 && my >= b.y0 && my <= b.y1) marks++;
    }
    usedBoxes.add(b);
    out.push({ type: 'checkbox', bbox: { ...b }, checked: marks >= 2 });
  }

  for (const f of fills) {
    if (!f.isDot) continue;
    const cx = (f.bbox.x0 + f.bbox.x1) / 2;
    const cy = (f.bbox.y0 + f.bbox.y1) / 2;
    out.push({ type: 'junction', x: cx, y: cy, r: (f.bbox.x1 - f.bbox.x0) / 2 });
  }

  const dots = fills.filter((f) => f.isDot).map((f) => ({ x: (f.bbox.x0 + f.bbox.x1) / 2, y: (f.bbox.y0 + f.bbox.y1) / 2 }));
  for (const c of curves) {
    if (!c.arcFit || !c.isClosed) continue;
    const r = Math.max(c.arcFit.rx, c.arcFit.ry);
    if (r < 2.5 || r > 8 || c.arcFit.sweep < 5.2) continue;
    const bbox = {
      x0: c.arcFit.cx - r,
      y0: c.arcFit.cy - r,
      x1: c.arcFit.cx + r,
      y1: c.arcFit.cy + r,
    };
    const checked = dots.some((d) => Math.hypot(d.x - c.arcFit.cx, d.y - c.arcFit.cy) <= r);
    out.push({ type: 'radio', bbox, checked });
  }

  for (const f of fills) {
    if (f.isRect || f.isDot) continue;
    const pts = f.pts;
    const closed = pts[0] === pts.at(-2) && pts[1] === pts.at(-1);
    const n = pts.length / 2 - Number(closed);
    if (n < 3 || n > 4) continue;
    const bbox = f.bbox;
    const w = bbox.x1 - bbox.x0;
    const hh = bbox.y1 - bbox.y0;
    if (w > 10 || hh > 10 || w < 2 || hh < 2) continue;
    const vx = [];
    for (let i = 0; i < n; i++) vx.push([f.pts[i * 2], f.pts[i * 2 + 1]]);
    let apex = vx[0];
    let best = -1;
    for (let i = 0; i < n; i++) {
      let dsum = 0;
      for (let j = 0; j < n; j++) if (j !== i) dsum += Math.hypot(vx[i][0] - vx[j][0], vx[i][1] - vx[j][1]);
      if (dsum > best) {
        best = dsum;
        apex = vx[i];
      }
    }
    let tail = null;
    let bestD = 9;
    for (const c of curves) {
      for (let i = 0; i + 1 < c.pts.length; i += 2) {
        const d = Math.hypot(c.pts[i] - apex[0], c.pts[i + 1] - apex[1]);
        if (d < bestD) {
          bestD = d;
          tail = [c.pts[i], c.pts[i + 1]];
        }
      }
    }
    out.push({
      type: 'arrow',
      tip: { x: apex[0], y: apex[1] },
      base: { x: (vx[0][0] + vx[1][0] + vx[2][0] - apex[0]) / 2, y: (vx[0][1] + vx[1][1] + vx[2][1] - apex[1]) / 2 },
      tail: tail ? { x: tail[0], y: tail[1] } : null,
      angle: tail ? Math.atan2(apex[1] - tail[1], apex[0] - tail[0]) : 0,
      dashed: false,
    });
  }
  return out;
}

export function contentItems(items) {
  let depth = 0, artifactDepth = 0;
  return items.filter((item) => {
    if (item.type === 'beginMarkedContent' || item.type === 'beginMarkedContentProps') {
      depth++;
      if (!artifactDepth && item.tag === 'Artifact') artifactDepth = depth;
      return false;
    }
    if (item.type === 'endMarkedContent') {
      if (artifactDepth === depth) artifactDepth = 0;
      depth = Math.max(0, depth - 1);
      return false;
    }
    return !artifactDepth;
  });
}

export async function extractPage(page, pdfjs, opts = {}) {
  const viewport = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent({ includeMarkedContent: !!opts.dropArtifacts });
  const words = [];
  const rotated = [];
  for (const item of opts.dropArtifacts ? contentItems(tc.items) : tc.items) {
    if (typeof item.str !== 'string' || !item.str.trim()) continue;
    const tx = pdfjs.Util.transform(viewport.transform, item.transform);
    // Keep rotated labels out of the horizontal text flow.
    const angle = Math.atan2(tx[1], tx[0]);
    if (Math.abs(angle) > 0.15) {
      const size = Math.hypot(tx[2], tx[3]) || item.height || 10;
      const str = normalizeGlyphs(item.str).trim();
      if (str) rotated.push({ str, x0: tx[4] - size * 0.4, x1: tx[4] + size * 0.4, y: tx[5], size, angle, mono: false });
      continue;
    }
    words.push(...splitItem(item, tx, tc.styles));
  }
  const pageW = viewport.width;
  const pageH = viewport.height;
  const seg = await extractSegments(page, pdfjs, viewport, pageW, pageH);
  const primitives = [...detectPrimitives(seg)];
  for (const box of detectSquareBoxes(seg)) {
    const duplicate = primitives.find((p) => p.type === 'checkbox' &&
      ['x0', 'y0', 'x1', 'y1'].every((k) => Math.abs(p.bbox[k] - box.bbox[k]) <= 1));
    if (duplicate) duplicate.checked ||= box.checked;
    else primitives.push(box);
  }
  // Don't treat schematic pin boxes as checkbox fields.
  const segDensity = (b) => {
    let n = 0;
    for (const sg of seg.h) if (sg.pos > b.y0 - 30 && sg.pos < b.y1 + 30 && sg.to > b.x0 - 30 && sg.from < b.x1 + 30) n++;
    for (const sg of seg.v) if (sg.pos > b.x0 - 30 && sg.pos < b.x1 + 30 && sg.to > b.y0 - 30 && sg.from < b.y1 + 30) n++;
    return n;
  };
  const formBoxes = primitives.filter((p) => (p.type === 'checkbox' || p.type === 'radio') && segDensity(p.bbox) <= 60);
  const pageText = words.slice();
  const controlWord = (bbox, str) => {
    const { x0, x1, y0, y1 } = bbox;
    const height = y1 - y0;
    const width = x1 - x0;
    if (Math.min(width, height) < 0.8 * Math.max(width, height)) {
      return { str, x0, x1, y: y1, size: Math.max(6, height), mono: false };
    }
    let label;
    for (const word of pageText) {
      if (word.x0 < x1 - 0.5 || word.x0 > x1 + 1.5 * height ||
          word.y < y1 - 0.6 * height || word.y > y1 + 0.4 * height ||
          /^[\u2610-\u2612\u25cb\u25c9xX]$/u.test(word.str)) continue;
      if (!label || word.x0 < label.x0) label = word;
    }
    return { str, x0, x1, y: label?.y ?? y1, size: label?.size ?? Math.max(6, height), mono: false };
  };
  const annotations = [];
  try {
    const annots = await page.getAnnotations({ intent: 'display' });
    for (const a of annots || []) {
      if (!a || a.subtype !== 'Widget') continue;
      const [ax0, ay0] = viewport.convertToViewportPoint(a.rect[0], a.rect[1]);
      const [ax1, ay1] = viewport.convertToViewportPoint(a.rect[2], a.rect[3]);
      const bbox = { x0: Math.min(ax0, ax1), y0: Math.min(ay0, ay1), x1: Math.max(ax0, ax1), y1: Math.max(ay0, ay1) };
      const type = a.fieldType || '';
      const exportValue = a.buttonValue ?? a.exportValue;
      const checked = type === 'Btn' && (exportValue != null
        ? String(a.fieldValue) === String(exportValue) && String(exportValue) !== 'Off'
        : !a.radioButton && (a.fieldValue === true || a.fieldValue === 'Yes' || a.fieldValue === 'On'));
      annotations.push({
        id: a.id,
        bbox,
        fieldName: a.fieldName || null,
        fieldType: type,
        fieldValue: a.fieldValue ?? null,
        isChecked: !!checked,
        alternativeText: String(a.alternativeText || ''),
        controlType: a.radioButton ? 'radio' : a.checkBox ? 'checkbox' : a.pushButton ? 'button' :
          type === 'Tx' ? (a.multiLine ? 'textarea' : 'text') : type === 'Ch' ? 'select' : null,
        exportValue: exportValue ?? null,
        readOnly: Boolean(a.readOnly || a.fieldFlags & 1),
        required: Boolean(a.required || a.fieldFlags & 2),
        multiple: Boolean(a.multiSelect),
        appearanceState: a.appearanceState || null,
        options: (a.options || []).map((o) => ({ value: o.exportValue, label: o.displayValue ?? o.exportValue })),
      });
      const bh = bbox.y1 - bbox.y0;
      if (type === 'Btn' && (a.checkBox || a.radioButton)) {
        words.push(controlWord(bbox, a.radioButton ? (checked ? '◉' : '○') : (checked ? '☑' : '☐')));
      } else if (type === 'Tx' || type === 'Ch') {
        const value = Array.isArray(a.fieldValue) ? a.fieldValue.join(', ') : String(a.fieldValue ?? '');
        if (value.trim()) words.push({ str: value.trim(), x0: bbox.x0, x1: bbox.x1, y: bbox.y1, size: Math.max(6, bh * 0.75), mono: false });
      }
    }
  } catch {
  }
  const buttonWidgets = annotations.filter((a) => a.controlType === 'checkbox' || a.controlType === 'radio');
  const checkboxGlyphs = words.filter((word) => /^[xX\u2713\u2714\u2717\u2718]$/u.test(word.str.trim()));
  const usedMarks = new Set();
  for (const p of formBoxes) {
    const { x0, x1, y0, y1 } = p.bbox;
    const widget = buttonWidgets.find(({ bbox: b }) =>
      Math.min(b.x1, x1) - Math.max(b.x0, x0) >= 0.5 * Math.min(x1 - x0, b.x1 - b.x0) &&
      Math.min(b.y1, y1) - Math.max(b.y0, y0) >= 0.5 * Math.min(y1 - y0, b.y1 - b.y0));
    if (widget) {
      p.checked = widget.isChecked;
      continue;
    }
    if (p.type === 'checkbox' && Math.min(x1 - x0, y1 - y0) >= 0.8 * Math.max(x1 - x0, y1 - y0)) {
      const mark = checkboxGlyphs.find((word) => !usedMarks.has(word) &&
        word.x0 >= x0 - 0.5 && word.x1 <= x1 + 0.5 &&
        word.y >= (y0 + y1) / 2 && word.y <= y1 + 0.5);
      if (mark) {
        p.checked = true;
        usedMarks.add(mark);
      }
    }
    const str = p.type === 'radio' ? (p.checked ? '◉' : '○') : (p.checked ? '☑' : '☐');
    words.push(controlWord(p.bbox, str));
  }
  // Coalesce overprinted text without losing the faux-bold signal.
  const deduped = [];
  let fauxBold = 0;
  for (const w of words) {
    if (usedMarks.has(w)) continue;
    const twin = deduped.find(
      (p) => p.str === w.str && Math.abs(p.x0 - w.x0) < 1.5 && Math.abs(p.y - w.y) < 1.5
    );
    if (!twin) deduped.push(w);
    else {
      twin.x1 = Math.max(twin.x1, w.x1);
      if (Math.abs(twin.x0 - w.x0) < 0.9 && Math.abs(twin.y - w.y) < 0.9 && w.str.trim().length <= 3) {
        if (!/\|FauxBold/.test(twin.font || '')) twin.font = String(twin.font || '') + '|FauxBold';
        fauxBold++;
      }
    }
  }
  return {
    width: pageW,
    fauxBold,
    height: pageH,
    words: deduped,
    segments: { h: seg.h, v: seg.v },
    drawPts: seg.drawPts,
    images: seg.images,
    checkboxes: formBoxes.map((p) => ({ x: (p.bbox.x0 + p.bbox.x1) / 2, y: p.bbox.y1, w: p.bbox.x1 - p.bbox.x0, h: p.bbox.y1 - p.bbox.y0, checked: p.checked })),
    formBoxes,
    rotated,
    curves: seg.curves,
    fills: seg.fills,
    primitives,
    diags: seg.diags,
    strokes: seg.strokes,
    annotations,
  };
}
