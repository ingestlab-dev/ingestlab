
import { OCR_DEFAULT_LANGS, resolveOcrModels } from './ocrLanguages.js';
export { OCR_DEFAULT_LANGS };
const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/tesseract.esm.min.js';
const RENDER_SCALE = 2;
const needsRuleRetry = (count, segments) => count < 45 &&
  ((segments?.h?.length ?? 0) >= 2 || (segments?.v?.length ?? 0) >= 2);

let _worker = null;
let _workerLangs = null;
let _workerRuntime = null;

async function loadTesseract(runtime) {
  // The CDN build exposes Tesseract through its default export.
  const mod =
    typeof process !== 'undefined' && process.versions?.node
      ? await import('tesseract.js')
      : await import(runtime?.module || TESSERACT_CDN);
  return mod.createWorker ? mod : mod.default;
}

async function getWorker(langs, runtime) {
  if (_worker && _workerLangs === langs && _workerRuntime === runtime) return _worker;
  if (_worker) {
    try {
      await _worker.terminate();
    } catch {}
    _worker = null;
  }
  _worker = await makeWorker(langs, runtime);
  _workerLangs = langs;
  _workerRuntime = runtime;
  return _worker;
}

async function makeWorker(langs, runtime) {
  const api = await loadTesseract(runtime);
  const { module, ...paths } = runtime || {};
  const { pinned, ...model } = resolveOcrModels(langs, runtime);
  let cache = {};
  if (runtime?.langPath) cache = { cacheMethod: 'none' };
  else if (pinned) {
    const version = 'ingestlab-tessdata-fast-4.1.0';
    if (typeof process !== 'undefined' && process.versions?.node) {
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { mkdir } = await import('node:fs/promises');
      const cachePath = join(tmpdir(), version);
      await mkdir(cachePath, { recursive: true });
      cache = { cachePath };
    } else cache = { cachePath: version };
  }
  // Worker initialization can hang after a model fails to load.
  let rejectInit;
  const failed = new Promise((_, reject) => { rejectInit = reject; });
  const worker = api.createWorker(langs, 1, {
    ...paths, ...model, ...cache,
    errorHandler: (reason) => rejectInit(new Error(String(reason))),
  });
  return Promise.race([worker, failed]);
}

/**
 * OCR scanned pages in parallel. Node callers can cache completed pages on disk.
 *
 * @param {object} doc open pdf.js document
 * @param {number[]} pageNumbers scanned pages to OCR (1-based)
 * @param {object} pdfjs the pdf.js module
 * @param {object} opts { ocrLangs, ocrWorkers, ocrCacheDir, docHash }
 * @param {object} hooks { onProgress({ page, done, total }) }
 * @returns {Promise<Map<number, {words, segments}|null>>} null = page failed
 */
