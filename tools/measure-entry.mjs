// Measure the gzipped size of the ingestlab public entry point (src/index.js)
// after esbuild bundling with code-splitting. Spec gate: entry < 30 KB gz, and
// the video engine (video.js + demux.js + keyframes.js) must land in its own
// lazy chunk, never in the entry.
//
//   npm run bundle:size        (or: node tools/measure-entry.mjs [--json])

import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const res = await build({
  entryPoints: [path.join(PKG, 'src/index.js')],
  bundle: true,
  splitting: true,
  format: 'esm',
  target: ['es2020'],
  outdir: path.join(PKG, 'tools/.tmp-bundle'),
  write: false,
  metafile: true,
  minify: true,
  legalComments: 'none',
  logLevel: 'silent',
  // peers stay external: pdf.js is dynamic-imported at runtime, onnx is optional
  external: ['pdfjs-dist', 'pdfjs-dist/*', 'onnxruntime-web', 'onnxruntime-web/*', 'tesseract.js', '@napi-rs/canvas', 'node:*', 'module'],
});

const gzText = (t) => gzipSync(Buffer.from(t, 'utf8')).length;
const entry = res.outputFiles.find((f) => f.path.endsWith('index.js'));
const chunks = res.outputFiles.filter((f) => f !== entry);

const entryGz = gzText(entry.text);
const videoEntry = Object.entries(res.metafile.outputs)
  .find(([, output]) => output.entryPoint?.endsWith('src/video.js'));
const videoChunk = videoEntry && chunks.find((chunk) => chunk.path.endsWith(videoEntry[0].split('/').pop()));
const rows = [
  { name: 'entry (index.js)', raw: Buffer.byteLength(entry.text), gz: entryGz },
  ...chunks.map((c) => ({
    name: 'chunk ' + c.path.split('/').pop().replace('.js', '') + (c === videoChunk ? ' [video engine]' : ''),
    raw: Buffer.byteLength(c.text),
    gz: gzText(c.text),
  })),
];

const LIMIT = 30 * 1024;
const videoIsLazy = !!videoChunk && !Object.entries(res.metafile.outputs)
  .some(([name, output]) => name !== videoEntry[0] &&
    Object.keys(output.inputs).some((input) => input.endsWith('src/video.js')));
const pass = entryGz < LIMIT && videoIsLazy;

if (process.argv[2] === '--json') {
  console.log(JSON.stringify({ pass, entryGz, limit: LIMIT, videoIsLazy, rows }, null, 2));
} else {
  for (const r of rows) {
    console.log(`${r.name.padEnd(28)} raw ${String(r.raw).padStart(7)} B   gz ${String(r.gz).padStart(6)} B`);
  }
  console.log(
    pass
      ? `\nGATE PASS: entry ${entryGz} B gz < ${LIMIT} B limit, video engine is a lazy chunk`
      : `\nGATE FAIL: entry ${entryGz} B gz (limit ${LIMIT}) or video engine missing as a chunk`
  );
}
process.exit(pass ? 0 : 1);
