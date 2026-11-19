
// Legacy TeX fonts without ToUnicode need a glyph map.
const MATH_FONT_RE = /(CMMI|CMSY|CMEX|CMSL|CMTI|MSAM|MSBM|EUFM|EUEX|EUCLID|STIX|CAMBRIA[- ]?MATH|LMMATH|LATIN[- ]?MODERN[- ]?MATH|TEXGYRE.?MATH|SYMBOL)/i;

const GREEK_LOW = 'αβγδεζηθικλμνξοπρστυφχψω';
const OML = {};
for (let i = 0; i < 22; i++) OML[0x0b + i] = GREEK_LOW[i];
OML[0x21] = 'ω';
OML[0x00] = 'Γ'; OML[0x01] = 'Δ'; OML[0x02] = 'Θ'; OML[0x03] = 'Λ';
OML[0x04] = 'Ξ'; OML[0x05] = 'Π'; OML[0x06] = 'Σ'; OML[0x07] = 'Υ';
OML[0x08] = 'Φ'; OML[0x09] = 'Ψ'; OML[0x0a] = 'Ω';
OML[0x22] = 'ε'; OML[0x23] = 'ϑ'; OML[0x24] = 'ϖ'; OML[0x25] = 'ϱ';
OML[0x26] = 'ς'; OML[0x27] = 'φ'; OML[0x40] = '∂';
const OMS = {
  0x00: '−', 0x01: '·', 0x02: '×', 0x03: '∗', 0x04: '÷', 0x06: '±', 0x07: '∓',
  0x08: '⊕', 0x09: '⊖', 0x0a: '⊗', 0x0b: '∘', 0x0c: '•', 0x0d: '∝',
  0x12: '≠', 0x13: '≐', 0x14: '≡', 0x16: '≈', 0x17: '≅', 0x19: '∼', 0x1b: '≈',
  0x20: '⊂', 0x21: '⊃', 0x24: '≤', 0x25: '≥', 0x26: '≺', 0x27: '≻',
  0x28: '←', 0x29: '→', 0x2a: '↑', 0x2b: '↓', 0x2c: '↔',
  0x3c: '<', 0x3d: '/', 0x3e: '>', 0x3f: '⋆', 0x40: '∪', 0x41: '∩',
  0x50: '∋', 0x51: '∈',
};
const MSBM = {};
const DS_MAP = { 0x43: 'ℂ', 0x48: 'ℍ', 0x4e: 'ℕ', 0x50: 'ℙ', 0x51: 'ℚ', 0x52: 'ℝ', 0x5a: 'ℤ' };
for (let c = 0x41; c <= 0x5a; c++) MSBM[c] = DS_MAP[c] || String.fromCodePoint(0x1d538 + (c - 0x41));
const SYMBOL = {};
for (let i = 0; i < 26; i++) {
  SYMBOL[0x61 + i] = GREEK_LOW[i];
  SYMBOL[0x41 + i] = 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ'[i];
}
Object.assign(SYMBOL, {
  0xa3: '≤', 0xa5: '∞', 0xae: '→', 0xb3: '≥', 0xb4: '×', 0xb6: '∂', 0xb9: '≠',
  0xb1: '±', 0xb8: '÷', 0xce: '∈', 0xd5: '∏', 0xd6: '√', 0xe5: '∑', 0xf2: '∫',
  0xd3: '≤', 0xd4: '≥', 0xbb: '∝', 0xd7: '⋅', 0xc0: '∇',
});
const FONT_TABLES = {
  cmmi: OML, cmsy: OMS, msbm: MSBM, msam: OMS, symbol: SYMBOL,
};

export function isMathFont(font = '') {
  return MATH_FONT_RE.test(String(font));
}

export function remapGlyphs(str, font = '') {
  const f = String(font);
  if (!f || !MATH_FONT_RE.test(f)) return str;
  let table = null;
  if (/CMMI/i.test(f)) table = OML;
  else if (/CMSY|MSAM/i.test(f)) table = OMS;
  else if (/MSBM/i.test(f)) table = MSBM;
  else if (/SYMBOL/i.test(f)) table = SYMBOL;
  else if (/CMEX|EUFM|EUEX|STIX|CAMBRIA|LMMATH|LATIN|TEXGYRE/i.test(f)) return str;
  if (!table) return str;
  let out = '';
  let hits = 0;
  for (const ch of str) {
    const rep = table[ch.codePointAt(0)];
    if (rep !== undefined) {
      out += rep;
      hits++;
    } else out += ch;
  }
  return hits ? out : str;
}

const SPEC_RE = /[∑∫∏√∞≈≠≡≤≥±×÷∂∇∈∀∃⊕⊗∝∠°′″⋅·⇒↔αβγδεζηθικλμνξοπρστυφχψωΓΔΘΛΞΠΣΥΦΨΩ]/;
const OP_RE = /[=+\-−*/^_<>(){}[\]|]/;
const DIGIT_RE = /[0-9]/;

export function mathScore(line) {
  const t = line.text || '';
  const len = Math.max(8, [...t].length);
  if (t.length < 4) return 0;
  let spec = 0;
  let ops = 0;
  let digits = 0;
  for (const ch of t) {
    if (SPEC_RE.test(ch)) spec++;
    else if (OP_RE.test(ch)) ops++;
    else if (DIGIT_RE.test(ch)) digits++;
  }
  if (spec + ops < 2) return 0;
  return (spec * 3 + ops + digits * 0.3) / len;
}

