import { makeCanvas } from './render.js';

function keepAnimation(bytes, kind) {
  const tag = (i, value) => [...value].every((c, j) => bytes[i + j] === c.charCodeAt(0));
  if (kind === 'image/gif') return true; // Preserve the GIF timeline instead of flattening it.
  if (kind === 'image/webp') return tag(12, 'VP8X') && !!(bytes[20] & 2);
  if (kind !== 'image/png') return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 8; i + 12 <= bytes.length;) {
    if (tag(i + 4, 'IDAT')) return false;
    if (tag(i + 4, 'acTL')) return true;
    i += view.getUint32(i) + 12;
  }
  return false;
}

export async function optimizeImage(bytes, kind, opts) {
  const source = new Blob([bytes], { type: kind });
  const browser = typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function';
  let bitmap;
  try {
    bitmap = browser ? await createImageBitmap(source) : await (await import('@napi-rs/canvas')).loadImage(new Uint8Array(bytes));
  } catch (cause) {
    throw new Error('ingestlab image: could not decode the image (Node requires @napi-rs/canvas)', { cause });
  }
  const width = bitmap.width, height = bitmap.height;
  try {
    if (!width || !height) throw new Error('ingestlab image: unreadable image dimensions');
    const original = { blob: source, width, height, animatedPreserved: keepAnimation(bytes, kind), optimized: false };
    if (original.animatedPreserved) return original;
    const maxEdge = Number.isFinite(opts.imageMaxEdge) ? Math.max(1, Math.min(8192, Math.floor(opts.imageMaxEdge))) : 1600;
    const quality = Number.isFinite(opts.imageQuality) ? Math.max(0, Math.min(1, opts.imageQuality)) : 0.86;
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    const { canvas, ctx, isNode } = await makeCanvas(w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    try {
      const blob = isNode ? new Blob([await canvas.encode('webp', Math.round(quality * 100))], { type: 'image/webp' }) :
        await canvas.convertToBlob({ type: 'image/webp', quality });
      return blob.size && blob.size < source.size && blob.type === 'image/webp' ?
        { blob, width: w, height: h, animatedPreserved: false, optimized: true } : original;
    } finally {
      if (!isNode) canvas.width = canvas.height = 0;
    }
  } finally {
    bitmap.close?.();
  }
}
