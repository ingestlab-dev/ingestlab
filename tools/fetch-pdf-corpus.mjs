import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const target = resolve(process.argv[2] || '../pdf/corpus-150/real');
const catalogue = await readFile(new URL('pdf-corpus-sources.tsv', import.meta.url), 'utf8');
const sources = catalogue.trim().split('\n').map((line) => line.split('\t'));
await mkdir(target, { recursive: true });
const download = (url, file) => new Promise((done) => {
  const curl = spawn('curl', ['-fLsS', '--connect-timeout', '8', '--max-time', '40', url, '-o', file]);
  curl.once('error', () => done(false));
  curl.once('exit', (code) => done(code === 0));
});
const inspect = async (path) => {
  const bytes = await readFile(path).catch(() => null);
  if (!bytes || bytes.subarray(0, 8).toString('ascii').slice(0, 5) !== '%PDF-') return null;
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
};
const results = [];
for (let i = 0; i < sources.length && results.length < 50;) {
  const batch = sources.slice(i, i + Math.min(8, 50 - results.length));
  i += batch.length;
  const downloaded = await Promise.all(batch.map(async ([name, url]) => {
    const filename = name + '.pdf';
    const file = join(target, filename);
    let info = await inspect(file);
    if (!info) {
      const temporary = file + '.part';
      if (await download(url, temporary)) info = await inspect(temporary);
      if (!info) {
        await unlink(temporary).catch(() => {});
        return null;
      }
      await rename(temporary, file);
    }
    console.log(filename, info.bytes);
    return { file: filename, url, ...info };
  }));
  for (const item of downloaded) if (item && !results.some((other) => other.sha256 === item.sha256)) results.push(item);
}
await writeFile(join(target, 'manifest.json'), JSON.stringify(results, null, 2) + '\n');
if (results.length !== 50) throw new Error('Expected 50 unique PDFs, downloaded ' + results.length);
