let backend;

export function vectorBackend() {
  if (typeof process === 'undefined' || !process.versions?.node) {
    throw new Error('ingestlab: vectorFigures requires Node and @napi-rs/canvas');
  }
  return backend ||= import('@napi-rs/canvas').catch((error) => {
    throw new Error('ingestlab: install @napi-rs/canvas to use vectorFigures', { cause: error });
  });
}

// Skia writes self-contained SVG. Reject raster paint or active/external SVG
// features rather than publishing a bitmap disguised as a vector drawing.
export function isPureVector(svg) {
  return /<svg\b/i.test(svg) && /<(?:path|polyline|polygon|circle|ellipse|line)\b/i.test(svg) &&
    !/<(?:image|feImage|script|foreignObject|iframe|style|animate\w*|set)\b|<!DOCTYPE|<!ENTITY|\son[a-z]+\s*=/i.test(svg) &&
    [...svg.matchAll(/\b(?:href|xlink:href)\s*=\s*["']([^"']+)["']/gi)].every(([, value]) => /^#[\w.-]+$/.test(value)) &&
    [...svg.matchAll(/url\(\s*([^)]*)\)/gi)].every(([, value]) => /^#[\w.-]+$/.test(value.trim()));
}

export function vectorBounds(page, b) {
  const vp = page.getViewport({ scale: 1 });
  const x = Math.max(0, Math.floor(b.x0 - 2));
  const y = Math.max(0, Math.floor(b.y0 - 2));
  const w = Math.min(Math.ceil(vp.width), Math.ceil(b.x1 + 2)) - x;
  const h = Math.min(Math.ceil(vp.height), Math.ceil(b.y1 + 2)) - y;
  return { x, y, w, h };
}

export async function drawVectorFigure(page, area, canvasModule, captureGroup = false) {
  const { x, y, w, h } = area;
  if (w <= 0 || h <= 0 || w * h > 4_000_000) return null;
  const { createCanvas, SvgExportFlag } = canvasModule;
  const canvas = createCanvas(w, h, SvgExportFlag.ConvertTextToPaths);
  const ctx = canvas.getContext('2d');
  await page.render({
    canvasContext: ctx,
    viewport: page.getViewport({ scale: 1 }),
    transform: [1, 0, 0, 1, -x, -y],
  }).promise;
  const bytes = canvas.getContent();
  return bytes.byteLength <= 4_000_000 && (captureGroup || isPureVector(bytes.toString('utf8'))) ? new Uint8Array(bytes) : null;
}

export async function rebuildVectorFigures(doc, pages, onProgress) {
  const canvas = await vectorBackend();
  const assets = [];
  let failed = 0, unrepresented = 0;
  for (const [i, blocks] of pages.entries()) {
    const figures = blocks.filter((b) => b.type === 'figure' && b.bbox && b.kind !== 'image' && b.kind !== 'raster');
    if (!figures.length) continue;
    const page = await doc.getPage(i + 1);
    onProgress({ stage: 'visuals', page: i + 1, pages: pages.length });
    try {
      for (const [j, block] of figures.entries()) {
        const area = vectorBounds(page, block.bbox);
        let bytes;
        try {
          bytes = await drawVectorFigure(page, area, canvas);
        } catch (error) {
          // Unsupported canvas operation: leave native representations intact.
          if (!failed) console.warn('ingestlab: could not draw a vector figure:', error?.message || error);
        }
        if (!bytes) {
          failed++;
          if (!block.tableMd && !block.mermaid && !block.visualContent?.links?.length) unrepresented++;
          continue;
        }
        const path = `images/p${i + 1}-vector${j + 1}.svg`;
        block.vectorPath = path;
        assets.push({ path, bytes, page: i + 1, kind: 'vector-reconstruction', area,
          ...(block.sourceCaption ? { caption: block.sourceCaption } : {}) });
      }
    } finally {
      page.cleanup?.();
    }
  }
  return { assets, failed, unrepresented };
}
