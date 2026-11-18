import { makeCanvas, renderPage } from './render.js';

async function encodeImage(canvas, isNode, format) {
  return isNode
    ? new Uint8Array(await canvas.encode(format, format === 'webp' ? 88 : undefined))
    : new Uint8Array(await (await canvas.convertToBlob({ type: `image/${format}`, quality: 0.88 })).arrayBuffer());
}

function cropBounds(bbox, scale, w, h, pad) {
  const x = Math.max(0, Math.floor((bbox.x0 - pad) * scale));
  const y = Math.max(0, Math.floor((bbox.y0 - pad) * scale));
  const width = Math.min(w, Math.ceil((bbox.x1 + pad) * scale)) - x;
  const height = Math.min(h, Math.ceil((bbox.y1 + pad) * scale)) - y;
  return { x, y, width, height };
}

export async function preserveVisuals(doc, pages, { preservePages, scanPages, skipRasterFigures, onProgress }) {
  const assets = [];
  let failed = 0;
  for (let i = 0; i < pages.length; i++) {
    const blocks = pages[i];
    const regions = skipRasterFigures ? [] : blocks.filter((b) =>
      (b.type === 'figure' || b.type === 'image') && b.bbox && !b.vectorPath);
    if (!regions.length && !preservePages) continue;
    const page = await doc.getPage(i + 1);
    onProgress({ stage: 'visuals', page: i + 1, pages: pages.length });
    try {
      const viewport = page.getViewport({ scale: 1 });
      const pageArea = viewport.width * viewport.height;
      const scale = Math.min(2, 2200 / Math.max(viewport.width, viewport.height));
      const { canvas, w, h, isNode } = await renderPage(page, scale);
      const store = async (target, name, format) => {
        const bytes = await encodeImage(target, isNode, format);
        const path = `images/p${i + 1}${name}.${format}`;
        assets.push({ path, bytes, page: i + 1 });
        return path;
      };
      let fullPath;
      const full = async () => (fullPath ||= await store(canvas, '', 'webp'));
      const scanned = preservePages && scanPages[i];
      for (const [j, block] of regions.entries()) {
        // A scan may be tiled into dozens of XObjects. The page render
        // already preserves them in their correct arrangement.
        const box = block.bbox;
        if (preservePages && block.type === 'image' && (scanned ||
            (box.x1 - box.x0) * (box.y1 - box.y0) < pageArea * 0.008)) {
          block.coveredByPage = true;
          continue;
        }
        const { x, y, width, height } = cropBounds(block.bbox, scale, w, h, block.type === 'figure' ? 10 : 0);
        if (width <= 0 || height <= 0) continue;
        if (width * height >= 0.88 * w * h) {
          block.assetPath = await full();
        } else {
          const crop = await makeCanvas(width, height);
          crop.ctx.drawImage(canvas, x, y, width, height, 0, 0, width, height);
          block.assetPath = await store(crop.canvas, `-v${j + 1}`, 'png');
        }
      }
      if (preservePages) {
        const assetPath = await full();
        if (!blocks.some((b) => b.assetPath === assetPath)) {
          blocks.push({ type: 'source_page', page: i + 1, assetPath });
        }
      }
    } catch (error) {
      failed++;
      if (failed === 1) console.warn('ingestlab: could not render source visuals:', error.message);
    } finally {
      page.cleanup?.();
    }
  }
  return { assets, failed };
}
