import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const markdownIt = (await build({
  stdin: { contents: "export { default } from 'markdown-it';", resolveDir: root },
  bundle: true, minify: true, format: 'esm', platform: 'browser', write: false,
})).outputFiles[0].contents;
const pdfDirs = [resolve(root, 'demo', 'samples'), resolve(root, process.env.INGESTLAB_PDF_DIR || '../pdf')];
const port = Number(process.env.PORT || '4173');
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.md': 'text/plain; charset=utf-8',
};
const files = new Map([['/', join(root, 'demo', 'index.html')]]);
for (const lang of ['eng', 'vie']) files.set('/ocr-lang/' + lang + '.traineddata', join(root, lang + '.traineddata'));
const presets = new Map([['f1040.pdf', 'form1040'], ['f1040 (1).pdf', 'form1040'], ['lm358.pdf', 'lm358'],
  ['1706.03762v7.pdf', 'transformer'], ['1706.03762.pdf', 'transformer'], ['viet-nam-2025.pdf', 'vietnam'],
  ['IngestLab Diagrams, Charts & Math Test Suite.pdf', 'diagram']]);
for (const dir of pdfDirs) {
  const samples = await readdir(dir).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  for (const name of samples) {
    const match = name.normalize('NFC').match(/^s\u01a1 \u0111\u1ed3 v\u00e0 bi\u1ec3u \u0111\u1ed3 ([12])\.pdf$/u);
    const id = match?.[1] || presets.get(name);
    if (id && !files.has('/sample/' + id)) files.set('/sample/' + id, join(dir, name));
  }
}
const mounts = [
  ['/demo/', resolve(root, 'demo')],
  ['/src/', resolve(root, 'src')],
  ['/vendor/pdfjs/', resolve(root, 'node_modules', 'pdfjs-dist')],
  ['/vendor/ocr/', resolve(root, 'node_modules', 'tesseract.js', 'dist')],
  ['/vendor/ocr-core/', resolve(root, 'node_modules', 'tesseract.js-core')],
];

function locate(path) {
  if (files.has(path.normalize('NFC'))) return files.get(path.normalize('NFC'));
  for (const [prefix, dir] of mounts) {
    if (!path.startsWith(prefix)) continue;
    const local = resolve(dir, path.slice(prefix.length));
    if (local.startsWith(dir + sep)) return local;
  }
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/vendor/markdown-it.mjs') {
      res.writeHead(200, { 'Content-Type': types['.mjs'], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : markdownIt);
      return;
    }
    const path = locate(pathname);
    const info = path && await stat(path);
    if (!info?.isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream',
      'Content-Length': info.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache',
      ...(pathname.startsWith('/sample/') ? { 'X-Sample-Filename': encodeURIComponent(path.split(sep).at(-1)) } : {}) });
    if (req.method === 'HEAD') res.end();
    else {
      const stream = createReadStream(path);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    }
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' ? 404 : error instanceof URIError ? 400 : 500).end();
  }
});
server.listen(port, '127.0.0.1', () => console.log('IngestLab demo: http://127.0.0.1:' + server.address().port));
