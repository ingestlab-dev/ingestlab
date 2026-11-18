// PDF text spans, based on pdf2md and pdfplumber.

export function dedupFauxBold(words) {
  const removed = [];
  const seen = new Map();
  const out = [];
  for (const w of words) {
    if (!w.str || !w.str.trim()) continue;
    // Bucket nearby glyph positions to find overprinted duplicates.
    const key = `${w.str}|${Math.round(w.x0 * 2)}|${Math.round(w.y * 2)}`;
    const prev = seen.get(key);
    if (prev) {
      prev._fauxBold = true;
      removed.push(w);
      continue;
    }
    seen.set(key, w);
    out.push(w);
  }
  for (const w of out) {
    if (w._fauxBold) {
      w.font = String(w.font || '') + '|FauxBold';
      delete w._fauxBold;
    }
  }
  return { words: out, removed: removed.length };
}

const BOLD_FONT_RE = /bold|black|heavy|semib|demibold|FauxBold/i;
const ITALIC_FONT_RE = /italic|oblique/i;
const MATH_FONT_RE2 = /(CMMI|CMSY|CMEX|MSAM|MSBM|EUFM|STIX|CAMBRIA[- ]?MATH|LMMATH|LATIN[- ]?MODERN|TEXGYRE.?MATH|SYMBOL)/i;

export function fontFlags(font = '') {
  const f = String(font).replace(/^[A-Z]{6}\+/, '');
  return {
    isBold: BOLD_FONT_RE.test(f),
    isItalic: ITALIC_FONT_RE.test(f),
    isMonospace: /mono|courier|consol|menlo|CMTT|CMBK/i.test(f),
    isSerif: /times|georgia|garamond|book|serif|CM(R|TI|TT)|Roman|Cambria|Minion/i.test(f),
    isTeXMath: MATH_FONT_RE2.test(f),
  };
}

export function buildSpans(lineWords) {
  const spans = [];
  for (const w of lineWords) {
    const flags = fontFlags(w.font);
    const dy = (w.y || 0) - (lineWords._base ?? (lineWords._base = medianY(lineWords)));
    const style = {
      bold: flags.isBold,
      italic: flags.isItalic,
      code: flags.isMonospace,
      math: flags.isTeXMath,
      sup: dy < -0.28 * (w.size || 10),
      sub: dy > 0.28 * (w.size || 10),
    };
    const key = JSON.stringify(style);
    const last = spans[spans.length - 1];
    if (last && last._key === key) {
      last.text += (last.text ? ' ' : '') + w.str;
      last.x1 = w.x1;
    } else {
      spans.push({ text: w.str, style, x0: w.x0, x1: w.x1, _key: key });
    }
  }
  for (const s of spans) delete s._key;
  return spans;
}

function medianY(words) {
  const ys = words.map((w) => w.y || 0).sort((a, b) => a - b);
  return ys[Math.floor(ys.length / 2)] || 0;
}

export function spansToInlineMarkdown(spans) {
  let out = '';
  for (const s of spans || []) {
    let t = s.text;
    if (!t) continue;
    if (s.style.math) t = `$${t}$`;
    else {
      if (s.style.bold) t = `**${t.trim()}**`;
      if (s.style.italic) t = `*${t.trim()}*`;
      if (s.style.code) t = '`' + t.trim() + '`';
    }
    out += (out && !out.endsWith(' ') && !t.startsWith(' ') ? ' ' : '') + t;
  }
  return out.replace(/\*\* \*\*/g, ' ').replace(/\* \*/g, ' ').replace(/`` ` ``/g, ' ').replace(/  +/g, ' ');
}
