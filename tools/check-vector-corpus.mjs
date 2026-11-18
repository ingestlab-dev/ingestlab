import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { openDocument } from '../src/pdfio.js';
import { isPureVector } from '../src/vectorVisuals.js';
import { renderPage } from '../src/render.js';

const [source, output] = process.argv.slice(2);
if (!source || !output) throw new Error('Usage: node tools/check-vector-corpus.mjs <pdf-dir> <svg-export-dir>');

const { results } = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
const expected = [[34, 'Figure', 1, 86], [11, 'Level', 67, 86]];
assert.equal(results.length, expected.length, 'both diagram PDFs are required');
let checked = 0, worstDelta = 0, worstMismatch = 0;
for (const [pages, prefix, first, last] of expected) {
  const entry = results.find((e) => e.pages === pages && e.status === 'ok');
  assert.ok(entry);
  assert.equal(entry.vectorUnrepresented, 0);
  const markdown = await readFile(join(output, entry.markdown), 'utf8');
  assert.doesNotMatch(markdown, /^!\[.*\]\([^)\n]+\.(?:webp|png|jpe?g)\)$/im);
  const assets = new Map();
  const ids = new RegExp('^' + prefix + ' (\\d+)\\b(?!\\.)');
  for (const asset of entry.assets) {
    assert.equal(asset.kind, 'vector-reconstruction');
    assert.ok(markdown.includes('](' + asset.path + ')'), 'asset is not linked by Markdown: ' + asset.path);
    const id = Number(asset.caption?.match(ids)?.[1]);
    if (!id) continue;
    assert.ok(!assets.has(id), 'duplicate link to numbered figure ' + id);
    assets.set(id, asset);
  }
  assert.deepEqual([...assets.keys()].sort((a, b) => a - b), Array.from({ length: last - first + 1 }, (_, i) => i + first));

  const { doc, task } = await openDocument(new Uint8Array(await readFile(join(source, entry.source))));
  try {
    const scale = 2;
    for (let n = 1; n <= pages; n++) {
      const onPage = [...assets].filter(([, a]) => a.page === n);
      if (!onPage.length) continue;
      const page = await doc.getPage(n);
      const reference = await renderPage(page, scale);
      for (const [id, asset] of onPage) {
        const svg = await readFile(join(output, decodeURIComponent(asset.path)));
        assert.ok(isPureVector(svg.toString('utf8')), 'not accepted vector SVG: ' + asset.path);
        const { x, y, w, h } = asset.area;
        const vector = await loadImage(svg, { svg: { width: w * scale, height: h * scale } });
        assert.equal(vector.width, w);
        assert.equal(vector.height, h);
        const { width, height } = { width: w * scale, height: h * scale };
        const rendered = createCanvas(width, height).getContext('2d');
        rendered.fillStyle = '#ffffff';
        rendered.fillRect(0, 0, width, height);
        rendered.drawImage(vector, 0, 0, width, height);
        const expectedPixels = reference.ctx.getImageData(x * scale, y * scale, width, height).data;
        const actualPixels = rendered.getImageData(0, 0, width, height).data;
        let delta = 0, mismatch = 0, ink = 0;
        for (let i = 0; i < expectedPixels.length; i += 4) {
          const d = Math.max(Math.abs(actualPixels[i] - expectedPixels[i]),
            Math.abs(actualPixels[i + 1] - expectedPixels[i + 1]), Math.abs(actualPixels[i + 2] - expectedPixels[i + 2]));
          delta += d;
          if (d > 64) mismatch++;
          if (Math.min(actualPixels[i], actualPixels[i + 1], actualPixels[i + 2]) < 210) ink++;
        }
        const count = width * height;
        const mean = delta / count / 255, fraction = mismatch / count;
        const name = entry.source + ', ' + prefix + ' ' + id;
        assert.ok(ink >= count * 0.002, name + ': blank render');
        assert.ok(mean <= 0.015 && fraction <= 0.01, name + ': pixel mismatch ' + JSON.stringify({ mean, fraction }));
        worstDelta = Math.max(mean, worstDelta);
        worstMismatch = Math.max(fraction, worstMismatch);
        checked++;
      }
      page.cleanup?.();
    }
  } finally {
    await task.destroy();
  }
}
assert.equal(checked, 106);
console.log('106/106 numbered figures: linked SVG paths only, correct dimensions, nonblank, and compared to source PDF.');
console.log('Worst mean channel difference: ' + (100 * worstDelta).toFixed(2) +
  '%. Worst fraction of pixels differing by >64/255: ' + (100 * worstMismatch).toFixed(2) + '%.');
