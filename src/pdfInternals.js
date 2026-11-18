
const TEX_CREATOR_RE = /\b(TEX|LATEX|PACIFIC?M|TEXWORKS|KAURA|BASICTEX|MACTEX|MIKTEX)\b/i;
const TEX_PRODUCER_RE = /\b(PDFTEX|XETEX|LUATEX|PDFTFM?|DVIPS|DVIPDFM|HYPERTEX|CONTEX)\b/i;
const OFFICE_RE = /\b(WORD|EXCEL|POWERPOINT|OFFICE|LIBREOFFICE|OPENOFFICE|PAGES|KEYNOTE|GOOGLE DOCS|GSHEET)\b/i;
const VECTOR_TOOL_RE = /\b(MATPLOTLIB|INKSCAPE|ILLUSTRATOR|CORELDRAW|SKIA|FIGMA|CANVA|GIMP|BLENDER|AUTOCAD|SOLIDWORKS|gnuplot|MATLAB|JUPYTER|HEVEA)\b/i;

export async function fingerprintDoc(pdfDoc) {
  const out = { creator: '', producer: '', isTeX: false, isOffice: false, isVectorTool: false };
  try {
    const meta = await pdfDoc.getMetadata();
    const info = meta?.info || {};
    out.creator = String(info.Creator || '');
    out.producer = String(info.Producer || '');
    const hay = `${out.creator} ${out.producer}`;
    out.isTeX = TEX_CREATOR_RE.test(hay) || TEX_PRODUCER_RE.test(hay);
    out.isOffice = OFFICE_RE.test(hay);
    out.isVectorTool = VECTOR_TOOL_RE.test(hay) && !out.isTeX;
  } catch {
  }
  return out;
}

export async function collectOutline(pdfDoc, cap = 600) {
  const out = [];
  try {
    const outline = await pdfDoc.getOutline();
    if (!outline?.length) return out;
    const pageIndexCache = new Map();
    const walk = async (items, depth) => {
      for (const it of items || []) {
        if (out.length >= cap) return;
        let page = -1;
        let d = it.dest;
        try {
          if (typeof d === 'string') d = await pdfDoc.getDestination(d);
        } catch {
          d = it.dest;
        }
        if (Array.isArray(d) && d[0] && typeof d[0] === 'object') {
          const key = `${d[0].num}:${d[0].gen ?? 0}`;
          if (!pageIndexCache.has(key)) {
            try {
              pageIndexCache.set(key, await pdfDoc.getPageIndex(d[0]));
            } catch {
              pageIndexCache.set(key, -1);
            }
          }
          page = pageIndexCache.get(key);
        }
        out.push({ title: String(it.title || '').trim(), page, depth });
        await walk(it.items, depth + 1);
      }
    };
    await walk(outline, 0);
  } catch {
  }
  return out;
}

const ROLE_KEEP = /^(H1|H2|H3|H4|H5|H6|P|L|LI|Lbl|LBody|Table|TR|TH|TD|Figure|Formula|Caption|BlockQuote|Note|Code)$/i;

// Match tagged roles to text resolved by PDF.js.
export async function extractStructRoles(page) {
  const out = [];
  try {
    const tree = await page.getStructTree();
    if (!tree) return out;
    const walk = (node, role) => {
      if (!node) return;
      const own = typeof node.role === 'string' ? node.role.toUpperCase() : role;
      let text = '';
      for (const kid of node.kids || []) {
        if (kid?.type === 'string' && kid.str) text += kid.str;
        else if (kid?.role !== undefined || Array.isArray(kid?.kids)) walk(kid, own);
      }
      if (own && ROLE_KEEP.test(own) && text.trim()) out.push({ role: own.toUpperCase(), text: text.trim().slice(0, 400) });
      else {
        for (const kid of node.kids || []) if (Array.isArray(kid?.kids)) walk(kid, own);
      }
    };
    const walkAll = (node, role) => {
      for (const kid of node?.kids || []) {
        if (kid?.role !== undefined) walk(kid, typeof kid.role === 'string' ? kid.role.toUpperCase() : role);
        else walkAll(kid, role);
      }
    };
    walkAll(tree, '');
  } catch {
  }
  return out;
}

export function buildTypeProfile(pageWordsList) {
  const sizeHist = new Map();
  const fontHist = new Map();
  let total = 0;
  for (const words of pageWordsList) {
    for (const w of words || []) {
      if (!w.str || !w.str.trim()) continue;
      const s = Math.round((w.size || 0) * 2) / 2;
      if (s >= 4 && s <= 20) {
        sizeHist.set(s, (sizeHist.get(s) || 0) + 1);
        total++;
      }
      const f = (w.font || '').replace(/^[A-Z]{6}\+/, '').trim();
      if (f) fontHist.set(f, (fontHist.get(f) || 0) + 1);
    }
  }
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
  return { bodySize, bodyFont, sizeHistogram: total ? Object.fromEntries([...sizeHist].sort((a, b) => b[1] - a[1]).slice(0, 8)) : {} };
}

export function sizeHeadingLevel(size, bodySize, text = '') {
  if (!bodySize || size <= bodySize * 1.05) return 0;
  const ratio = size / bodySize;
  const t = String(text).trim();
  const short = t.length > 0 && t.length <= 120;
  if (!short) return 0;
  if (ratio >= 1.6) return 1;
  if (ratio >= 1.3) return 2;
  if (ratio >= 1.12) return 3;
  return 0;
}
