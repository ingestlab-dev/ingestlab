
export function iou(a, b) {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

export function nms(candidates, thr = 0.5) {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const keep = [];
  for (const c of sorted) {
    if (keep.every((k) => iou(k.box, c.box) < thr)) keep.push(c);
  }
  return keep;
}

const DEFAULT_LABEL_MAP = {
  title: { type: 'heading', level: 1 },
  'plain text': null,
  table: { type: 'table' },
  list: { type: 'list' },
  figure: { type: 'figure' },
};

export function mergeRegions(blocks, regions, labelMap = DEFAULT_LABEL_MAP) {
  const out = blocks.map((b) => ({ ...b }));
  for (const region of regions) {
    const rule = labelMap[region.cls];
    if (!rule) continue;
    const [rx, ry, rw, rh] = region.box;
    for (let i = 0; i < out.length; i++) {
      const b = out[i];
      if (!b.bbox) continue;
      const bb = b.bbox;
      const bx = [bb.x0, bb.y0, bb.x1 - bb.x0, bb.y1 - bb.y0];
      if (rule.type === 'figure') {
        const contained = bx[0] >= rx - 2 && bx[1] >= ry - 2 && bx[0] + bx[2] <= rx + rw + 2 && bx[1] + bx[3] <= ry + rh + 2;
        if (contained) out[i] = { ...b, omitted: true };
      } else if (iou(bx, region.box) > 0.5) {
        out[i] = { ...b, type: rule.type, level: rule.level ?? b.level, viaVision: true };
      }
    }
  }
  return out;
}

// The model takes a square float32 image and returns [N, 5 + labels] detections.
export async function createVisionEngine(opts = {}) {
  const {
    modelUrl,
    labels = null,
    inputSize = 1024,
    scoreThreshold = 0.5,
    providers = ['webgpu', 'wasm'],
  } = opts;
  if (!modelUrl) throw new Error('IngestLab vision: modelUrl is required');
  if (!labels) throw new Error('IngestLab vision: pass the model class order via { labels }');
  let ort;
  try {
    ort = await import('onnxruntime-web');
  } catch (e) {
    throw new Error('IngestLab vision: install onnxruntime-web to use the vision tier');
  }
  const session = await ort.InferenceSession.create(modelUrl, { executionProviders: providers });

  /**
   * Detect layout regions on a rendered page.
   * @param {HTMLCanvasElement} canvas page raster at any scale
   * @returns {Promise<Array<{cls, box:[x,y,w,h], score}>>} boxes in canvas pixels
   */
  async function detect(canvas) {
    const scale = inputSize / Math.max(canvas.width, canvas.height);
    const w = Math.round(canvas.width * scale);
    const h = Math.round(canvas.height * scale);
    const off = new OffscreenCanvas(inputSize, inputSize);
    const ctx = off.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, inputSize, inputSize);
    ctx.drawImage(canvas, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, inputSize, inputSize).data;
    const tensor = new ort.Tensor('float32', new Float32Array(inputSize * inputSize * 3), [1, 3, inputSize, inputSize]);
    for (let i = 0, px = 0; px < inputSize * inputSize; px++) {
      tensor.data[i++] = data[px * 4] / 255;
      tensor.data[i++] = data[px * 4 + 1] / 255;
      tensor.data[i++] = data[px * 4 + 2] / 255;
    }
    const feeds = {};
    feeds[session.inputNames[0]] = tensor;
    const results = await session.run(feeds);
    const out = results[session.outputNames[0]];
    const regions = [];
    // generic YOLO-style output: rows of [cx, cy, w, h, score, ...classScores]
    // in inputSize pixel space -> convert to canvas pixels
    const k = Math.max(canvas.width, canvas.height) / inputSize;
    const [n, dim] = out.dims.length === 3 ? [out.dims[1], out.dims[2]] : [out.dims[0], out.dims[1]];
    for (let r = 0; r < n; r++) {
      const base = r * dim;
      const score = out.data[base + 4];
      if (score < scoreThreshold) continue;
      let best = 4;
      for (let c = 5; c < dim; c++) if (out.data[base + c] > out.data[base + best]) best = c;
      const cls = labels[Math.min(best - 5, labels.length - 1)];
      const cx = out.data[base] * k;
      const cy = out.data[base + 1] * k;
      const bw = out.data[base + 2] * k;
      const bh = out.data[base + 3] * k;
      regions.push({
        cls,
        score,
        box: [cx - bw / 2, cy - bh / 2, bw, bh],
      });
    }
    return nms(regions, 0.55);
  }

  return { detect, labels, inputSize, session };
}