export async function ocrPagesParallel(doc, pageNumbers, pdfjs, opts = {}, hooks = {}) {
  const isNode = typeof process !== 'undefined' && process.versions?.node;
  if (pageNumbers.length === 0) return null;
  const size = Math.max(
    1,
    Math.min(
      opts.ocrWorkers ||
        (isNode ? Math.min(4, Math.max(2, (await import('node:os')).cpus().length)) : Math.min(3, Math.max(1, navigator.hardwareConcurrency || 2))),
      pageNumbers.length
    )
  );
  const { mkdirSync, readFileSync, writeFileSync, existsSync } = isNode
    ? await import('node:fs')
    : { mkdirSync: null, readFileSync: null, writeFileSync: null, existsSync: null };
  const langs = opts.ocrLangs || OCR_DEFAULT_LANGS;
  const cacheDir = isNode ? opts.ocrCacheDir || null : null;
  if (cacheDir) mkdirSync(cacheDir, { recursive: true });
  const cacheKey = cacheDir && (await import('node:crypto')).createHash('sha256')
    .update(JSON.stringify([langs, opts.ocrRuntime?.langPath, opts.ocrRuntime?.gzip, opts.ocrRoi])).digest('hex').slice(0, 16);
  const cacheFile = (p, version = 4) =>
    `${cacheDir}/${(opts.docHash || 'doc').slice(0, 16)}-p${p}-${cacheKey}-r${version}.json`;

  const results = new Map();
  let next = 0;
  let done = 0;

  const record = (p, res) => {
    results.set(p, res);
    done++;
    hooks.onProgress?.({ stage: 'ocr', page: p, done, total: pageNumbers.length });
  };
  const pending = [];
  for (const p of pageNumbers) {
    const probe = opts.precomputed?.get(p);
    if (probe?.words?.length) { record(p, probe); continue; }
    let cached;
    if (cacheDir) {
      for (const version of [4, 3]) {
        const file = cacheFile(p, version);
        if (!existsSync(file)) continue;
        try {
          const entry = JSON.parse(readFileSync(file, 'utf8'));
          if (entry.words?.length && (version === 4 || !needsRuleRetry(entry.words.length, entry.segments))) {
            cached = entry;
            break;
          }
        } catch {}
      }
    }
    if (cached) {
      const confidence = cached.confidence ?? (cached.words.reduce((sum, word) => sum + (word.confidence ?? 0.72), 0) / cached.words.length);
      record(p, { words: cached.words, segments: cached.segments || { h: [], v: [] }, confidence });
      continue;
    }
    pending.push(p);
  }
  if (!pending.length) return results;

  const runOne = async (worker, p) => {
    const page = await doc.getPage(p);
    let res = null;
    try {
      res = await ocrPage(page, pdfjs, { ocrLangs: langs, worker, ocrRect: opts.ocrRoi === false ? null : undefined });
    } catch (e) {
      console.warn('ingestlab: OCR failed for page ' + p + ':', String(e?.message || e).slice(0, 120));
    }
    page.cleanup?.();
    if (res?.words.length) {
      if (cacheDir) {
        try {
          writeFileSync(cacheFile(p), JSON.stringify(res));
        } catch {}
      }
    }
    record(p, res);
  };

  const t0 = performance.now();
  const starts = await Promise.allSettled(Array.from({ length: Math.min(size, pending.length) },
    () => makeWorker(langs, opts.ocrRuntime)));
  const workers = starts.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  if (!workers.length) {
    console.warn('ingestlab: OCR workers unavailable:', starts[0].reason);
    for (const p of pending) record(p, null);
    return results;
  }
  try {
    const runs = await Promise.allSettled(workers.map(async (worker) => {
      for (;;) {
        const i = next++;
        if (i >= pending.length) break;
        await runOne(worker, pending[i]);
      }
    }));
    const failure = runs.find((run) => run.status === 'rejected');
    if (failure) throw failure.reason;
  } finally {
    await Promise.all(workers.map((w) => w.terminate().catch(() => {})));
  }
  console.warn(
    `ingestlab: OCR pool ${size} workers × ${pageNumbers.length} pages in ${Math.round((performance.now() - t0) / 100) / 10}s`
  );
  return results;
}

export async function destroyOcrWorker() {
  const w = _worker;
  _worker = null;
  _workerLangs = null;
  _workerRuntime = null;
  if (w) {
    try {
      await w.terminate();
      return true;
    } catch {}
  }
  return false;
}

function collectWords(data) {
  const out = [];
  const push = (w, line, order) => {
    if (!w?.text || !w.bbox) return;
    let conf = w.confidence ?? 0;
    // CJK words can score zero even when every glyph is recognized.
    if (conf === 0 && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(w.text) &&
        w.symbols?.length && w.symbols.map((s) => s.text).join('') === w.text &&
        w.symbols.every((s) => s.confidence >= 60)) {
      conf = w.symbols.reduce((n, s) => Math.min(n, s.confidence), 100);
    }
    out.push({ str: w.text, bbox: w.bbox, conf, line, order });
  };
  let line = 0;
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        for (const [order, w] of (l.words || []).entries()) push(w, line, order);
        line++;
      }
    }
  }
  if (!out.length) for (const w of data.words || []) push(w);
  return out;
}

function suppressStamps(render) {
  const { ctx, w, h } = render;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  let colored = 0;
  for (let i = 0; i < d.length; i += 4) {
    const mx = Math.max(d[i], d[i + 1], d[i + 2]);
    const mn = Math.min(d[i], d[i + 1], d[i + 2]);
    if (mx - mn > 40 && mx > 60) {
      colored++;
      if (colored > 60) break;
    }
  }
  if (colored <= 60) return { data: d, w, h };
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(d[i], d[i + 1], d[i + 2]);
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return { data: d, w, h };
}

