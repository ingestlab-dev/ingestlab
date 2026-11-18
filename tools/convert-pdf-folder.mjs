#!/usr/bin/env node
// Convert top-level PDFs to Markdown with source visuals.
// Usage: node tools/convert-pdf-folder.mjs <pdf-folder> <output-folder> [--no-ocr]
// Headers and footers are retained by default to prioritize complete content.

import { readdir, readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { IngestLab } from '../src/index.js';
import { renderMarkdown } from '../src/widget.js';

const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith('--'));
const [inputArg, outputArg] = positional;
if (!inputArg || !outputArg) {
  console.error('Usage: node tools/convert-pdf-folder.mjs <pdf-folder> <output-folder> [--html] [--no-ocr|--no-ocr-images] [--ocr-langs=jpn+eng] [--with-source|--figures-only|--vector-only] [--match=substring]');
  process.exit(2);
}
const inputDir = path.resolve(inputArg);
const outputDir = path.resolve(outputArg);
if (inputDir === outputDir || outputDir.startsWith(inputDir + path.sep)) {
  console.error('Output folder must be outside the PDF input folder.');
  process.exit(2);
}
const noOcr = args.includes('--no-ocr');
const ocrLangs = args.find((arg) => arg.startsWith('--ocr-langs='))?.slice('--ocr-langs='.length);
const html = args.includes('--html');
const vectorOnly = args.includes('--vector-only');
const textOnly = args.includes('--text-only');
const withSource = args.includes('--with-source');
const figuresOnly = args.includes('--figures-only');
if ([vectorOnly, textOnly, withSource, figuresOnly].filter(Boolean).length > 1)
  throw new Error('Choose only one visual output option');
