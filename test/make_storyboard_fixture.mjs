// Generate an H.264 clip with known visual cuts, fades, and short inserts.
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';

const folder = process.argv[2] || fileURLToPath(new URL('../output/media/', import.meta.url));
mkdirSync(folder, { recursive: true });
const width = 320, height = 180, fps = 24, duration = 12;
const canvas = createCanvas(width, height);
const ctx = canvas.getContext('2d');
const expected = [0, 1, 1.375, 1.75, 2.125, 5, 7.5, 10];
const palette = ['#ffe18c', '#88badc', '#9bd3b4', '#e6b0d2', '#e9b69e', '#c8c0f2', '#f8d7c8', '#afe0e3'];
const ffmpeg = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'rawvideo', '-pixel_format', 'rgba',
  '-video_size', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0', '-an',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '48', '-movflags', '+faststart',
  folder + '/storyboard-montage.mp4'], { stdio: ['pipe', 'inherit', 'inherit'] });
const closed = once(ffmpeg, 'close');

function paint(scene, t) {
  ctx.fillStyle = palette[scene];
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#171d28';
  if (scene % 4 === 0) ctx.fillRect(0, 0, 112, height);
  if (scene % 4 === 1) ctx.fillRect(0, 0, width, 72);
  if (scene % 4 === 2) ctx.fillRect(196, 0, 124, height);
  if (scene % 4 === 3) ctx.fillRect(0, 104, width, 76);
  ctx.fillStyle = '#363d49';
  ctx.fillRect(40 + Math.floor(t * 12) % 240, 94, 16, 16);
  ctx.fillStyle = '#111111';
  ctx.fillRect(119, 79, 82, 22);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 15px sans-serif';
  ctx.fillText('Shot ' + (scene + 1), 132, 95);
}

for (let i = 0; i < duration * fps; i++) {
  const t = i / fps;
  const scene = expected.findLastIndex((start) => start <= t);
  if (t >= 4.5 && t < 5.5) {
    paint(4, t);
    ctx.globalAlpha = (t - 4.5);
    paint(5, t);
    ctx.globalAlpha = 1;
  } else {
    paint(scene, t);
  }
  if ((t >= 7 && t < 8) || (t >= 9.958 && t < 10)) {
    ctx.globalAlpha = t < 8 ? Math.max(0, 1 - Math.abs(t - 7.5) * 2) : 1;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = 1;
  }
  if (i === 219) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  if (!ffmpeg.stdin.write(Buffer.from(ctx.getImageData(0, 0, width, height).data))) await once(ffmpeg.stdin, 'drain');
}
ffmpeg.stdin.end();
const [code] = await closed;
if (code) throw new Error('ffmpeg exited with code ' + code);
console.log('Expected cut times:', expected);