export function contentRect(gray) {
  const { data, w, h } = gray;
  const S = 8;
  const cw = Math.ceil(w / S);
  const ch = Math.ceil(h / S);
  const DARK = 150;
  const rows = new Uint8Array(ch);
  const cols = new Uint8Array(cw);
  const ink = new Uint8Array(cw * ch);
  for (let y = 0; y < h; y++) {
    const r = (y / S) | 0;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[(row + x) * 4] < DARK) {
        rows[r] = 1;
        const c = (x / S) | 0;
        cols[c] = 1;
        ink[r * cw + c] = 1;
      }
    }
  }
  let r0 = -1, r1 = -1, c0 = -1, c1 = -1;
  for (let i = 0; i < ch; i++) if (rows[i]) { if (r0 < 0) r0 = i; r1 = i; }
  for (let i = 0; i < cw; i++) if (cols[i]) { if (c0 < 0) c0 = i; c1 = i; }
  if (r0 < 0 || c0 < 0) return null;
  // A rotated margin imprint can confuse OCR for the entire page.
  const edgeLimit = Math.floor(0.06 * cw);
  const separate = (edge, step) => {
    const outer = step > 0 ? edge : cw - 1 - edge;
    if (outer > edgeLimit) return edge;
    let c = edge;
    while (c >= 0 && c < cw && Math.abs(c - edge) <= edgeLimit) {
      if (cols[c]) { c += step; continue; }
      const gapStart = c;
      while (c >= 0 && c < cw && !cols[c]) c += step;
      if (c < 0 || c >= cw || Math.abs(c - gapStart) < Math.max(2, 0.014 * cw)) continue;
      if (step > 0 ? c >= c1 - 0.6 * cw : c <= c0 + 0.6 * cw) continue;
      const first = Math.min(edge, gapStart - step);
      const last = Math.max(edge, gapStart - step);
      let activeRows = 0;
      for (let r = 0; r < ch; r++) {
        if (ink.subarray(r * cw + first, r * cw + last + 1).includes(1)) activeRows++;
      }
      if (activeRows >= 0.2 * ch) return c;
    }
    return edge;
  };
  const innerLeft = separate(c0, 1);
  const innerRight = separate(c1, -1);
  const PAD = 3; // Tesseract expects the crop rectangle in image pixels.
  const left = Math.max(0, (innerLeft === c0 ? c0 - PAD : innerLeft) * S);
  const top = Math.max(0, (r0 - PAD) * S);
  const width = Math.min(w, (innerRight === c1 ? c1 + 1 + PAD : innerRight + 1) * S) - left;
  const height = Math.min(h, (r1 + 1 + PAD) * S) - top;
  if ((width * height) / (w * h) > 0.97) return null;
  if (width < 80 || height < 80) return null;
  return { left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height) };
}

const VIET_RE = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;
// Count common Vietnamese words; isolated accents can be OCR noise.
const VIET_TOKEN_RE = /\b(và|của|các|ngày|tháng|năm|được|không|theo|tại|một|trong|tiền|thuế|người|nước|luật|điều|khoản|hội|họ|tên|sinh|số|vụ|quy|đất)\b/gi;
export async function probeOcrLang(doc, pageNumbers, pdfjs, opts = {}) {
  const base = opts.ocrLangs || OCR_DEFAULT_LANGS;
  const results = [];
  try {
    // Try a few pages when the cover is too sparse to classify.
    for (const p of pageNumbers.slice(0, 3)) {
      const page = await doc.getPage(p);
      let result = null;
      try {
        result = await ocrPage(page, pdfjs, {
          ocrLangs: base, ocrRuntime: opts.ocrRuntime, ocrRect: opts.ocrRoi === false ? null : undefined,
        });
      } finally {
        page.cleanup?.();
      }
      if (result) results.push([p, result]);
      const text = (result?.words || []).map((w) => w.str).join(' ');
      const tokens = (text.match(VIET_TOKEN_RE) || []).length;
      const hits = (text.match(new RegExp(VIET_RE.source, 'gi')) || []).length;
      const nWords = result?.words?.length || 0;
      if (tokens >= 4) {
        console.warn(
          `ingestlab: OCR lang probe: page ${p} -> ${nWords} words, ${tokens} Vietnamese tokens -> ${base} (probe pages reused: ${results.length})`
        );
        return { langs: base, results: new Map(results) };
      }
      // Keep both models when there isn't enough text to identify the language.
      if (nWords >= 15 && tokens <= 1 && hits <= 2) {
        console.warn(`ingestlab: OCR lang probe: page ${p} -> ${nWords} words, no Vietnamese -> eng`);
        return { langs: 'eng', results: null };
      }
    }
    console.warn(`ingestlab: OCR lang probe: inconclusive over ${results.length} page(s) -> keeping ${base}`);
    return { langs: base, results: null };
  } catch (e) {
    console.warn('ingestlab: OCR lang probe failed, keeping ' + base + ':', String(e?.message || e).slice(0, 100));
    return { langs: base, results: null };
  }
}