const match = args.find((arg) => arg.startsWith('--match='))?.slice(8)?.normalize('NFC');
const entries = (await readdir(inputDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.pdf') &&
    (!match || entry.name.normalize('NFC').includes(match)))
  .sort((a, b) => a.name.localeCompare(b.name, 'en'));
if (!entries.length) {
  console.error(`No top-level PDF files found in ${inputDir}`);
  process.exit(1);
}
await mkdir(outputDir, { recursive: true });
const lab = await IngestLab.init();
const manifestPath = path.join(outputDir, 'manifest.json');
const previous = match ? await readFile(manifestPath, 'utf8').then(JSON.parse, (error) => {
  if (error.code !== 'ENOENT') throw error;
  return null;
}) : null;
const prior = previous?.inputDir === inputDir ? previous.results.filter((r) => !entries.some((e) => e.name === r.source)) : [];
const results = [];

for (let i = 0; i < entries.length; i++) {
  const name = entries[i].name;
  const stem = path.basename(name, path.extname(name));
  const mdPath = path.join(outputDir, `${stem}.md`);
  console.log(`[${i + 1}/${entries.length}] Parsing ${name}`);
  try {
    const bytes = new Uint8Array(await readFile(path.join(inputDir, name)));
    const doc = await lab.parse(bytes, {
      cache: false,
      semanticHtml: html,
      ocr: !noOcr,
      ...(ocrLangs !== undefined ? { ocrLangs } : {}),
      ocrImages: !args.includes('--no-ocr-images'),
      imageMode: withSource || figuresOnly || vectorOnly ? 'refs' : 'none',
      preservePages: withSource,
      vectorFigures: vectorOnly,
      skipRasterFigures: vectorOnly,
      ocrCacheDir: process.env.INGESTLAB_OCR_CACHE,
      // Repeated headers/footers may carry useful information: retain them.
      dropHeadersFooters: false,
      onProgress: (ev) => {
        if (ev.stage === 'ocr' && ((ev.ocrDone ?? ev.page) % 20 === 0 || ev.ocrDone === ev.ocrTotal))
          console.log(`  OCR ${ev.ocrDone ?? ev.page}/${ev.ocrTotal ?? ev.pages}`);
      },
    });
    const assetRoot = path.join('assets', stem);
    if (doc.assets.length) await mkdir(path.join(outputDir, assetRoot, 'images'), { recursive: true });
    for (const asset of doc.assets) await writeFile(path.join(outputDir, assetRoot, asset.path), asset.bytes);
    const escapedRoot = assetRoot.split(path.sep).map((part) =>
      encodeURIComponent(part).replace(/[()]/g, (c) => '%' + c.charCodeAt(0).toString(16))).join('/');
    const markdown = doc.markdown.replace(/^(!\[.*?\]\()(images\/p\d+(?:(?:-v\d+)?\.(?:png|webp)|-vector\d+\.svg))\)$/gm,
      (_, open, image) => `${open}${escapedRoot}/${image})`);
    await writeFile(mdPath, markdown, 'utf8');
    const htmlFile = html ? stem + '.html' : null;
    if (htmlFile) {
      const body = renderMarkdown(doc.richMarkdown, doc.assets);
      await writeFile(path.join(outputDir, htmlFile), '<!doctype html>\n<meta charset="utf-8">\n' +
        '<title>IngestLab PDF export</title>\n<style>body{font:16px system-ui;max-width:70rem;margin:2rem auto;padding:0 1rem}' +
        'table{border-collapse:collapse;margin:1rem 0}th,td{border:1px solid #bbb;padding:.4rem;text-align:left;vertical-align:top}' +
        'img{max-width:100%;height:auto}fieldset{margin:1rem 0}.il-field{margin:.4rem 0}</style>\n' + body +
        (doc.formHtml ? '<section><h2>PDF controls</h2>' + doc.formHtml + '</section>' : ''), 'utf8');
    }
    if (doc.stats.visualFailed === 0) {
      const imagesDir = path.join(outputDir, assetRoot, 'images');
      const generated = await readdir(imagesDir).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return [];
      });
      const current = new Set(doc.assets.map((asset) => path.basename(asset.path)));
      for (const image of generated) {
        if (/^p\d+(?:(?:-v\d+)?\.(?:png|webp)|-vector\d+\.svg)$/.test(image) && !current.has(image)) await unlink(path.join(imagesDir, image));
      }
    }
    results.push({
      source: name,
      markdown: path.basename(mdPath),
      ...(htmlFile ? { html: htmlFile, controls: doc.controls.length } : {}),
      pages: doc.stats.pages,
      words: doc.stats.words,
      tables: doc.stats.tables,
      forms: doc.stats.forms,
      figures: doc.stats.figures,
      ocrPages: doc.stats.ocrPages,
      ocrFailed: doc.stats.ocrFailed,
      imageOcrRegions: doc.stats.imageOcrRegions,
      imageOcrFailed: doc.stats.imageOcrFailed,
      scannedUnread: doc.stats.scannedUnread,
      sourceBytes: bytes.length,
      markdownBytes: Buffer.byteLength(markdown),
      elapsedMs: doc.stats.ms,
      visualFailed: doc.stats.visualFailed,
      vectorFigures: doc.stats.vectorFigures,
      vectorFailed: doc.stats.vectorFailed,
      vectorUnrepresented: doc.stats.vectorUnrepresented,
      assets: doc.assets.map(({ path: image, page, bytes, ...metadata }) =>
        ({ path: `${escapedRoot}/${image}`, page, bytes: bytes.length, ...metadata })),
      status: 'ok',
    });
    console.log(`  OK ${doc.stats.pages} pages · ${doc.stats.words} words · ${doc.stats.tables} tables · ${doc.stats.forms} forms · ${doc.stats.figures} figures · ${doc.stats.ocrPages} OCR pages`);
    if (vectorOnly && doc.stats.vectorFailed) {
      console.warn(`  ${doc.stats.vectorFailed} figure(s) could not be drawn as SVG; ${doc.stats.vectorUnrepresented} also lack a data or relationship representation.`);
    }
  } catch (error) {
    const message = String(error?.stack || error);
    results.push({ source: name, status: 'error', error: message });
    console.error(`  FAILED ${message.split('\n')[0]}`);
  }
  const merged = [...prior, ...results].sort((a, b) => a.source.localeCompare(b.source, 'en'));
  await writeFile(manifestPath, JSON.stringify({ inputDir, results: merged }, null, 2));
}

const failed = results.filter((result) => result.status !== 'ok');
console.log(`Finished: ${results.length - failed.length}/${results.length} PDFs converted; output: ${outputDir}`);
if (failed.length || results.some((r) => r.visualFailed || r.vectorUnrepresented ||
  (!noOcr && (r.ocrFailed || r.imageOcrFailed)))) process.exitCode = 1;
