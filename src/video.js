
import { demuxVideo } from './demux.js';
import { sniffKind } from './kind.js';
import { describeFrame, samplingInterval, selectStoryboard, storyboardOptions } from './storyboard.js';

export const DEFAULT_USD_PER_FRAME_CLOUD = 0.0008;

const DEFAULTS = {
  sceneThreshold: 0.12,
  maxKeyframes: null,
  minGapUs: 250000,
  contextIntervalUs: 6000000,
  keyframeMaxWidth: 960,
  webpQuality: 0.84,
  usdPerFrameCloud: DEFAULT_USD_PER_FRAME_CLOUD,
  collectGapUs: 125000,
  collectMaxFrames: 3600,
};

export function histogram2dFromImageData(data) {
  const bins = new Float64Array(64);
  for (let px = 0; px < data.length; px += 4) {
    const luma = 0.2126 * data[px] + 0.7152 * data[px + 1] + 0.0722 * data[px + 2];
    let bin = (luma * 0.25) | 0;
    if (bin > 63) bin = 63;
    bins[bin]++;
  }
  return bins;
}

/** Retained for compatibility; storyboard analysis has no retained GPU device. */
export function destroyVideoEngine() { return false; }

async function decodeAll(demux, onFrame) {
  let error;
  const pending = new Set();
  const decoder = new VideoDecoder({
    output(frame) {
      let work;
      try {
        work = onFrame(frame);
      } catch (e) {
        error ||= e;
      } finally {
        frame.close();
      }
      if (work) {
        const job = Promise.resolve(work).catch((e) => { error ||= e; }).finally(() => pending.delete(job));
        pending.add(job);
      }
    },
    error(e) { error ||= e; },
  });
  const config = {
    codec: demux.codec,
    codedWidth: demux.codedWidth,
    codedHeight: demux.codedHeight,
    optimizeForLatency: true,
  };
  if (demux.description) config.description = demux.description;
  try {
    decoder.configure(config);
    for (const c of demux.chunks) {
      if (error) break;
      decoder.decode(new EncodedVideoChunk({
        type: c.type, timestamp: c.timestampUs, duration: c.durationUs || undefined, data: c.data,
      }));
      while ((decoder.decodeQueueSize > 16 || pending.size > 8) && !error) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (!error) await decoder.flush();
    if (error) throw error;
  } finally {
    if (decoder.state !== 'closed') decoder.close();
    await Promise.all(pending);
  }
  if (error) throw error;
}

function waitForVideo(video, event, start) {
  return new Promise((resolve, reject) => {
    const done = (error) => {
      clearTimeout(timeout);
      video.removeEventListener(event, ok);
      video.removeEventListener('error', fail);
      error ? reject(error) : resolve();
    };
    const ok = () => done();
    const fail = () => done(new Error('ingestlab video: media decoding failed'));
    const timeout = setTimeout(() => done(new Error('ingestlab video: media decoding timed out')), 15000);
    video.addEventListener(event, ok, { once: true });
    video.addEventListener('error', fail, { once: true });
    try { start(); } catch (e) { done(e); }
  });
}

function seekOnce(video, t) {
  if (Math.abs(video.currentTime - t) < 0.000001 && video.readyState >= 2 && !video.seeking) return Promise.resolve();
  return waitForVideo(video, 'seeked', () => { video.currentTime = t; });
}

async function withVideo(bytes, kind, fn) {
  const video = document.createElement('video');
  const url = URL.createObjectURL(new Blob([bytes], { type: kind }));
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  try {
    await waitForVideo(video, 'loadeddata', () => { video.src = url; });
    return await fn(video);
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

function frameReader() {
  const canvas = new OffscreenCanvas(40, 24);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return (source) => {
    ctx.drawImage(source, 0, 0, 40, 24);
    return describeFrame(ctx.getImageData(0, 0, 40, 24));
  };
}

function encodeFrame(source, width, height, o) {
  const scale = Math.min(1, o.keyframeMaxWidth / Math.max(width, height));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.convertToBlob({ type: 'image/webp', quality: o.webpQuality }).finally(() => {
    canvas.width = canvas.height = 0;
  });
}

const valid = (n, min, max, fallback) => Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;

export function videoOptions(opts = {}) {
  return { ...storyboardOptions(opts),
    keyframeMaxWidth: valid(opts.keyframeMaxWidth, 32, 4096, DEFAULTS.keyframeMaxWidth),
    webpQuality: valid(opts.webpQuality, 0, 1, DEFAULTS.webpQuality) };
}

export async function analyzeVideo(bytes, opts = {}) {
  const o = videoOptions(opts);
  const kind = sniffKind(bytes);
  if (kind !== 'video/mp4' && kind !== 'video/webm') throw new Error(`ingestlab video: unsupported container "${kind}"`);
  const canSeek = typeof document !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
  const canDecode = typeof VideoDecoder !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
  const progress = (stage, done, total) => opts.onProgress?.({ stage, mediaDone: done, mediaTotal: total });

  const assemble = (samples, durationUs, width, height, backend, decodeRetried, selected, scenes, blobs) => {
    const keyframes = selected.map(({ index, ...k }, i) => ({
      ...k, timestamp: k.timestampUs / 1e6, blob: blobs[i],
    }));
    const gaps = [0, ...keyframes.map((k) => k.timestampUs), durationUs];
    return { keyframes, scenes, width, height, durationUs, backend, decodeRetried,
      framesProcessed: samples.length, sceneCuts: Math.max(0, scenes.length - 1),
      scenesRepresented: new Set(keyframes.map((k) => k.sceneId)).size,
      maxFrameGapUs: Math.max(...gaps.slice(1).map((g, i) => g - gaps[i])) };
  };

  let failure;
  if (canDecode) {
    try {
      const demux = demuxVideo(bytes);
      if (!demux.chunks.length) throw new Error('ingestlab video: no video frames found');
      let durationUs = demux.durationUs, width = demux.codedWidth, height = demux.codedHeight;
      const readFrame = frameReader();
      const samples = [];
      const interval = samplingInterval(durationUs, o);
      const origin = demux.chunks.reduce((min, c) => Math.min(min, c.timestampUs), Infinity);
      let next = 0, lastSeen = 0, bucket = -1;
      await decodeAll(demux, (frame) => {
        const t = Math.max(0, frame.timestamp - origin);
        width = frame.displayWidth || width;
        height = frame.displayHeight || height;
        lastSeen = Math.max(lastSeen, t + (frame.duration || 0));
        // Rounded MP4 timestamps can fall just below a sampling boundary.
        const sampleTime = t + 2;
        if (sampleTime < next && t < durationUs - 55000) return;
        if (samples.length && t <= samples.at(-1).timestampUs) return;
        samples.push({ timestampUs: t, frame: readFrame(frame) });
        next = (Math.floor(sampleTime / interval) + 1) * interval;
        const p = Math.floor(t / Math.max(1, durationUs) * 100);
        if (p !== bucket) { bucket = p; progress('video-analysis', Math.min(100, p), 100); }
      });
      durationUs = Math.max(durationUs, lastSeen);
      if (!samples.length) throw new Error('ingestlab video: no frames could be analyzed');
      const { selected, scenes } = selectStoryboard(samples, durationUs, o);
      const wanted = new Map(selected.map((s, i) => [s.timestampUs + origin, i]));
      const blobs = new Array(selected.length);
      // Decode again to export the selected frames without retaining every sample.
      let exported = 0;
      await decodeAll(demux, (frame) => {
        const index = wanted.get(frame.timestamp);
        if (index == null) return;
        wanted.delete(frame.timestamp);
        return encodeFrame(frame, width, height, o).then((blob) => {
          blobs[index] = blob;
          progress('video-export', ++exported, blobs.length);
        });
      });
      if (wanted.size) throw new Error('ingestlab video: some selected frames could not be decoded');
      return assemble(samples, durationUs, width, height, 'webcodecs-2d', false, selected, scenes, blobs);
    } catch (e) {
      failure = e;
    }
  }

  if (!canSeek) throw failure || new Error('ingestlab video: keyframe extraction requires browser APIs; use IngestLab in a browser, not plain Node.js');
  return withVideo(bytes, kind, async (video) => {
    let durationUs = Math.round(video.duration * 1e6);
    if (!Number.isFinite(durationUs) || durationUs <= 0) durationUs = demuxVideo(bytes).durationUs;
    if (!Number.isFinite(durationUs) || durationUs <= 0) throw new Error('ingestlab video: unknown duration');
    const readFrame = frameReader();
    const width = video.videoWidth, height = video.videoHeight;
    const end = Math.max(0, durationUs - 35000);
    const interval = samplingInterval(durationUs, o);
    const count = Math.floor(end / interval) + 1;
    const samples = [];
    for (let i = 0; i < count; i++) {
      const timestampUs = i * interval;
      await seekOnce(video, timestampUs / 1e6);
      samples.push({ timestampUs, frame: readFrame(video) });
      if (i % 12 === 0 || i + 1 === count) progress('video-analysis', i + 1, count);
    }
    const { selected, scenes } = selectStoryboard(samples, durationUs, o);
    const blobs = [];
    for (const s of selected) {
      await seekOnce(video, s.timestampUs / 1e6);
      blobs.push(await encodeFrame(video, width, height, o));
      progress('video-export', blobs.length, selected.length);
    }
    return assemble(samples, durationUs, width, height, 'seek-2d', !!failure, selected, scenes, blobs);
  });
}

export { DEFAULTS as VIDEO_DEFAULTS };