export function detectRuledLines(gray, pageW, pageH, scale = RENDER_SCALE, minVerticalRatio = 0.2) {
  const { data, w, h } = gray;
  const stride = gray.stride ?? 4;
  const minH = Math.round(0.3 * w);
  const minV = Math.round(minVerticalRatio * h);
  const cap = 240;
  // Keep short strokes for the form detector.
  const boxCap = 400;

  const scan = (DARK) => {
    const segs = { h: [], v: [], boxH: [], boxV: [] };
    const hruns = [];
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let start = -1;
      for (let x = 0; x <= w; x++) {
        const dark = x < w && data[(row + x) * stride] < DARK;
        if (dark && start < 0) start = x;
        else if (!dark && start >= 0) {
          const len = x - start;
          if (len >= minH) hruns.push({ y, x0: start, x1: x });
          else if (len >= 16 && len <= 0.3 * w && segs.boxH.length < boxCap) {
            segs.boxH.push({ pos: (y + 0.5) / scale, from: start / scale, to: x / scale });
          }
          start = -1;
        }
      }
    }
    hruns.sort((a, b) => a.y - b.y || a.x0 - b.x0);
    for (const r of hruns) {
      const last = segs.h[segs.h.length - 1];
      if (last && Math.abs(r.y - last._y) <= 5 && r.x0 >= last._x0 - 6 && r.x1 <= last._x1 + 6) {
        last._y = r.y;
        last._x0 = Math.min(last._x0, r.x0);
        last._x1 = Math.max(last._x1, r.x1);
        last.pos = (r.y + 0.5) / scale;
        last.from = last._x0 / scale;
        last.to = last._x1 / scale;
      } else if (segs.h.length < cap) {
        segs.h.push({ kind: 'h', pos: (r.y + 0.5) / scale, from: r.x0 / scale, to: r.x1 / scale, _y: r.y, _x0: r.x0, _x1: r.x1 });
      }
    }
    const vruns = [];
    for (let x = 0; x < w; x += 1) {
      let start = -1;
      for (let y = 0; y <= h; y++) {
        const dark = y < h && data[(y * w + x) * stride] < DARK;
        if (dark && start < 0) start = y;
        else if (!dark && start >= 0) {
          const len = y - start;
          if (len >= minV) vruns.push({ x, y0: start, y1: y });
          else if (len >= 7 && len <= 0.2 * h && segs.boxV.length < boxCap) {
            segs.boxV.push({ pos: (x + 0.5) / scale, from: start / scale, to: y / scale });
          }
          start = -1;
        }
      }
    }
    vruns.sort((a, b) => a.x - b.x);
    for (const r of vruns) {
      const last = segs.v[segs.v.length - 1];
      if (last && Math.abs(r.x - last._x) <= 5 && r.y0 >= last._y0 - 6 && r.y1 <= last._y1 + 6) {
        last._x = r.x;
        last._y0 = Math.min(last._y0, r.y0);
        last._y1 = Math.max(last._y1, r.y1);
        last.pos = (r.x + 0.5) / scale;
        last.from = last._y0 / scale;
        last.to = last._y1 / scale;
      } else if (segs.v.length < cap) {
        segs.v.push({ kind: 'v', pos: (r.x + 0.5) / scale, from: r.y0 / scale, to: r.y1 / scale, _x: r.x, _y0: r.y0, _y1: r.y1 });
      }
    }
    for (const s of [...segs.h, ...segs.v]) {
      delete s._y;
      delete s._x;
      delete s._x0;
      delete s._x1;
      delete s._y0;
      delete s._y1;
    }
    return segs;
  };

  let segs = scan(150);
  if (segs.h.length < 3 && segs.v.length < 2) {
    // Retry at a lighter threshold for faint rules.
    const relaxed = scan(195);
    if (relaxed.h.length >= 3 && relaxed.h.length <= 80 && relaxed.v.length <= 30 && (relaxed.h.length > segs.h.length || relaxed.v.length > segs.v.length)) {
      segs = relaxed;
    }
  }
  return segs;
}

