import assert from 'node:assert/strict';
import { describeFrame, frameDistance, selectStoryboard } from '../src/storyboard.js';
import { IngestLab } from '../src/index.js';
import { createCanvas } from '@napi-rs/canvas';

const pattern = (variant) => {
  const width = 40, height = 24;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const light = [x < 20, y < 12, x >= 20, y >= 12][variant];
    data.set([light ? 217 : 38, light ? 217 : 38, light ? 217 : 38, 255], i);
  }
  return describeFrame({ data, width, height });
};
const durationUs = 341000000;
const boundaries = [0, 10000000, 12000000, 50000000, 112000000, 113000000, 244000000, 329000000];
const frames = Array.from({ length: 4 }, (_, i) => pattern(i));
assert.ok(Math.abs(frames[0].mean - frames[1].mean) < 1e-10);
assert.ok(frameDistance(frames[0], frames[1]) > 0.2);
const samples = Array.from({ length: 341 * 4 }, (_, i) => {
  const timestampUs = i * 250000;
  const scene = boundaries.findLastIndex((t) => t <= timestampUs);
  return { timestampUs, frame: frames[scene % 4] };
});
samples[401] = { ...samples[401], frame: frames[0] }; // A short flash is not a scene.
const { selected, scenes } = selectStoryboard(samples, durationUs);
assert.deepEqual(scenes.map((s) => s.startUs), boundaries);
assert.equal(new Set(selected.map((f) => f.sceneId)).size, boundaries.length);
assert.ok(selected.length >= 57);
const times = [0, ...selected.map((f) => f.timestampUs), durationUs];
assert.ok(times.every((t, i) => i === 0 || (t > times[i - 1] && t - times[i - 1] <= 6500000)));
const limited = selectStoryboard(samples, durationUs, { maxKeyframes: 6 });
assert.equal(limited.selected.length, 6);
assert.ok(limited.selected[0].timestampUs < 40000000);
assert.ok(limited.selected.at(-1).timestampUs > 300000000);

const canvas = createCanvas(640, 2400);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#034689';
ctx.fillRect(0, 0, 640, 1180);
ctx.fillStyle = 'white';
ctx.fillRect(0, 1200, 640, 1200);
const lab = await IngestLab.init();
const result = await lab.ingest(await canvas.encode('png'), { imageMaxEdge: 1000 });
assert.equal(result.kind, 'image');
assert.equal(result.width, 267);
assert.equal(result.height, 1000);
assert.equal(result.keyframes[0].blob.type, 'image/webp');
assert.ok(result.metrics.outputBytes < result.metrics.originalBytes);
const tiny = createCanvas(1, 1);
const small = await lab.ingest(await tiny.encode('png'));
assert.ok(small.metrics.outputBytes <= small.metrics.originalBytes);
const gif = Buffer.from('R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=', 'base64');
const original = await lab.ingest(gif);
assert.deepEqual(Buffer.from(await original.keyframes[0].blob.arrayBuffer()), gif);
console.log('Storyboard coverage, cuts without histogram changes, image sizing and GIF preservation: OK');
