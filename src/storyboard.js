const finite = (n, fallback, min, max) => Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;

export function storyboardOptions(opts = {}) {
  return {
    sceneThreshold: finite(opts.sceneThreshold, 0.12, 0.02, 1),
    maxKeyframes: Number.isFinite(opts.maxKeyframes) ? Math.floor(finite(opts.maxKeyframes, 0, 1, 1000)) : null,
    minGapUs: finite(opts.minGapUs, 250000, 0, 60000000),
    fillThreshold: finite(opts.fillThreshold, null, 0, 1),
    contextIntervalUs: finite(opts.contextIntervalUs, 6000000, 500000, 120000000),
    collectGapUs: finite(opts.collectGapUs, 125000, 40000, 10000000),
    collectMaxFrames: Math.floor(finite(opts.collectMaxFrames, 3600, 2, 12000)),
  };
}

export function samplingInterval(duration, opts) {
  return Math.max(opts.collectGapUs, Math.ceil(duration / (opts.collectMaxFrames - 1)));
}

export function describeFrame({ data, width, height }) {
  const colors = new Float32Array(data.length / 4 * 3);
  let energy = 0, mean = 0, bright = 0, clipped = 0, contrast = 0;
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    colors[j] = y;
    colors[j + 1] = (r - g) / 255;
    colors[j + 2] = (b - g) / 255;
    mean += y;
    bright += Number(y > 0.065);
    clipped += Number(y > 0.97);
    if ((j / 3) % width) energy += Math.abs(y - colors[j - 3]);
    if (j >= width * 3) energy += Math.abs(y - colors[j - width * 3]);
  }
  const count = width * height;
  const average = mean / count;
  for (let i = 0; i < colors.length; i += 3) contrast += Math.abs(colors[i] - average);
  return { colors, mean: average, sharpness: energy / count, textSaliency: Math.min(1, energy / count * 3 + contrast / count * 2),
    blank: bright / count < 0.04 || clipped / count > 0.96 };
}

export function frameDistance(a, b) {
  let sum = 0, structure = 0;
  const shift = a.mean - b.mean;
  for (let i = 0; i < a.colors.length; i += 3) {
    const delta = a.colors[i] - b.colors[i];
    sum += Math.abs(delta) * 0.48 + (Math.abs(a.colors[i + 1] - b.colors[i + 1]) +
      Math.abs(a.colors[i + 2] - b.colors[i + 2])) * 0.13;
    structure += Math.abs(delta - shift);
  }
  return (sum + structure * 0.36) / (a.colors.length / 3);
}

function bestFrame(samples, transitions, lo, hi, target, span) {
  let best = lo, max = -Infinity;
  for (let i = lo; i <= hi; i++) {
    const { timestampUs, frame } = samples[i];
    const score = -Math.abs(timestampUs - target) / Math.max(span, 1) +
      Math.min(frame.sharpness, 0.24) * 0.65 + (frame.textSaliency || 0) * 0.18 -
      (transitions[i] ? 2 : 0) - (frame.blank ? 3 : 0);
    if (score > max) { best = i; max = score; }
  }
  return best;
}

function findCuts(samples, diffs, o) {
  const transitions = new Uint8Array(samples.length);
  const gradual = new Set();
  const time = (i) => samples[i].timestampUs;
  const frame = (i) => samples[i].frame;
  const register = (before, after) => {
    transitions.fill(1, before + 1, after);
    if (frame(before).blank || frame(after).blank ||
        frameDistance(frame(before), frame(after)) < o.sceneThreshold * 0.7) return;
    const center = (time(before) + time(after)) / 2;
    let mid = before + 1;
    while (mid < after && time(mid + 1) <= center) mid++;
    gradual.add(mid);
  };
  for (let i = 1; i < samples.length - 1; i++) {
    if (!frame(i).blank || frame(i - 1).blank) continue;
    let before = i - 1, after = i + 1;
    while (after < samples.length && frame(after).blank) after++;
    if (after >= samples.length || time(after) - time(before) > 1800000) continue;
    const down = frame(i).mean < 0.5;
    const level = (j) => down ? frame(j).mean : 1 - frame(j).mean;
    while (before > 0 && !frame(before - 1).blank && level(before - 1) > level(before) + 0.025 &&
      time(i) - time(before - 1) <= 700000) before--;
    while (after + 1 < samples.length && !frame(after + 1).blank && level(after + 1) > level(after) + 0.025 &&
      time(after + 1) - time(i) <= 700000) after++;
    register(before, after);
    i = after - 1;
  }
  // A dissolve follows a consistent color path rather than reversing direction.
  const floor = Math.max(0.009, o.sceneThreshold * 0.10);
  for (let i = 1; i < samples.length; i++) {
    if (diffs[i] < floor || transitions[i] || transitions[i - 1]) continue;
    let j = i, path = diffs[i], peak = diffs[i];
    while (j + 1 < samples.length && diffs[j + 1] >= floor && !transitions[j + 1]) {
      j++;
      path += diffs[j];
      peak = Math.max(peak, diffs[j]);
    }
    const span = time(j) - time(i - 1);
    const direct = frameDistance(frame(i - 1), frame(j));
    const dissolve = j - i >= 2 && path >= Math.max(0.09, o.sceneThreshold) &&
      peak < path * 0.52 && direct >= path * 0.82;
    if (span <= 1800000 && dissolve) register(i - 1, j);
    i = j;
  }
  const cuts = [0];
  for (let i = 1; i < samples.length; i++) {
    const last = cuts.at(-1);
    if (time(i) - time(last) < o.minGapUs) continue;
    if (gradual.has(i)) { cuts.push(i); continue; }
    if (transitions[i] || transitions[i - 1] || frame(i).blank || frame(i - 1).blank) continue;
    const neighborhood = diffs.slice(Math.max(1, i - 8), i).concat(diffs.slice(i + 1, i + 9)).sort((a, b) => a - b);
    const noise = neighborhood[Math.floor(neighborhood.length / 2)] || 0;
    const quietSide = Math.min(diffs[i - 1], diffs[i + 1] ?? noise) < o.sceneThreshold * 0.25;
    const bar = Math.max(0.04, o.sceneThreshold * (quietSide ? 0.56 : 0.88), noise * 2.05);
    if (diffs[i] < bar) continue;
    // Ignore single-frame flashes, but keep longer inserts.
    const returns = (at) => at > 0 && at + 1 < samples.length &&
      diffs[at] >= bar && diffs[at + 1] >= bar &&
      frameDistance(frame(at - 1), frame(at + 1)) < bar * 0.45;
    if (returns(i) || returns(i - 1)) continue;
    cuts.push(i);
  }
  return { cuts, transitions };
}