export async function ocrPage(page, pdfjs, opts = {}) {
  const langs = opts.ocrLangs || OCR_DEFAULT_LANGS;
  const poolWorker = opts.worker || null;
  const { renderPage } = await import('./render.js');
  const render = await renderPage(page, RENDER_SCALE);
  const gray = suppressStamps(render);
  let segments = detectRuledLines(gray, render.w / RENDER_SCALE, render.h / RENDER_SCALE);
  let rect;
  if (opts.ocrRect === null) rect = null;
  else if (opts.ocrRect && typeof opts.ocrRect === 'object') rect = opts.ocrRect;
  else rect = contentRect(gray);
  // Browser Tesseract accepts a canvas, but not ImageData.
  const image = () => render.isNode ? render.canvas.toBuffer('image/png') : render.canvas;
  const worker = poolWorker || (await getWorker(langs, opts.ocrRuntime));
  const recognize = async () => {
    const { data } = await worker.recognize(image(), rect ? { rectangle: rect } : {}, { text: true, blocks: true });
    return collectWords(data).filter((word) => word.conf >= 40 && word.str.trim());
  };
  let recognized = await recognize();
  const confidenceOf = (words) => words.length
    ? words.reduce((sum, word) => sum + word.conf, 0) / (words.length * 100)
    : 0;
  const confidenceThreshold = opts.ocrConfidenceThreshold ?? 0.62;
  let confidenceRetry = false;
  if (opts.ocrConfidenceRetry !== false && confidenceOf(recognized) < confidenceThreshold) {
    try {
      await worker.setParameters({ tessedit_pageseg_mode: '6' });
      const retry = await recognize();
      const score = (words) => confidenceOf(words) * Math.log2(words.length + 1);
      if (score(retry) > score(recognized)) recognized = retry;
      confidenceRetry = true;
    } catch {
    } finally {
      await worker.setParameters({ tessedit_pageseg_mode: '3' });
    }
  }
  if (needsRuleRetry(recognized.length, segments)) {
    const data = new Uint8Array(gray.w * gray.h);
    for (let i = 0; i < data.length; i++) data[i] = gray.data[i * 4] < 220 ? 0 : 255;
    const rules = detectRuledLines({ ...gray, data, stride: 1 },
      gray.w / RENDER_SCALE, gray.h / RENDER_SCALE, RENDER_SCALE, 0.115);
    if (rules.h.length >= 5 && rules.h.length <= 55 && rules.v.length >= 3 && rules.v.length <= 55) {
      // A second pass can recover text that Tesseract excluded as line art.
      render.ctx.fillStyle = '#fff';
      for (const s of rules.h) render.ctx.fillRect(s.from * RENDER_SCALE - 1, s.pos * RENDER_SCALE - 3,
        (s.to - s.from) * RENDER_SCALE + 2, 6);
      for (const s of rules.v) render.ctx.fillRect(s.pos * RENDER_SCALE - 3, s.from * RENDER_SCALE - 1,
        6, (s.to - s.from) * RENDER_SCALE + 2);
      await worker.setParameters({ tessedit_pageseg_mode: '11' });
      try {
        const retry = await recognize();
        if (retry.length >= Math.max(20, 1.3 * recognized.length)) {
          recognized = retry.filter((word) => word.str.trim() !== '|');
          segments = rules;
        }
      } catch {
        // Keep the first pass if the retry fails.
      } finally {
        await worker.setParameters({ tessedit_pageseg_mode: '3' });
      }
    }
  }

  const words = recognized
    .map((x) => ({
      str: x.str.trim(),
      x0: x.bbox.x0 / RENDER_SCALE,
      x1: x.bbox.x1 / RENDER_SCALE,
      // bbox bottom ≈ baseline in the same top-down space pdf.js uses
      y: x.bbox.y1 / RENDER_SCALE,
      size: Math.max(1, (x.bbox.y1 - x.bbox.y0) / RENDER_SCALE),
      ocrLine: x.line,
      ocrOrder: x.order,
      confidence: Math.max(0, Math.min(1, x.conf / 100)),
      mono: false,
    }));
  try {
    render.canvas.width = 0;
    render.canvas.height = 0;
  } catch {}
  const confidence = words.length
    ? words.reduce((sum, word) => sum + word.confidence, 0) / words.length
    : 0;
  return { words, segments, confidence, confidenceRetry };
}