// Require an operator so citations and parenthetical text stay prose.
const STRONG_OP_RE = /[=^_\u221a\u2211\u222b\u2260\u2264\u2265\u2248\u00b1\u00d7\u00f7\u2208\u2202+\u2212]/;

const INLINE_MATH_RE =
  /([A-Za-z][A-Za-z0-9]*(?:[_^]\{?[A-Za-z0-9]+\}?)+(?:\s*[=≤≥±×÷≠≈→\u2212\u2013+*/-]\s*[A-Za-z0-9().,^_\u221a\u2212\u2013\-\s]{1,18})*[=≤≥±×÷≠≈\u2212+*/^][A-Za-z0-9().,^_\u221a\u2212\u2013\-\s]{0,24})/g;

export function wrapInlineMath(text) {
  if (!text || text.length < 6 || text.includes('$')) return text;
  return text.replace(INLINE_MATH_RE, (m) => {
    const t = m.trim();
    if (!/[=≤≥±×÷≠≈\u2212+*/^]/.test(t)) return m;
    if (!/[_^]/.test(t) && !/\d\s*[×\u00d7]\s*\d/.test(t)) return m;
    return '$' + t + '$';
  });
}

export function isMathLine(line) {
  const t = line.text || '';
  if (t.length < 4 || !STRONG_OP_RE.test(t)) return false;
  // Underscore runs can be fill-in blanks, not equations.
  const real = t.replace(/[\s_|│\u2500-\u257f\u2010-\u2015.-]/g, '');
  if (real.length < 4) return false;
  return mathScore(line) >= 0.22;
}

export function recoverDisplayFraction(numerator, equation, rules) {
  if (!equation || !isMathLine(equation) || !equation.text.includes('=') ||
      numerator.words.length > 5 || equation.y - numerator.y > 1.5 * equation.size) return null;
  const rule = rules.find((s) => s.pos > Math.max(...numerator.words.map((w) => w.y)) &&
    s.pos < equation.y && s.from >= numerator.x0 - 3 && s.to <= numerator.x1 + 3 &&
    s.from <= numerator.x0 + 2 && s.to >= numerator.x1 - 2);
  if (!rule) return null;

  const words = equation.words.slice().sort((a, b) => a.x0 - b.x0);
  const inside = words.filter((w) => w.x0 >= rule.from - 1 && w.x1 <= rule.to + 1);
  const before = words.filter((w) => !inside.includes(w) && w.x1 <= rule.from + 1);
  const after = words.filter((w) => !inside.includes(w) && w.x0 >= rule.to - 1);
  if (!before.some((w) => w.str.includes('=')) || !after.length ||
      before.length + inside.length + after.length !== words.length) return null;
  const render = (ws) => toMathText({ words: ws, size: Math.max(...ws.map((w) => w.size)) });
  const root = inside[0]?.str === '\u221a' ? inside[0] : null;
  const denominator = root ? inside.slice(1) : inside;
  if (!denominator.length || !denominator.every((w) => w.y > equation.y + 1)) return null;
  let bottom = render(denominator);
  if (root) {
    if (!rules.some((s) => Math.abs(s.pos - root.y) <= 2 && s.from >= root.x0 &&
        s.from <= denominator[0].x0 + 2 && s.to >= denominator.at(-1).x1 - 2 && s.to <= rule.to + 1)) return null;
    const [base, sub] = denominator;
    if (denominator.length === 2 && sub.size < 0.85 * base.size &&
        sub.y > base.y + 1 && sub.x0 <= base.x1 + 1 && /^[\p{L}\d]+$/u.test(sub.str)) {
      bottom = base.str + '_{' + sub.str + '}';
    }
    bottom = '\\sqrt{' + bottom + '}';
  }
  const suffix = render(after).replace(/\s*\((\d+)\)$/, ' \\tag{$1}');
  return render(before) + ' \\frac{' + render(numerator.words) + '}{' + bottom + '}' + suffix;
}

export function toMathText(line) {
  const words = [...line.words].sort((a, b) => a.x0 - b.x0);
  const size = Math.max(1, line.size || 6);
  const fullSize = words.filter((w) => w.size >= 0.9 * size);
  const ys = (fullSize.length ? fullSize : words).map((w) => w.y).sort((a, b) => a - b);
  const base = ys[Math.floor(ys.length / 2)];

  const parts = [];
  for (const w of words) {
    const dy = w.y - base;
    let kind = 'main';
    const threshold = (w.size < 0.9 * size ? 0.22 : 0.28) * size;
    if (dy < -threshold) kind = 'sup';
    else if (dy > threshold) kind = 'sub';
    const last = parts[parts.length - 1];
    if (kind !== 'main' && last && last.kind === kind) last.text += ' ' + w.str;
    else parts.push({ kind, text: w.str });
  }

  let out = '';
  for (const p of parts) {
    const tok = p.text.trim();
    if (!tok) continue;
    if (p.kind === 'main') {
      out += out ? ' ' + tok : tok;
    } else if (out) {
      out = out.replace(/\s+$/, '');
      out += p.kind === 'sup' ? `^{${tok}}` : `_{${tok}}`;
    } else {
      out += tok;
    }
  }
  const m = out.match(/\s*\((\d+(?:\.\d+)+)\)\s*$/);
  if (m) out = out.slice(0, m.index).trim() + ` \\tag{${m[1]}}`;
  return out;
}
