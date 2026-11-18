import type { IngestDropzoneElement as Dropzone, PdfAsset } from './index.js';

export { IngestDropzone, IngestDropzone as IngestDropzoneReact, IngestLab, VERSION,
  demuxVideo, destroyVideoEngine, detectCapabilities, sniffKind } from './index.js';
export type { IngestDropzoneProps } from './index.js';
export type IngestDropzoneElement = Dropzone;

export declare const IngestDropzoneElement: {
  new (): IngestDropzoneElement;
  prototype: IngestDropzoneElement;
};
export function renderMarkdown(markdown: string, assets?: PdfAsset[], options?: { allowRawHtml?: boolean }): string;
export function sanitizeHtml(html: string): string;
