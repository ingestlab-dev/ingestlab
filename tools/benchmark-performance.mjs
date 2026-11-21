import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { IngestLab } from '../src/index.js';

const files = process.argv.slice(2);
if (!files.length) throw new Error('Usage: node tools/benchmark-performance.mjs <pdf> [...]');
const lab = await IngestLab.init();
const results = [];
for (const file of files) {
  const path = resolve(file);
  const bytes = new Uint8Array(await readFile(path));
  const started = performance.now();
  let pagesReady = 0;
  const result = await lab.parse(bytes, {
    cache: false,
    onPage: () => { pagesReady++; },
  });
  const elapsedMs = performance.now() - started;
  results.push({
    file: basename(path),
    inputBytes: bytes.byteLength,
    pages: result.stats.pages,
    pagesReady,
    words: result.stats.words,
    tables: result.stats.tables,
    ocrPages: result.stats.ocrPages,
    ocrConfidence: result.stats.ocrConfidence,
    latencyMs: Math.round(elapsedMs * 10) / 10,
    pagesPerSecond: Math.round(result.stats.pages / Math.max(elapsedMs / 1000, 0.001) * 1000) / 1000,
    heapUsedBytes: process.memoryUsage?.().heapUsed ?? null,
  });
}
const report = { generatedAt: new Date().toISOString(), results };
const output = resolve(process.env.INGESTLAB_PERF_OUTPUT || 'output/pdf/performance.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
