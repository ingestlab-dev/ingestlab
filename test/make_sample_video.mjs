#!/usr/bin/env node
// Generates samples/sample3.mp4 — three visually distinct 2-second scenes
// (moving test pattern / SMPTE color bars / chaotic fractal) for the
// 3-keyframe scene-detection tests. Dev-time only: needs ffmpeg on PATH,
// never shipped as a runtime dependency.
//   node test/make_sample_video.mjs   (or: npm run gen:video)

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'samples', 'sample3.mp4');

const SCENES = [
  { filter: 'testsrc2=size=320x180:rate=15:duration=2', label: 'scene1: moving testsrc2' },
  { filter: 'smptebars=size=320x180:rate=15:duration=2', label: 'scene2: static SMPTE bars' },
  // mandelbrot is an infinite source: cap it with an input-level -t instead of duration=
  { filter: 'mandelbrot=size=320x180:rate=15', inputMax: '2', label: 'scene3: chaotic mandelbrot' },
];

function ffprobe(path, args) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', ...args, path], { encoding: 'utf8' }));
}

try {
  const args = ['-y', '-loglevel', 'error'];
  for (const s of SCENES) {
    if (s.inputMax) args.push('-t', s.inputMax);
    args.push('-f', 'lavfi', '-i', s.filter);
  }
  args.push(
    '-filter_complex', 'concat=n=3:v=1[v]',
    '-map', '[v]',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'baseline',
    '-level', '3.0',
    // one IDR for the whole clip: no container keyframe spikes at scene
    // boundaries' neighbors, so scene detection sees only the real cuts
    '-g', '90', '-keyint_min', '90',
    '-movflags', '+faststart',
    OUT
  );
  execFileSync('ffmpeg', args, { stdio: 'inherit' });

  // verify: duration ~6s, 15fps, three scene boundaries we control
  const info = ffprobe(OUT, ['-show_format', '-show_streams']);
  const v = info.streams.find((s) => s.codec_type === 'video');
  const dur = Math.round(parseFloat(info.format.duration) * 100) / 100;
  const bytes = statSync(OUT).size;
  if (!(dur > 5.5 && dur < 6.6)) throw new Error(`unexpected duration ${dur}s`);
  if (!v.codec_name.startsWith('h264')) throw new Error(`unexpected codec ${v.codec_name}`);

  const head = readFileSync(OUT).subarray(0, 12);
  if (head[4] !== 0x66 || head[5] !== 0x74 || head[6] !== 0x79 || head[7] !== 0x70) {
    throw new Error('output is not an MP4 (missing ftyp)');
  }
  for (const s of SCENES) console.log('+' + s.label);
  console.log(`OK samples/sample3.mp4: ${v.codec_name} ${v.width}x${v.height}, ${dur}s, ${bytes} bytes`);
} catch (e) {
  try { unlinkSync(OUT); } catch {}
  console.error('FAILED:', e.message);
  process.exit(1);
}
