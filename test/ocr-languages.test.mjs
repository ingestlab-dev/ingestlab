import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, PDFDocument } from '@napi-rs/canvas';
import { IngestLab, OCR_LANGUAGE_CODES } from '../src/index.js';
import { normalizeOcrLanguages } from '../src/ocrLanguages.js';
import { extractPage, openDocument } from '../src/pdfio.js';

assert.equal(OCR_LANGUAGE_CODES.length, 123);
assert.equal(new Set(OCR_LANGUAGE_CODES).size, OCR_LANGUAGE_CODES.length);
assert.equal(normalizeOcrLanguages(['jpn', 'eng', 'jpn']), 'jpn+eng');
assert.throws(() => normalizeOcrLanguages('jpn+../eng'), /model codes/);

const cases = [
  ['deu', 'Pr\u00fcfung der deutschen Sprache', 'Pr\u00fcfung der deutschen Sprache'],
  ['fra', 'Une \u00e9cole de langue fran\u00e7aise', 'Une \u00e9cole de langue fran\u00e7aise'],
  ['rus', '\u041f\u0440\u043e\u0432\u0435\u0440\u043a\u0430 \u0440\u0443\u0441\u0441\u043a\u043e\u0433\u043e \u044f\u0437\u044b\u043a\u0430', '\u041f\u0440\u043e\u0432\u0435\u0440\u043a\u0430 \u0440\u0443\u0441\u0441\u043a\u043e\u0433\u043e \u044f\u0437\u044b\u043a\u0430'],
  ['hin', '\u092f\u0939 \u0939\u093f\u0928\u094d\u0926\u0940 \u092d\u093e\u0937\u093e \u0915\u093e \u092a\u0930\u0940\u0915\u094d\u0937\u0923 \u0939\u0948', '\u092d\u093e\u0937\u093e \u0915\u093e \u092a\u0930\u0940\u0915\u094d\u0937\u0923'],
  ['ara', '\u0647\u0630\u0627 \u0627\u062e\u062a\u0628\u0627\u0631 \u0644\u0644\u063a\u0629 \u0627\u0644\u0639\u0631\u0628\u064a\u0629', '\u0627\u062e\u062a\u0628\u0627\u0631 \u0644\u0644\u063a\u0629 \u0627\u0644\u0639\u0631\u0628\u064a\u0629'],
  ['chi_sim', '\u8fd9\u662f\u4e2d\u6587\u8bc6\u522b\u6d4b\u8bd5', '\u4e2d\u6587\u8bc6\u522b\u6d4b\u8bd5'],
  ['jpn+eng', '\u65e5\u672c\u8a9e\u306e\u8a8d\u8b58\u30c6\u30b9\u30c8\nEnglish reference number 4528', '\u65e5\u672c\u8a9e\u306e\u8a8d\u8b58\u30c6\u30b9\u30c8'],
];
const lab = await IngestLab.init();
const langPath = process.env.INGESTLAB_TESSDATA_DIR;
const output = process.env.INGESTLAB_OCR_FIXTURES_DIR;
if (output) mkdirSync(output, { recursive: true });
for (const [lang, text, expected] of cases) {
  const canvas = createCanvas(1440, 440);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'black';
  ctx.textAlign = 'center';
  ctx.font = '64px sans-serif';
  for (const [i, line] of text.split('\n').entries()) ctx.fillText(line, 720, 175 + i * 128);
  const pdf = new PDFDocument();
  pdf.beginPage(720, 220).drawImage(canvas, 0, 0, 720, 220);
  pdf.endPage();
  const bytes = new Uint8Array(pdf.close());
  if (output) writeFileSync(join(output, lang + '.pdf'), bytes);
  const source = await openDocument(bytes);
  try { assert.equal((await extractPage(await source.doc.getPage(1), source.pdfjs)).words.length, 0); }
  finally { await source.task.destroy(); }
  const result = await lab.parse(bytes, {
    cache: false, ocrLangs: lang.split('+'),
    ...(langPath ? { ocrRuntime: { langPath, gzip: false } } : {}),
  });
  assert.equal(result.stats.ocrPages, 1, lang);
  const normalized = result.markdown.normalize('NFC').replace(/\p{Bidi_Control}/gu, '');
  assert.ok(normalized.includes(expected), lang + ': got ' + normalized);
  if (lang === 'jpn+eng') {
    assert.match(normalized, /English reference number 4528/);
    assert.doesNotMatch(normalized, /Text read from the image/);
  }
  console.log(lang + ': recognized and exported to Markdown');
}