export async function ocrImageRegions(doc, pageBlocks, pageData, langs, onProgress, ocrRuntime) {
  const { makeCanvas, renderPage } = await import('./render.js');
  const { figureLabels } = await import('./visualText.js');
  const { reconstructRaster, cropBounds, rasterCaption } = await import('./rasterVisuals.js');
  let done = 0, failed = 0;
  for (const [i, blocks] of pageBlocks.entries()) {
    const scan = pageData[i].scannedPage;
    // Avoid a second OCR pass on text-heavy scans.
    if (scan && (!pageData[i].ocr || pageData[i].words.length > 100)) continue;
    const images = blocks.filter(({ type, bbox: b }) => type === 'image' &&
      b.x1 - b.x0 >= 56 && b.y1 - b.y0 >= 36);
    if (!images.length) continue;
    const page = await doc.getPage(i + 1);
    try {
      onProgress({ stage: 'image-ocr', page: i + 1, pages: pageBlocks.length });
      const vp = page.getViewport({ scale: 1 });
      const scale = Math.min(4, 3400 / Math.max(vp.width, vp.height));
      const render = await renderPage(page, scale);
      const worker = await getWorker(langs, ocrRuntime);
      const seen = new Map();
      for (const block of images) {
        const b = block.bbox;
        const x = Math.max(0, Math.floor(b.x0 * scale)), y = Math.max(0, Math.floor(b.y0 * scale));
        const w = Math.min(render.w, Math.ceil(b.x1 * scale)) - x;
        const h = Math.min(render.h, Math.ceil(b.y1 * scale)) - y;
        if (w <= 0 || h <= 0) continue;
        const key = [x, y, w, h].join(':');
        if (seen.has(key)) continue;
        seen.set(key, true);
        const { canvas, ctx } = await makeCanvas(w, h);
        ctx.drawImage(render.canvas, x, y, w, h, 0, 0, w, h);
        const pixels = ctx.getImageData(0, 0, w, h);
        const recognize = async (box, mode, filter) => {
          const [x0, y0, x1, y1] = cropBounds(box, w, h);
          if (x1 - x0 < 6 || y1 - y0 < 6) return { text: '', words: [] };
          const pad = 10;
          const { canvas: crop, ctx: c, isNode } = await makeCanvas(x1 - x0 + pad * 2, y1 - y0 + pad * 2);
          c.fillStyle = 'white';
          c.fillRect(0, 0, crop.width, crop.height);
          if (filter === 'ink') {
            const bitmap = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
            for (let k = 0; k < bitmap.data.length; k += 4) {
              const v = Math.max(bitmap.data[k], bitmap.data[k + 1], bitmap.data[k + 2]);
              const ink = v < 150 ? v : 255;
              bitmap.data[k] = bitmap.data[k + 1] = bitmap.data[k + 2] = ink;
            }
            c.putImageData(bitmap, pad, pad);
          } else c.drawImage(canvas, x0, y0, x1 - x0, y1 - y0, pad, pad, x1 - x0, y1 - y0);
          try {
            const { data } = await worker.recognize(isNode ? crop.toBuffer('image/png') : crop,
              { tessedit_pageseg_mode: mode }, { text: true, blocks: true });
            return { text: data.text || '', words: collectWords(data).filter((v) => v.str.trim())
              .map(({ str, bbox, conf }) => ({ str: str.trim(), conf, x0: bbox.x0 + x0 - pad,
                x1: bbox.x1 + x0 - pad, y: bbox.y1 + y0 - pad, size: bbox.y1 - bbox.y0 })) };
          } finally {
            crop.width = crop.height = 0;
          }
        };
        const { words } = await recognize({ x0: 0, y0: 0, x1: w, y1: h }, '11');
        const readable = words.filter((v) => v.conf >= 52);
        const rules = () => {
          const gray = { w, h, stride: 1, data: new Uint8Array(w * h) };
          for (let j = 0; j < gray.data.length; j++) {
            const k = j * 4;
            gray.data[j] = Math.max(pixels.data[k], pixels.data[k + 1], pixels.data[k + 2]);
          }
          return detectRuledLines(gray, w, h, 1);
        };
        const visual = await reconstructRaster(pixels, words, recognize, rules, rasterCaption(pageData[i].words, b));
        const lines = figureLabels(readable);
        if (visual || (!scan && lines.length)) {
          block.rasterVisual = visual || undefined;
          block.ocrLines = lines;
          done++;
        }
        canvas.width = canvas.height = 0;
      }
      render.canvas.width = render.canvas.height = 0;
    } catch (e) {
      failed++;
      if (failed === 1) console.warn('ingestlab: image OCR unavailable:', e?.message || e);
    } finally {
      page.cleanup?.();
    }
  }
  return { done, failed };
}
