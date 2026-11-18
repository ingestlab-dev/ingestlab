
export const BINS = 64;

export function normalize(hist) {
  let total = 0;
  for (let i = 0; i < hist.length; i++) total += hist[i];
  const p = new Float64Array(hist.length);
  if (total === 0) {
    p.fill(1 / hist.length);
    return p;
  }
  for (let i = 0; i < hist.length; i++) p[i] = hist[i] / total;
  return p;
}

// Bhattacharyya distance: 0 for identical histograms, 1 for disjoint ones.
export function bhattacharyyaDistance(p, q) {
  let bc = 0;
  const n = Math.min(p.length, q.length);
  for (let i = 0; i < n; i++) bc += Math.sqrt(p[i] * q[i]);
  const d2 = 1 - bc;
  return d2 <= 0 ? 0 : Math.sqrt(d2);
}

export function diffSeries(histograms) {
  const dists = histograms.map(normalize);
  const out = new Float64Array(histograms.length);
  for (let i = 1; i < histograms.length; i++) {
    out[i] = bhattacharyyaDistance(dists[i - 1], dists[i]);
  }
  return out;
}

export function selectKeyframes(timestampsUs, diffs, opts = {}) {
  const { sceneThreshold = 0.12, maxKeyframes = 8, minGapUs = 600000, fillThreshold, adaptive = true } = opts;
  if (!timestampsUs.length) return [];
  const n = Math.min(timestampsUs.length, diffs.length);

  // Adapt the cut threshold to surrounding motion.
  let bar = sceneThreshold;
  if (adaptive) {
    const d = [...diffs.slice(1, n)].sort((a, b) => a - b);
    const med = d[Math.floor(d.length / 2)] || 0;
    const dev = d.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    const mad = dev[Math.floor(dev.length / 2)] || 0;
    bar = Math.max(0.05, Math.min(sceneThreshold, med + 6 * mad));
  }

  const chosen = [{ index: 0, timestampUs: timestampsUs[0], diffScore: 0, isSceneCut: false }];
  const cuts = [];
  for (let i = 1; i < n; i++) {
    if (diffs[i] >= bar) {
      cuts.push({ index: i, timestampUs: timestampsUs[i], diffScore: diffs[i], isSceneCut: true });
    }
  }
  // Check against every selected frame; picks aren't in time order.
  const gapOK = (t) => chosen.every((c) => Math.abs(t - c.timestampUs) >= minGapUs);

  for (const cut of [...cuts].sort((a, b) => b.diffScore - a.diffScore)) {
    if (chosen.length >= maxKeyframes) break;
    if (gapOK(cut.timestampUs)) chosen.push(cut);
  }
  // Fill unused slots with local peaks, using a lower default threshold.
  if (chosen.length < maxKeyframes) {
    const fillBar = fillThreshold === undefined ? Math.max(0.35 * bar, 0.02) : fillThreshold;
    const rest = [];
    for (let i = 1; i < n; i++) {
      if (!chosen.some((c) => c.index === i)) rest.push(i);
    }
    const peaks = rest.filter((i) => diffs[i] >= (diffs[i - 1] ?? 0) && diffs[i] >= (diffs[i + 1] ?? 0));
    peaks.sort((a, b) => diffs[b] - diffs[a]);
    for (const i of peaks) {
      if (chosen.length >= maxKeyframes) break;
      if (diffs[i] < fillBar) break;
      const t = timestampsUs[i];
      if (gapOK(t)) chosen.push({ index: i, timestampUs: t, diffScore: diffs[i], isSceneCut: false });
    }
  }
  return chosen.sort((a, b) => a.index - b.index);
}
