import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demuxVideo } from '../src/demux.js';
import { describeFrame, selectStoryboard } from '../src/storyboard.js';

const temp = mkdtempSync(join(tmpdir(), 'ingestlab-storyboard-'));
try {
  execFileSync(process.execPath, [fileURLToPath(new URL('./make_storyboard_fixture.mjs', import.meta.url)), temp]);
  const path = join(temp, 'storyboard-montage.mp4');
  const { durationUs, chunks } = demuxVideo(readFileSync(path));
  assert.equal(durationUs, 12000000);
  const real = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time', '-of', 'json', path], { encoding: 'utf8' }));
  const origin = Math.min(...chunks.map((c) => c.timestampUs));
  const presented = chunks.map((c) => c.timestampUs - origin);
  assert.ok(presented.some((t, i) => i && t < presented[i - 1]), 'Fixture must use reordered frames');
  assert.equal(presented.length, real.packets.length);
  assert.ok(presented.every((t, i) => Math.abs(t - Number(real.packets[i].pts_time) * 1e6) <= 1.00001),
    'Packet presentation times must match ffprobe within 1 microsecond of rounding');

  const rgba = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-vf', "select=not(mod(n\\,3)),scale=40:24", '-fps_mode', 'passthrough',
    '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1']);
  const size = 40 * 24 * 4;
  const samples = Array.from({ length: rgba.length / size }, (_, i) => ({
    timestampUs: i * 125000,
    frame: describeFrame({ data: rgba.subarray(i * size, (i + 1) * size), width: 40, height: 24 }),
  }));
  const { scenes, selected } = selectStoryboard(samples, durationUs);
  const expected = [0, 1, 1.375, 1.75, 2.125, 5, 7.5, 10].map((t) => t * 1e6);
  assert.equal(scenes.length, expected.length);
  assert.ok(scenes.every((s, i) => Math.abs(s.startUs - expected[i]) <= 125000),
    'Unexpected cut times: ' + scenes.map((s) => s.startUs / 1e6).join(', '));
  assert.ok(selected.every(({ index }) => !samples[index].frame.blank));
  assert.ok(selected.every(({ timestampUs: t }) => !(t >= 4500000 && t < 5500000) && !(t >= 7000000 && t < 8000000)));
  console.log('Encoded montage: 8 shots, MP4 timestamps match ffprobe, fades and flashes avoided');
} finally {
  rmSync(temp, { recursive: true });
}
