// PDF rasterization shared by OCR and source visuals.
//   Node:    pdf.js render via @napi-rs/canvas
//   Browser: pdf.js render via OffscreenCanvas

let _canvasMod = null;

export async function renderPage(page, scale) {
  const viewport = page.getViewport({ scale });
  const w = Math.max(1, Math.round(viewport.width));
  const h = Math.max(1, Math.round(viewport.height));
  const { canvas, ctx, isNode } = await makeCanvas(w, h);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { canvas, ctx, w, h, isNode };
}

export async function makeCanvas(w, h) {
  if (typeof process !== 'undefined' && process.versions?.node) {
    _canvasMod ||= import('@napi-rs/canvas');
    const { createCanvas } = await _canvasMod;
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    return { canvas, ctx, isNode: true };
  }
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return { canvas, ctx, isNode: false };
}
