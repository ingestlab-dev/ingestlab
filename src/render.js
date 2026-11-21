// PDF rasterization shared by OCR and source visuals.
//   Node:    pdf.js render via @napi-rs/canvas
//   Browser: pdf.js render via OffscreenCanvas

let _canvasMod = null;

function imageObjectFromOperators(page, operators) {
  // Native canvas can segfault while PDF.js paints some large RGB image
  // XObjects. A single image that covers the page can be copied directly.
  const candidates = [];
  for (let i = 0; i < operators.argsArray.length; i++) {
    const args = operators.argsArray[i];
    if (Array.isArray(args) && typeof args[0] === 'string' &&
        Number.isInteger(args[1]) && Number.isInteger(args[2]) &&
        args[1] > 0 && args[2] > 0) {
      candidates.push({ name: args[0], width: args[1], height: args[2] });
    }
  }
  if (candidates.length !== 1 || !page.objs?.get) return null;
  const candidate = candidates[0];
  return new Promise((resolve) => {
    try {
      page.objs.get(candidate.name, (image) => resolve({ ...candidate, image }));
    } catch {
      resolve(null);
    }
  });
}

function copyPdfImage(ctx, image, width, height) {
  const data = image?.data;
  if (!data || data.length === 0) return false;
  const imageData = ctx.createImageData(width, height);
  const rgba = imageData.data;
  if (image.kind === 1) {
    for (let i = 0; i < width * height; i++) {
      const value = (data[i >> 3] & (128 >> (i & 7))) ? 0 : 255;
      const j = i * 4;
      rgba[j] = value;
      rgba[j + 1] = value;
      rgba[j + 2] = value;
      rgba[j + 3] = 255;
    }
  } else if (image.kind === 2 && data.length >= width * height * 3) {
    for (let i = 0, j = 0; i < width * height; i++, j += 4) {
      const k = i * 3;
      rgba[j] = data[k];
      rgba[j + 1] = data[k + 1];
      rgba[j + 2] = data[k + 2];
      rgba[j + 3] = 255;
    }
  } else if (image.kind === 3 && data.length >= width * height * 4) {
    rgba.set(data.subarray(0, width * height * 4));
  } else {
    return false;
  }
  ctx.putImageData(imageData, 0, 0);
  return true;
}

async function renderNodeImagePage(page, canvas, ctx, w, h) {
  if (!page.objs?.get || typeof page.getOperatorList !== 'function') return false;
  let operators;
  try {
    operators = await page.getOperatorList();
  } catch {
    return false;
  }
  const result = await imageObjectFromOperators(page, operators);
  if (!result?.image) return false;
  const viewport = page.getViewport({ scale: 1 });
  const image = result.image;
  // The safe path is intended for full-page scan images. Other image layouts
  // still use PDF.js so their placement and clipping remain exact.
  const coversPage = result.width >= viewport.width * 0.85 &&
    result.height >= viewport.height * 0.85;
  if (!coversPage) return false;
  const source = await makeCanvas(result.width, result.height);
  if (!copyPdfImage(source.ctx, image, result.width, result.height)) return false;
  ctx.drawImage(source.canvas, 0, 0, result.width, result.height, 0, 0, w, h);
  try {
    source.canvas.width = 0;
    source.canvas.height = 0;
  } catch {}
  return true;
}

export async function renderPage(page, scale) {
  const viewport = page.getViewport({ scale });
  const w = Math.max(1, Math.round(viewport.width));
  const h = Math.max(1, Math.round(viewport.height));
  const { canvas, ctx, isNode } = await makeCanvas(w, h);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  if (isNode && await renderNodeImagePage(page, canvas, ctx, w, h)) {
    return { canvas, ctx, w, h, isNode };
  }
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
