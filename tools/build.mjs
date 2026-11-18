import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: ['src/index.js', 'src/widget.js'],
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  outdir: 'dist',
  legalComments: 'linked',
  external: ['node:*', '@napi-rs/canvas', 'pdfjs-dist', 'tesseract.js', 'onnxruntime-web'],
});
