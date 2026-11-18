// PDF layout profiling, based on pdf2md and pymupdf4llm.

export function buildProfile(pageWordsList) {
  const sizeHist = new Map();
  const fontHist = new Map();
  const gaps = [];
  for (const words of pageWordsList) {
    let prevY = null;
    for (const w of words || []) {
      if (!w.str || !w.str.trim()) continue;
      const s = Math.round((w.size || 0) * 2) / 2;
      if (s >= 4 && s <= 24) sizeHist.set(s, (sizeHist.get(s) || 0) + 1);
      const f = String(w.font || '').replace(/^[A-Z]{6}\+/, '').trim();
      if (f) fontHist.set(f, (fontHist.get(f) || 0) + 1);
      if (prevY !== null && w.y - prevY > 1 && w.y - prevY < 4 * (w.size || 10)) {
        gaps.push(Math.round((w.y - prevY) * 10) / 10);
      }
      prevY = w.y;
    }
  }
  gaps.sort((a, b) => a - b);
  let bodySize = 10;
  let best = 0;
  for (const [s, n] of sizeHist) {
    if (n > best) {
      best = n;
      bodySize = s;
    }
  }
  let bodyFont = '';
  let bestF = 0;
  for (const [f, n] of fontHist) {
    if (n > bestF) {
      bestF = n;
      bodyFont = f;
    }
  }
  return {
    bodySize,
    bodyFont,
    medianLineGap: gaps.length ? gaps[Math.floor(gaps.length / 2)] : 12,
    sizes: Object.fromEntries([...sizeHist].sort((a, b) => b[1] - a[1]).slice(0, 8)),
  };
}

export function stripRepeatingChrome(pages, opts = {}) {
  const dropped = pages.map(() => new Set());
  const { support = 0.4, band = 0.1, minPages = 2 } = opts;
  const patterns = new Map();
  for (let i = 0; i < pages.length; i++) {
    const { lines, height } = pages[i];
    for (let li = 0; li < lines.length; li++) {
      const ln = lines[li];
      if (ln.y > height * band && ln.y < height * (1 - band)) continue;
      const norm = String(ln.text || '').trim().replace(/\d+/g, '#').replace(/\s+/g, ' ').toLowerCase();
      if (!norm || norm.length < 3) {
        if (/^[\d#/\s.-]+$/.test(String(ln.text || '').trim())) dropped[i].add(li);
        continue;
      }
      if (!patterns.has(norm)) patterns.set(norm, new Set());
      patterns.get(norm).add(i);
    }
  }
  let stripped = 0;
  const flagged = new Set();
  for (const [norm, pageSet] of patterns) {
    if (pageSet.size >= Math.max(minPages, Math.ceil(support * pages.length))) flagged.add(norm);
  }
  for (let i = 0; i < pages.length; i++) {
    const { lines, height } = pages[i];
    for (let li = 0; li < lines.length; li++) {
      const ln = lines[li];
      if (ln.y > height * band && ln.y < height * (1 - band)) continue;
      const raw = String(ln.text || '').trim();
      const norm = raw.replace(/\d+/g, '#').replace(/\s+/g, ' ').toLowerCase();
      const tokens = raw.split(/\s+/);
      const numTok = tokens.filter((t) => /^[\d#./-]+$/.test(t)).length;
      const chromeKw = /\b(page|of|omb|rev|form|cat|no\.?)\b/i.test(raw);
      const chromeLike =
        raw.length <= 64 &&
        (numTok >= Math.max(1, tokens.length - 2) || (chromeKw && numTok >= 1));
      if (flagged.has(norm) && chromeLike) {
        dropped[i].add(li);
        stripped++;
      }
    }
  }
  return { dropped, stripped };
}
