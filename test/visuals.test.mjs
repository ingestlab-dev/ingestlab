import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadImage } from '@napi-rs/canvas';
import { IngestLab } from '../src/index.js';
import { renderMarkdown } from '../src/widget.js';
import { applyImageMode } from '../src/markdown.js';
import { isPureVector } from '../src/vectorVisuals.js';

const dir = process.env.INGESTLAB_PDF_DIR || fileURLToPath(new URL('../../pdf', import.meta.url));
const fixture = join(dir, 'IngestLab Diagrams, Charts & Math Test Suite.pdf');
if (!existsSync(fixture)) {
  console.log('Diagram corpus fixture not present, skipped');
  process.exit(0);
}
const bytes = readFileSync(fixture);
const lab = await IngestLab.init();
const common = { ocr: false, dropHeadersFooters: false };
const vector = await lab.parse(bytes, { ...common, vectorFigures: true, skipRasterFigures: true });
assert.equal(vector.stats.vectorFigures, 3);
assert.equal(vector.stats.vectorFailed, 0);
assert.equal(vector.stats.vectorUnrepresented, 0);
assert.equal(vector.assets.length, 3);
for (const a of vector.assets) {
  assert.equal(a.kind, 'vector-reconstruction');
  assert.ok(isPureVector(new TextDecoder().decode(a.bytes)));
  assert.ok(vector.markdown.includes('](' + a.path + ')'));
}
const svg = vector.assets[0];
const brackets = '![Example \\[label\\]](' + svg.path + ')';
const embeddedSvg = applyImageMode(brackets, vector.assets, 'base64');
assert.match(embeddedSvg, /data:image\/svg\+xml;base64,/);
assert.match(renderMarkdown(embeddedSvg), /<img class="pdf-image"/);
assert.equal(applyImageMode(brackets, vector.assets, 'none').includes('!['), false);
assert.equal(isPureVector('<svg><path/><image href="data:image/png;base64,AA=="/></svg>'), false);
assert.equal(isPureVector('<svg><path/><use href="https://example.com/figure.svg#path"/></svg>'), false);

const result = await lab.parse(bytes, { ...common, preservePages: true });
const md = result.markdown;
assert.equal(result.stats.visualFailed, 0);
assert.equal(result.stats.tables, 1, 'graphical shapes do not become prose tables');
assert.equal(result.stats.figures, 3);
assert.match(md, /N2 -->\|Yes\| N3/);
assert.match(md, /N2 -->\|No\| N4/);
assert.match(md, /P0->>P1: parsePdf\(buffer\)/);
assert.match(md, /P2-->>P1: normalizedBlocks/);
assert.match(md, /P1-->>P0: markdownOutput/);
for (const [q, v] of [42, 68, 85, 96].entries()) assert.ok(md.includes(`| Q${q + 1} | ${v} |`));
assert.ok(md.includes('| Figure 3 (Bar Chart) | chartTableSynthesis |'));
assert.match(md, /S_\{grid\}.*∑_\{i=1\}\^\{N\}.*Δx\^\{2\}.*Δy\^\{2\}/);
assert.doesNotMatch(md, /^N 2 2$/m);
assert.match(md, /\\end\{aligned\}\n\\tag\{1\.1\}/);
assert.equal((md.match(/!\[Source page /g) || []).length, 2);
assert.equal(result.assets.length, 5);
assert.equal((renderMarkdown(md, result.assets).match(/<img class="pdf-image"/g) || []).length, 5);
for (const asset of result.assets) {
  assert.ok(md.includes(`(${asset.path})`));
  const decoded = await loadImage(Buffer.from(asset.bytes));
  assert.ok(decoded.width > 100 && decoded.height > 100, `readable raster: ${asset.path}`);
}
const plain = await lab.parse(bytes, { ...common, imageMode: 'none' });
assert.equal(plain.assets.length, 0);
assert.doesNotMatch(plain.markdown, /!\[/);
assert.match(plain.markdown, /sequenceDiagram/);
const embedded = await lab.ingest(bytes, { ...common, imageMode: 'base64', preservePages: true });
assert.match(embedded.markdown, /\(data:image\/webp;base64,UklGR/);
assert.match(embedded.markdown, /\(data:image\/png;base64,iVBOR/);
assert.equal(embedded.metrics.outputBytes, Buffer.byteLength(embedded.markdown));
console.log('Visual corpus: source renders, exact chart data, Mermaid topology and image modes OK');