export function selectStoryboard(samples, durationUs, options = {}) {
  if (!samples.length) return { selected: [], scenes: [] };
  const o = storyboardOptions(options);
  const diffs = samples.map((s, i) => i ? frameDistance(samples[i - 1].frame, s.frame) : 0);
  const { cuts, transitions } = findCuts(samples, diffs, o);
  const limit = o.maxKeyframes ?? Math.min(300, Math.max(cuts.length, 12, Math.ceil(durationUs / 2000000)));
  const scenes = cuts.map((lo, id) => {
    const next = cuts[id + 1];
    return {
      id, startUs: id ? samples[lo].timestampUs : 0,
      endUs: next == null ? durationUs : samples[next].timestampUs,
      lo, hi: next == null ? samples.length - 1 : next - 1,
      diffScore: diffs[lo],
    };
  });
  const candidates = [];
  for (const s of scenes) {
    const span = s.endUs - s.startUs;
    const count = Math.max(1, Math.min(s.hi - s.lo + 1, Math.ceil(span / o.contextIntervalUs)));
    const slice = span / count;
    let lo = s.lo;
    for (let n = 0; n < count && lo <= s.hi; n++) {
      const left = s.startUs + n * slice, right = left + slice;
      let hi = lo;
      while (hi < s.hi && samples[hi + 1].timestampUs < right) hi++;
      const center = left + slice * 0.45;
      const index = bestFrame(samples, transitions, lo, hi, center, slice);
      candidates.push({ index, timestampUs: samples[index].timestampUs, sceneId: s.id,
        diffScore: n === 0 ? s.diffScore : diffs[index], isSceneCut: n === 0 && s.id > 0,
        saliency: samples[index].frame.textSaliency || 0,
        reason: n === 0 ? 'scene' : 'context' });
      lo = hi + 1;
    }
    if (o.fillThreshold != null) {
      for (let i = s.lo + 1; i < s.hi; i++) {
        if (diffs[i] < o.fillThreshold || diffs[i] <= diffs[i - 1] || diffs[i] < diffs[i + 1] ||
            samples[i].frame.blank || transitions[i]) continue;
        if (candidates.some((c) => c.sceneId === s.id && Math.abs(c.timestampUs - samples[i].timestampUs) < o.minGapUs)) continue;
        candidates.push({ index: i, timestampUs: samples[i].timestampUs, sceneId: s.id,
          diffScore: diffs[i], saliency: samples[i].frame.textSaliency || 0, isSceneCut: false, reason: 'context' });
      }
    }
  }
  candidates.sort((a, b) => a.timestampUs - b.timestampUs);
  const selected = candidates.length <= limit ? candidates : [];
  if (candidates.length > limit) {
    const representatives = candidates.filter((c) => c.reason === 'scene');
    if (representatives.length <= limit) {
      selected.push(...representatives);
      const contexts = candidates.filter((c) => c.reason === 'context');
      // Use leftover picks to fill the largest gaps in the timeline.
      const distance = (c) => selected.reduce((d, k) => Math.min(d, Math.abs(k.timestampUs - c.timestampUs)),
        Math.min(c.timestampUs, durationUs - c.timestampUs));
      while (selected.length < limit && contexts.length) {
        let best = 0, gap = -1;
        for (let i = 0; i < contexts.length; i++) {
          const d = distance(contexts[i]);
          if (d > gap) { best = i; gap = d; }
        }
        selected.push(contexts.splice(best, 1)[0]);
      }
    } else {
      const buckets = Array.from({ length: limit }, () => []);
      for (const c of representatives) {
        buckets[Math.min(limit - 1, Math.floor(c.timestampUs / Math.max(durationUs, 1) * limit))].push(c);
      }
      const compare = (a, b) => b.diffScore - a.diffScore;
      for (const b of buckets) {
        if (!b.length) continue;
        b.sort(compare);
        selected.push(b.shift());
      }
      selected.push(...buckets.flat().sort(compare).slice(0, limit - selected.length));
    }
    selected.sort((a, b) => a.timestampUs - b.timestampUs);
  }
  const sceneResults = scenes.map(({ id, startUs, endUs, diffScore }) => ({ id, startUs, endUs, diffScore }));
  const represented = new Set(selected.map(({ sceneId }) => sceneId));
  const gaps = [0, ...selected.map(({ timestampUs }) => timestampUs), durationUs];
  return {
    selected,
    scenes: sceneResults,
    scenesRepresented: represented.size,
    sceneCoverage: sceneResults.length ? represented.size / sceneResults.length : 1,
    maxFrameGapUs: Math.max(...gaps.slice(1).map((gap, index) => gap - gaps[index])),
  };
}
