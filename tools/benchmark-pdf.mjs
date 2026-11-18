import { readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { openDocument } from '../src/pdfio.js';

const args = process.argv.slice(2);
const requireSourcePages = !args.includes('--compact');
const [source, output, baseline] = args.filter((arg) => arg !== '--compact');
if (!source || !output) {
  console.error('Usage: node tools/benchmark-pdf.mjs <pdf-dir> <output-dir> [baseline-dir] [--compact]');
  process.exit(2);
}

const words = (text) => text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) || [];
const counts = (tokens) => {
  const result = new Map();
  for (const token of tokens) result.set(token, (result.get(token) || 0) + 1);
  return result;
};
const matches = (a, b) => {
  const other = counts(b);
  return [...counts(a)].reduce((n, [word, count]) => n + Math.min(count, other.get(word) || 0), 0);
};
const textOf = (md) => md
  .replace(/^\x60{3}mermaid\n[\s\S]*?^\x60{3}\s*$/gm, '')
  .replace(/^--- end of page=[^\n]*$/gm, '')
  .replace(/^!\[[^\n]*\]\([^\n]*\)\s*$/gm, '')
  .replace(/^> \[\s*(?:Image|Full-page image)[^\n]*$/gmi, '')
  .replace(/<!--.*?-->|<\/?(?:table|thead|tbody|tr|th|td|br|b|i|p|span)\b[^>]*>/gi, ' ');
const pct = (n, d) => d ? (100 * n / d).toFixed(2) + '%' : 'n/a';

const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
const totals = { tokens: 0, ours: 0, comparedTokens: 0, comparedOurs: 0, reference: 0, compared: 0, pages: 0, assets: 0, assetBytes: 0 };
for (const entry of manifest.results) {
  if (entry.status !== 'ok' || entry.visualFailed || entry.scannedUnread || entry.ocrFailed || entry.imageOcrFailed)
    throw new Error(`Incomplete conversion: ${entry.source}`);
  const md = await readFile(join(output, entry.markdown), 'utf8');
  const outputWords = words(textOf(md));
  const { doc, task } = await openDocument(new Uint8Array(await readFile(join(source, entry.source))));
  const native = [];
  try {
    if (entry.pages !== doc.numPages) throw new Error(`Page count mismatch: ${entry.source}`);
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const text = (await page.getTextContent()).items.map((item) => item.str || '').join(' ');
      // Pages with minimal hidden text are not a usable OCR ground truth.
      if (words(text).length >= 20) native.push(...words(text));
      page.cleanup?.();
    }
  } finally {
    await task.destroy();
  }
  const images = [...md.matchAll(/^!\[[^\n]*\]\((assets\/[^\n)]*)\)$/gm)].map((m) => m[1]);
  const assets = new Set((entry.assets || []).map((item) => item.path));
  if (images.some((p) => !assets.has(p))) throw new Error(`Unknown image reference: ${entry.source}`);
  for (const asset of assets) {
    const info = await stat(join(output, decodeURIComponent(asset)));
    if (!info.isFile() || !info.size || !images.includes(asset)) throw new Error(`Unreferenced or missing asset: ${asset}`);
    totals.assetBytes += info.size;
  }
  const fullPages = new Set(entry.assets.filter((a) => /\/p\d+\.webp$/.test(a.path)).map((a) => a.page));
  if (requireSourcePages && fullPages.size !== entry.pages) throw new Error(`Missing source page: ${entry.source}`);
  if (!requireSourcePages && (/!\[[^\n]*\]\(/.test(md) || assets.size)) throw new Error(`Unexpected image: ${entry.source}`);
  const own = matches(native, outputWords);
  const stem = basename(entry.source, extname(entry.source));
  const reference = baseline && await readFile(join(baseline, stem, 'source.md'), 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  const referenceMatch = reference ? matches(native, words(textOf(reference))) : null;
  if (referenceMatch !== null) {
    totals.reference += referenceMatch;
    totals.comparedTokens += native.length;
    totals.comparedOurs += own;
    totals.compared++;
  }
  totals.tokens += native.length;
  totals.ours += own;
  totals.pages += entry.pages;
  totals.assets += assets.size;
  console.log(`${entry.source}: ${pct(own, native.length)} native tokens, baseline ${referenceMatch === null ? 'missing' : pct(referenceMatch, native.length)}, ${assets.size} images`);
}
console.log(`Corpus: ${manifest.results.length} PDFs, ${totals.pages} source pages, ${totals.assets} verified assets (${(totals.assetBytes / 2 ** 20).toFixed(1)} MiB)`);
console.log(`Native token recall: ${pct(totals.ours, totals.tokens)} (${totals.tokens} tokens); matched subset (${totals.compared} PDFs): IngestLab ${pct(totals.comparedOurs, totals.comparedTokens)} vs baseline ${pct(totals.reference, totals.comparedTokens)}`);
