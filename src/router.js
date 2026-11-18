
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 22, 1, 20, 0, 253, 12, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11,
]);

export async function detectCapabilities() {
  const caps = {
    webgpu: false,
    gpuAdapter: '',
    wasmSimd: false,
    opfs: false,
    workers: typeof Worker !== 'undefined',
    webcodecs:
      typeof VideoDecoder !== 'undefined' &&
      typeof VideoFrame !== 'undefined' &&
      typeof EncodedVideoChunk !== 'undefined',
    webcodecsEncoder: typeof VideoEncoder !== 'undefined',
  };

  try {
    caps.wasmSimd = WebAssembly.validate(SIMD_PROBE);
  } catch {
    caps.wasmSimd = false;
  }

  try {
    if (globalThis.navigator?.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        caps.webgpu = true;
        const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
        caps.gpuAdapter = info ? `${info.vendor || ''} ${info.architecture || ''}`.trim() : '';
      }
    }
  } catch {
    caps.webgpu = false;
  }

  try {
    if (globalThis.navigator?.storage?.getDirectory) {
      const root = await navigator.storage.getDirectory();
      caps.opfs = !!root;
    }
  } catch {
    caps.opfs = false;
  }

  const rvfc =
    typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  const route = {
    engine: caps.webgpu ? 'webgpu' : caps.wasmSimd ? 'wasm-simd' : 'wasm',
    vision: caps.webgpu ? 'onnx-webgpu' : caps.wasmSimd ? 'onnx-wasm' : 'off',
    cache: caps.opfs ? 'opfs' : 'memory',
    video:
      caps.webgpu && caps.webcodecs
        ? 'webgpu-webcodecs'
        : caps.webcodecs
          ? 'webcodecs-2d'
          : rvfc
            ? caps.webgpu
              ? 'rvfc-webgpu'
              : 'rvfc-2d'
            : 'seek-2d',
  };
  return { caps, route };
}
