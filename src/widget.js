
import MarkdownIt from 'markdown-it';
import { IngestLab } from './index.js';
import { sniffKind } from './kind.js';
import { applyImageMode } from './markdown.js';

const DEFAULT_PDFJS_SRC =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.min.mjs';
const DEFAULT_STDFONTS =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/standard_fonts/';

let sharedLab = null;
async function getLab() {
  if (!sharedLab) sharedLab = await IngestLab.init();
  return sharedLab;
}

async function ensurePdfjs(el) {
  if (globalThis.pdfjsLib) return;
  const src = el.getAttribute('pdfjs-src') || DEFAULT_PDFJS_SRC;
  const m = await import(src);
  globalThis.pdfjsLib = m;
  if (m.GlobalWorkerOptions) {
    m.GlobalWorkerOptions.workerSrc = src.replace('pdf.min.mjs', 'pdf.worker.min.mjs');
  }
}

function fmtUsd(v) {
  if (!v) return '0';
  if (v < 0.01) return v.toFixed(4);
  return v.toFixed(2);
}

function backendLabel(backend) {
  if (/webgpu/.test(backend || '')) return 'WebGPU';
  if (/wasm|seek|canvas|2d/.test(backend || '')) return 'WASM-SIMD';
  return backend || 'WebGPU';
}

// Allow importing the widget without a DOM.
const HTMLElementBase = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

class IngestDropzone extends HTMLElementBase {
  static get observedAttributes() {
    return ['label', 'accept', 'demo'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._result = null;
    this._view = 'rendered';
    this._busy = false;
    this._mdShown = '';
    this._urls = [];
    this._render();
  }

  attributeChangedCallback() {
    this._render();
  }

  connectedCallback() {
  }

  _wire() {
    const zone = this.shadowRoot.querySelector('.zone');
    const input = this.shadowRoot.querySelector('input');
    const button = this.shadowRoot.querySelector('button');
    zone.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      input.click();
    });
    button.addEventListener('click', () => {
      if (this.hasAttribute('demo')) {
        this.dispatchEvent(new CustomEvent('ingest-sample', { bubbles: true, composed: true }));
      } else {
        input.click();
      }
    });
    input.addEventListener('change', () => {
      if (input.files[0]) this.ingestFile(input.files[0]);
      input.value = '';
    });
    ['dragover', 'dragenter'].forEach((t) =>
      zone.addEventListener(t, (e) => {
        e.preventDefault();
        zone.classList.add('over');
      })
    );
    ['dragleave', 'drop'].forEach((t) =>
      zone.addEventListener(t, (e) => {
        e.preventDefault();
        zone.classList.remove('over');
      })
    );
    zone.addEventListener('drop', (e) => {
      const f = e.dataTransfer?.files?.[0];
      if (f) this.ingestFile(f);
    });
  }

  /** Public API: process a File/Blob programmatically (also used by React). */
  async ingestFile(fileOrBlob) {
    if (this._busy) return;
    this._busy = true;
    this._result = null;
    const name = fileOrBlob.name || 'file';
    const hud = this.shadowRoot.querySelector('.hud');
    const preview = this.shadowRoot.querySelector('.preview');
    const errBox = this.shadowRoot.querySelector('.err');
    errBox.style.display = 'none';
    this._view = 'rendered';
    hud.textContent = `Processing ${name} locally…`;
    preview.innerHTML = '';
    try {
      const isPdf = sniffKind(new Uint8Array(await fileOrBlob.slice(0, 16).arrayBuffer())) === 'pdf';
      if (isPdf) {
        await ensurePdfjs(this);
      }
      const lab = await getLab();
      const ingestOpts = {
        semanticHtml: true,
        dropHeadersFooters: false,
        markdownProfile: this.getAttribute('markdown-profile') === 'rag' ? 'rag' : undefined,
        sceneThreshold: parseFloat(this.getAttribute('scene-threshold')) || undefined,
        maxKeyframes: parseInt(this.getAttribute('max-keyframes'), 10) || undefined,
        onProgress: (ev) => {
          const msg = progressMsg(ev, name);
          if (msg) hud.textContent = msg;
          this.dispatchEvent(new CustomEvent('ingest-progress', { detail: ev }));
        },
      };
      const ocrModule = this.getAttribute('ocr-src');
      const ocrLangPath = this.getAttribute('ocr-lang-src');
      if (ocrModule || ocrLangPath) ingestOpts.ocrRuntime = {
        ...(ocrModule ? { module: ocrModule } : {}),
        workerPath: this.getAttribute('ocr-worker-src') || undefined,
        corePath: this.getAttribute('ocr-core-src') || undefined,
        langPath: ocrLangPath || undefined,
        ...(ocrLangPath ? { gzip: this.hasAttribute('ocr-lang-gzip') } : {}),
      };
      const fonts = this.getAttribute('pdfjs-stdfonts');
      if (fonts) ingestOpts.docOpts = { standardFontDataUrl: fonts };
      if (this.hasAttribute('ocr-images')) ingestOpts.ocrImages = true;
      const ocrLimit = parseInt(this.getAttribute('ocr-page-limit'), 10);
      if (Number.isFinite(ocrLimit)) ingestOpts.ocrPageLimit = ocrLimit;
      const ocrLangs = this.getAttribute('ocr-langs');
      if (ocrLangs) ingestOpts.ocrLangs = ocrLangs;
      const result = await lab.ingest(fileOrBlob, ingestOpts);
      this._result = result;
      const m = result.metrics;
      const pct = m.originalBytes ? Math.round((m.outputBytes / m.originalBytes - 1) * 100) : 0;
      const change = pct < 0 ? `Payload reduced <b>${-pct}%</b>` :
        pct > 0 ? `Payload increased <b>${pct}%</b>` : 'Payload size unchanged';
      hud.innerHTML =
        `<b>${m.originalBytes.toLocaleString()} bytes read</b> • Processed locally via ` +
        `<span class="acc">${backendLabel(m.backend)}</span> in <b>${m.latencyMs}ms</b> • ` +
        change + (m.estimatedSavedUsd > 0 ? ` (~$${fmtUsd(m.estimatedSavedUsd)} API saved)` : '') +
        (m.cacheHit ? ' • <span class="ok">Cached</span>' : '');
      this._renderPreview(result);
      this.dispatchEvent(new CustomEvent('ingest-result', { detail: result, bubbles: true, composed: true }));
    } catch (e) {
      errBox.textContent = String(e?.message || e);
      errBox.style.display = 'block';
      hud.textContent = 'Waiting for a file';
      this.dispatchEvent(new CustomEvent('ingest-error', { detail: e, bubbles: true, composed: true }));
    } finally {
      this._busy = false;
    }
  }

  _renderPreview(result) {
    const preview = this.shadowRoot.querySelector('.preview');
    for (const u of this._urls) URL.revokeObjectURL(u);
    this._urls = [];
    if (result.kind === 'video' || result.kind === 'image') {
      const items = (result.keyframes || [])
        .filter((k) => k.blob)
        .map((k, i) => {
          const url = URL.createObjectURL(k.blob);
          this._urls.push(url);
          const label = result.kind === 'video' ? `${k.timestamp.toFixed(2)}s · Scene ${(k.sceneId ?? 0) + 1}` :
            `${result.width} × ${result.height} · ${result.optimized ? 'WebP' : 'Original'}`;
          const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' })[k.blob.type] || 'img';
          return (
            `<figure><a href="${url}" download="${result.kind === 'video' ? 'frame-' + (i + 1) : 'image'}.${ext}" title="Download image">` +
            `<img src="${url}" alt="${label}" loading="lazy"></a><figcaption>${label}</figcaption></figure>`
          );
        })
        .join('');
      const meta =
        result.kind === 'video'
          ? `<div class="meta">${result.keyframes.length} frames · ${result.scenesRepresented}/${result.scenes.length} scenes · ` +
            `${(result.durationUs / 1e6).toFixed(2)}s · Max gap ${(result.maxFrameGapUs / 1e6).toFixed(2)}s</div>`
          : '';
      preview.innerHTML = meta + (result.kind === 'video' ?
        '<div class="tabs"><button type="button" class="tab storyboard-download">Download storyboard</button></div>' : '') +
        `<div class="grid">${items}</div>`;
      const download = preview.querySelector('.storyboard-download');
      download?.addEventListener('click', async () => {
        download.disabled = true;
        try {
          const { width, height, durationUs, scenes, keyframes, maxFrameGapUs } = result;
          const frames = [];
          for (const { blob, ...frame } of keyframes) {
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(blob);
            });
            frames.push({ ...frame, dataUrl });
          }
          const url = URL.createObjectURL(new Blob([JSON.stringify({ width, height, durationUs, maxFrameGapUs, scenes, frames })],
            { type: 'application/json' }));
          const a = document.createElement('a');
          a.href = url;
          a.download = 'storyboard.json';
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 30000);
        } catch (e) {
          this.dispatchEvent(new CustomEvent('ingest-error', { detail: e, bubbles: true, composed: true }));
        } finally {
          download.disabled = false;
        }
      });
    } else if (result.kind === 'pdf') {
      const st = result.stats;
      const warns = [];
      if (st.visualFailed) warns.push(`${st.visualFailed} page(s) could not render source visuals`);
      if (st.ocrFailed) warns.push(`OCR engine unavailable — ${st.ocrFailed} scan page(s) not recognized`);
      else if (st.scannedUnread) warns.push(`${st.scannedUnread} scan page(s) have no text layer`);
      if (st.imageOcrFailed) warns.push(`Image OCR did not finish on ${st.imageOcrFailed} page(s)`);
      const warnHtml = warns.length ? `<div class="warn">⚠ ${warns.join(' • ')}</div>` : '';
      const empty = !result.markdown.trim()
        ? '<div class="warn">⚠ Nothing to show — this PDF appears to be scanned images and OCR did not produce text.</div>'
        : '';
      preview.innerHTML =
        `<div class="tabs"><button class="tab" data-view="rendered">Rendered</button>` +
        `<button class="tab" data-view="raw">Raw markdown</button>` +
        (this.hasAttribute('split-preview') ? '<button class="tab" data-view="split">Side by side</button>' : '') +
        (result.formHtml ? '<button class="tab" data-view="fields">PDF fields</button>' : '') +
        `<button class="tab copy" title="copy the markdown">Copy .md</button></div>` +
        `<div class="meta">${st.pages} pages • ${st.headings} headings • ${st.tables} tables • ` +
        `${st.words} words${st.figures ? ` • ${st.figures} figures` : ''}` +
        `${st.forms ? ` • ${st.forms} form blocks` : ''}` +
        `${st.ocrPages ? ` • OCR'd ${st.ocrPages} scan page(s)` : ''}</div>` +
        warnHtml +
        empty +
        `<div class="mdview"></div>`;
      this._mdShown = result.markdown;
      if (this.hasAttribute('split-preview')) this._view = 'split';
      this._paintMd(result.markdown);
      preview.querySelectorAll('button[data-view]').forEach((button) => {
        button.addEventListener('click', () => {
          this._view = button.dataset.view;
          this._paintMd(this._mdShown);
        });
      });
      preview.querySelector('.copy')?.addEventListener('click', async () => {
        const btn = preview.querySelector('.copy');
        const markdown = applyImageMode(this._mdShown, result.assets, 'base64');
        try {
          await navigator.clipboard.writeText(markdown);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = markdown;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        btn.textContent = 'Copied!';
        setTimeout(() => (btn.textContent = 'Copy .md'), 1200);
      });
    }
  }

  _ensureKatex() {
    if (this._katexPromise) return this._katexPromise;
    this._katexPromise = new Promise((resolve) => {
      const V = '0.16.11';
      const styles = Object.assign(document.createElement('link'), { rel: 'stylesheet',
        href: `https://cdn.jsdelivr.net/npm/katex@${V}/dist/katex.min.css` });
      this.shadowRoot.appendChild(styles);
      const js = Object.assign(document.createElement('script'), { src: `https://cdn.jsdelivr.net/npm/katex@${V}/dist/katex.min.js`, defer: true });
      const ar = Object.assign(document.createElement('script'), { src: `https://cdn.jsdelivr.net/npm/katex@${V}/dist/contrib/auto-render.min.js`, defer: true });
      ar.onload = () => resolve(true);
      ar.onerror = () => resolve(false);
      js.onload = () => document.head.appendChild(ar);
      js.onerror = () => resolve(false);
      if (window.renderMathInElement) resolve(true);
      else if (window.katex) document.head.appendChild(ar);
      else document.head.appendChild(js);
      setTimeout(() => resolve(!!window.renderMathInElement), 6000);
    });
    return this._katexPromise;
  }

  async _typesetMath(el) {
    if (!el) return;
    const ok = await this._ensureKatex();
    if (ok && window.renderMathInElement) {
      try {
        for (const math of el.querySelectorAll('.math, .math-inline')) window.renderMathInElement(math, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
          ],
          throwOnError: false,
        });
      } catch {}
    }
  }

  _ensureMermaid() {
    if (this._mermaidPromise) return this._mermaidPromise;
    this._mermaidPromise = import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')
      .then((m) => {
        const mermaid = m.default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
        return mermaid;
      })
      .catch(() => null); // Show the Mermaid source when the CDN is unavailable.
    return this._mermaidPromise;
  }

  async _renderMermaid(container) {
    const divs = [...(container?.querySelectorAll?.('div.mermaid[data-code]') || [])];
    if (!divs.length) return;
    const mermaid = await this._ensureMermaid();
    const fallback = (d) => {
      const pre = document.createElement('pre');
      pre.className = 'code';
      pre.textContent = d.getAttribute('data-code') || '';
      d.replaceWith(pre);
    };
    if (!mermaid) {
      divs.forEach(fallback);
      return;
    }
    for (const d of divs) {
      try {
        const { svg } = await mermaid.render('ilmmd-' + Math.random().toString(36).slice(2, 9), d.getAttribute('data-code') || '');
        d.innerHTML = svg;
        d.removeAttribute('data-code');
      } catch {
        fallback(d);
      }
    }
  }

  _paintMd(markdown) {
    const view = this.shadowRoot.querySelector('.mdview');
    if (!view) return;
    view.classList.toggle('split', this._view === 'split');
    if (this._view === 'raw') {
      view.innerHTML = `<pre>${escapeHtml(markdown)}</pre>`;
    } else if (this._view === 'fields') {
      view.innerHTML = `<div class="rendered pdf-fields">${this._result?.formHtml || ''}</div>`;
    } else {
      const result = this._result;
      const rendered = renderMarkdown(markdown, result?.assets, { allowRawHtml: false });
      view.innerHTML = this._view === 'split'
        ? `<section aria-label="Raw GFM Markdown"><h2>Raw GFM Markdown</h2><pre tabindex="0">${escapeHtml(markdown)}</pre></section>
           <section aria-label="Live preview"><h2>Live preview</h2><div class="rendered" tabindex="0">${rendered}</div></section>`
        : `<div class="rendered">${rendered}</div>`;
      for (const block of view.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, th, td')) {
        if (/[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}]/u.test(block.textContent)) block.dir = 'auto';
      }
      if (/\$/.test(markdown)) this._typesetMath(view);
      this._renderMermaid(view.querySelector('.rendered'));
    }
    this.shadowRoot.querySelectorAll('.tab[data-view]').forEach((button) =>
      button.classList.toggle('on', button.dataset.view === this._view)
    );
  }

  _render() {
    const label = this.getAttribute('label') || 'Drop a PDF or Video — parsed entirely on this device';
    const accept = this.getAttribute('accept') || 'application/pdf,.pdf,video/mp4,.mp4,video/webm,.webm,image/*';
    const showDemo = this.hasAttribute('demo');
    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                color: var(--ingest-fg, #e8eaf2); }
        .zone { border: 1.5px dashed var(--ingest-line, #2a3346); border-radius: 14px;
                padding: 28px 16px; text-align: center; cursor: pointer;
                transition: border-color .15s, background .15s; }
        .zone:hover, .zone.over { border-color: var(--ingest-acc, #7c8cff); background: #131a2a; }
        .zone p { margin: 0 0 10px; color: var(--ingest-dim, #8b93a7); }
        button { background: var(--ingest-acc, #7c8cff); border: 0; color: #0b0e14; font: inherit;
                 font-weight: 700; padding: 8px 16px; border-radius: 8px; cursor: pointer; }
        .hud { margin-top: 12px; font-size: 12px; color: var(--ingest-hud-text, #bfc9dd);
               background: var(--ingest-hud-bg, #151c29); overflow-wrap: anywhere;
               border: 1px solid var(--ingest-hud-border, #36445b); border-radius: 8px; padding: 10px 14px; }
        .hud b { color: var(--ingest-hud-strong, #f6f8ff); }
        .hud :is(.acc, .ok) { color: var(--ingest-hud-accent, #95e9bb); font-weight: 700; }
        .err { display: none; margin-top: 10px; border: 1px solid #ff6b6b; color: #ff6b6b;
               border-radius: 10px; padding: 10px 14px; white-space: pre-wrap; }
        .meta { color: var(--ingest-dim, #8b93a7); font-size: 12px; margin: 12px 0 8px; }
        .grid { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; }
        figure { margin: 0; }
        img { max-width: 220px; max-height: 130px; border-radius: 8px; border: 1px solid var(--ingest-line, #2a3346); display: block; }
        figcaption { color: var(--ingest-dim, #8b93a7); font-size: 11px; margin-top: 4px; }
        pre { background: var(--ingest-card, #121722); border: 1px solid var(--ingest-line, #2a3346);
              border-radius: 10px; padding: 14px; max-height: 340px; overflow: auto;
              white-space: pre-wrap; word-break: break-word; margin: 0; font-size: 12px; }
        .tabs { display: flex; gap: 6px; margin-top: 12px; flex-wrap: wrap; align-items: center; }
        .mdview.split { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
        .split section { min-width: 0; }
        .split section > h2 { font: inherit; font-weight: 700; margin: 0 0 6px; }
        .split :is(section > pre, .rendered) { box-sizing: border-box; height: 66vh; max-height: none; overflow: auto; }
        @media (max-width: 760px) {
          .mdview.split { grid-template-columns: minmax(0, 1fr); }
          .split :is(section > pre, .rendered) { height: 45vh; }
        }
        .seglabel { font-size: 11px; color: var(--ingest-dim, #8b93a7); margin-left: 8px; }
        .tab { background: transparent; border: 1px solid var(--ingest-line, #2a3346); color: var(--ingest-dim, #8b93a7);
               font: inherit; font-size: 11px; padding: 4px 12px; border-radius: 999px; cursor: pointer; }
        .tab.on { background: var(--ingest-acc, #7c8cff); color: #0b0e14; border-color: transparent; font-weight: 700; }
        .warn { margin-top: 10px; border: 1px solid #e6b455; color: #e6b455; border-radius: 10px;
                padding: 8px 14px; font-size: 12px; }
        .rendered { background: var(--ingest-card, #121722); border: 1px solid var(--ingest-line, #2a3346);
              border-radius: 10px; padding: 18px 20px; max-height: 520px; overflow: auto; margin: 0;
              font: 14px/1.6 ui-sans-serif, system-ui, sans-serif; color: var(--ingest-fg, #e8eaf2); }
        .rendered h1, .rendered h2, .rendered h3, .rendered h4 { line-height: 1.3; margin: 18px 0 8px; }
        .rendered h1 { font-size: 20px; } .rendered h2 { font-size: 17px; } .rendered h3 { font-size: 15px; }
        .rendered h4, .rendered h5, .rendered h6 { font-size: 13.5px; }
        .rendered p { margin: 8px 0; }
        .rendered table { border-collapse: collapse; margin: 10px 0; font-size: 12.5px; display: block; overflow-x: auto; max-width: 100%; }
        .rendered th, .rendered td { border: 1px solid var(--ingest-line, #2a3346); padding: 4px 10px; text-align: left; }
        .rendered th { background: #1a2130; }
        .rendered pre { background: #0d1118; padding: 10px 14px; border-radius: 8px; overflow-x: auto; font-size: 12px; }
        .rendered code { background: #0d1118; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
        .rendered blockquote { border-left: 3px solid var(--ingest-acc, #7c8cff); margin: 8px 0; padding: 2px 14px; color: var(--ingest-dim, #8b93a7); }
        .rendered :is(ul, ol) { margin: 8px 0; padding-left: 22px; }
        .rendered .math { font-family: ui-monospace, Menlo, Consolas, monospace; background: #0d1118;
               border-radius: 8px; padding: 10px 16px; margin: 10px 0; white-space: pre-wrap; font-size: 13px; color: #c9d4ff; overflow-x: auto; }
        .rendered .mermaid { background: #fff; border-radius: 8px; padding: 10px; margin: 10px 0; overflow-x: auto; text-align: center; }
        .rendered svg { max-width: 100%; height: auto; }
        /* semantic tables: merged cells, group headers, total rows, diagonal corners */
        .rendered table.il-table { border-collapse: collapse; margin: 10px 0; font-size: 12.5px; display: block; overflow-x: auto; }
        .rendered table.il-table th, .rendered table.il-table td { border: 1px solid var(--ingest-line, #2a3346); padding: 4px 10px; text-align: left; }
        .rendered table.il-table th { background: #1a2130; }
        .rendered tr.il-group-row td { background: #1a2130; font-weight: 700; text-align: center; letter-spacing: .04em; }
        .rendered tr.il-total-row td { border-bottom: 3px double var(--ingest-fg, #e8eaf2); font-weight: 600; }
        .rendered .il-diag-cell { position: relative; }
        .rendered .il-diag-cell .il-diag-a { float: right; color: #8b93a7; }
        .rendered .il-diag-cell .il-diag-b { float: left; clear: both; }
        .rendered .il-rot { font-variant: small-caps; letter-spacing: .05em; }
        .rendered .il-glyph { color: var(--ingest-acc, #7c8cff); font-size: 1.15em; }
        /* styled form / worksheet components */
        .rendered .il-form { border: 1px solid var(--ingest-line, #2a3346); border-radius: 10px; padding: 12px 16px; margin: 10px 0; background: #0f1420; }
        .rendered .il-form-title, .rendered .il-worksheet-title { font-weight: 700; font-size: 13px; margin: 2px 0 10px; color: var(--ingest-fg, #e8eaf2); }
        .rendered .il-field-row { display: flex; flex-wrap: wrap; gap: 8px 18px; margin: 8px 0; }
        .pdf-fields fieldset { min-inline-size: 0; margin: 0 0 12px; }
        .pdf-fields .il-field { display: flex; gap: 3px; padding: 4px 0; overflow-wrap: anywhere; }
        .pdf-fields :is(input, select, textarea) { max-width: 100%; }
        .rendered .il-field { display: inline-flex; flex-direction: column; min-width: 120px; }
        .rendered .il-field-box { display: inline-block; min-width: 90px; border: 1px solid #3a465f; border-radius: 4px; padding: 4px 8px; background: #141b2b; }
        .rendered .il-field-value { display: inline-block; min-width: 90px; border-bottom: 1px solid #3a465f; padding: 4px 8px; font-family: ui-monospace, Menlo, Consolas, monospace; }
        .rendered .il-field-label { font-size: 10px; color: var(--ingest-dim, #8b93a7); margin-top: 3px; }
        .rendered .il-comb .il-field-box { letter-spacing: 3px; font-family: ui-monospace, Menlo, Consolas, monospace; }
        .rendered .il-form-matrix td, .rendered .il-kv td { border: 1px solid var(--ingest-line, #2a3346); padding: 4px 10px; }
        .rendered .il-section-rail { border-left: 3px solid var(--ingest-acc, #7c8cff); border-radius: 4px 10px 10px 4px; padding: 8px 14px; margin: 10px 0; }
        .rendered .il-section-title { font-weight: 700; margin-right: 10px; }
        .rendered .il-section-note { color: var(--ingest-dim, #8b93a7); font-size: 11.5px; }
        .rendered .il-worksheet-row { display: flex; align-items: baseline; gap: 8px; font-size: 13px; padding: 1.5px 0; }
        .rendered .il-worksheet-row .il-code { min-width: 26px; color: var(--ingest-dim, #8b93a7); font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; }
        .rendered .il-worksheet-row .il-label { min-width: 200px; }
        .rendered .il-worksheet-row .il-dot-leader { flex: 1; border-bottom: 1.5px dotted #3a465f; min-width: 30px; transform: translateY(-3px); }
        .rendered .il-worksheet-row .il-dot-leader.il-no-dots { border-bottom: none; }
        .rendered .il-worksheet-row .il-amount { font-family: ui-monospace, Menlo, Consolas, monospace; min-width: 70px; text-align: right; }
        .rendered .il-worksheet-row .il-amount.il-empty { min-width: 40px; }
        .rendered .il-worksheet-row.il-indent .il-label { padding-left: 18px; }
        .rendered .il-worksheet-row.il-underline .il-amount { border-bottom: 1px solid var(--ingest-fg, #e8eaf2); }
        .rendered .il-worksheet-row.il-double-underline .il-amount { border-bottom: 3px double var(--ingest-fg, #e8eaf2); font-weight: 700; }
        .rendered .il-kv .il-kv-key { color: var(--ingest-dim, #8b93a7); }

      </style>
      <div class="zone">
        <p>${escapeHtml(label)}</p>
        <button type="button">${showDemo ? 'run a bundled sample' : 'choose file'}</button>
        <input type="file" hidden accept="${accept}">
      </div>
      <div class="hud" role="status">Waiting for a file</div>
      <div class="err"></div>
      <div class="preview"></div>
    `;
    this._wire();
  }

  get result() {
    return this._result;
  }
}

function progressMsg(ev, name) {
  if (ev.stage === 'video-analysis') return `Analyzing video: ${Math.round(ev.mediaDone / ev.mediaTotal * 100)}%`;
  if (ev.stage === 'video-export') return `Exporting frames: ${ev.mediaDone}/${ev.mediaTotal}`;
  if (ev.stage === 'extract') return `Extracting page ${ev.page}/${ev.pages} of ${name}…`;
  if (ev.stage === 'visuals') return `Rendering page ${ev.page}/${ev.pages} of ${name}…`;
  if (ev.stage === 'image-ocr') return `Reading embedded images on page ${ev.page}/${ev.pages} of ${name}…`;
  if (ev.stage === 'ocr') {
    const queue = ev.ocrTotal ? ` • ${ev.ocrDone}/${ev.ocrTotal} scans done` : '';
    const hint = ev.ocrTotal > 30 ? ' • large scans run much faster through the Node CLI (ocrWorkers)' : '';
    return `OCR scan page ${ev.page}/${ev.pages} of ${name}${queue}${hint} (first run downloads the language model once)`;
  }
  return null;
}

/**
 * Strip active content from HTML emitted by IngestLab. This is not a
 * sanitizer for arbitrary HTML.
 */
export function sanitizeHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<iframe[\s\S]*?(<\/iframe\s*>|>)/gi, '')
    .replace(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (m, close, tag, attrs) => {
      const clean = attrs
        .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/(\s(?:href|src|xlink:href))\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (m2, name, val) => {
          const v = val.replace(/^["']|["']$/g, '');
          return /^\s*(https?:|#|data:image\/)/i.test(v) || v === '' ? m2 : '';
        });
      return `<${close}${tag}${clean}>`;
    });
}

// Only the renderer recognizes math fences; conversion/downloads stay untouched.
const previewMd = new MarkdownIt();
const trustedPreviewMd = new MarkdownIt({ html: true });
const defaultFence = previewMd.renderer.rules.fence;
trustedPreviewMd.block.ruler.before('html_block', 'svg_block', (state, start, end, silent) => {
  const from = state.bMarks[start] + state.tShift[start];
  if (!/^<svg\b/i.test(state.src.slice(from, state.eMarks[start]))) return false;
  let next = start;
  while (next < end && !/<\/svg>\s*$/i.test(state.src.slice(state.bMarks[next], state.eMarks[next]))) next++;
  if (next === end) return false;
  if (silent) return true;
  state.push('html_block', '', 0).content = state.src.slice(from, state.eMarks[next]);
  state.line = next + 1;
  return true;
});
for (const md of [previewMd, trustedPreviewMd]) {
  md.block.ruler.before('fence', 'tex_display', (state, start, end, silent) => {
    const line = (i) => state.src.slice(state.bMarks[i] + state.tShift[i], state.eMarks[i]).trim();
    if (state.sCount[start] - state.blkIndent >= 4 || line(start) !== '$$') return false;
    let i = start + 1;
    while (i < end && (state.isEmpty(i) || state.sCount[i] >= state.blkIndent) && line(i) !== '$$') i++;
    if (i === end || line(i) !== '$$') return false;
    if (silent) return true;
    state.push('tex_display', '', 0).content = state.getLines(start, i + 1, state.blkIndent, false);
    state.line = i + 1;
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.inline.ruler.before('escape', 'tex_inline', (state, silent) => {
    const start = state.pos;
    const src = state.src;
    if (src[start] !== '$' || /[\s$]/.test(src[start + 1] || ' ')) return false;
    const boundary = src.indexOf('\n', start + 1);
    let end = src.indexOf('$', start + 1);
    while (end !== -1 && src[end - 1] === '\\') end = src.indexOf('$', end + 1);
    if (end < 0 || end >= state.posMax || (boundary !== -1 && end >= boundary) ||
      /\s/.test(src[end - 1]) || /\d/.test(src[end + 1] || '')) return false;
    if (!silent) state.push('tex_inline', '', 0).content = src.slice(start, end + 1);
    state.pos = end + 1;
    return true;
  });
  md.core.ruler.after('inline', 'task_checkboxes', ({ tokens }) => {
    for (let i = 2; i < tokens.length; i++) {
      if (tokens[i].type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' ||
        tokens[i - 2].type !== 'list_item_open' || !/^\[[ xX]\][ \t]/.test(tokens[i].content)) continue;
      const text = tokens[i].children?.[0];
      if (text?.type !== 'text' || !/^\[[ xX]\][ \t]/.test(text.content)) continue;
      const checked = text.content[1].toLowerCase() === 'x';
      text.content = text.content.slice(4);
      tokens[i].children.unshift({ type: 'task_checkbox', checked });
    }
    for (const token of tokens) {
      if (token.type !== 'inline' || !token.children) continue;
      let linkDepth = 0;
      token.children = token.children.flatMap((child) => {
        if (child.type === 'link_open') linkDepth++;
        if (child.type === 'link_close') linkDepth--;
        if (linkDepth || child.type !== 'text' || !/\[[ x]\]/i.test(child.content)) return [child];
        return child.content.split(/(\[[ x]\])/gi).filter(Boolean).map((content) =>
          /^\[[ x]\]$/i.test(content)
            ? { type: 'task_checkbox', checked: content.toLowerCase() === '[x]' }
            : { type: 'text', content });
      });
    }
  });
  md.validateLink = ((validate) => (url) =>
    /^data:image\/(?:png|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/.test(url) || validate(url)
  )(md.validateLink);
  Object.assign(md.renderer.rules, {
    tex_display: (tokens, i) => '<div class="math">' + escapeHtml(tokens[i].content) + '</div>\n',
    tex_inline: (tokens, i) => '<span class="math-inline">' + escapeHtml(tokens[i].content) + '</span>',
    task_checkbox: (tokens, i) => '<input type="checkbox" aria-label="' +
      (tokens[i].checked ? 'Checked' : 'Unchecked') + '" disabled' + (tokens[i].checked ? ' checked' : '') + '>',
    fence(tokens, i, options, env, self) {
      const { info, content } = tokens[i];
      const kind = info.trim().toLowerCase();
      if (kind !== 'mermaid') return defaultFence(tokens, i, options, env, self);
      const code = escapeHtml(content.trimEnd());
      return '<div class="mermaid" data-code="' + code + '"><pre class="code">' + code + '</pre></div>\n';
    },
    image(tokens, i, options, env, self) {
      const token = tokens[i];
      const url = token.attrGet('src');
      const alt = self.renderInlineAsText(token.children, options, env);
      const asset = env.images.get(url);
      let src = url;
      if (asset) {
        let bytes = '';
        for (let j = 0; j < asset.bytes.length; j += 0x8000) {
          bytes += String.fromCharCode(...asset.bytes.subarray(j, j + 0x8000));
        }
        const mime = asset.path.endsWith('.svg') ? 'svg+xml' : asset.path.endsWith('.webp') ? 'webp' : 'png';
        src = 'data:image/' + mime + ';base64,' + btoa(bytes);
      } else if (!/^data:image\/(?:png|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/.test(url)) {
        return escapeHtml(alt);
      }
      return '<img class="pdf-image" src="' + escapeHtml(src) + '" alt="' + escapeHtml(alt) + '" loading="lazy">';
    },
    html_inline: (tokens, i) => escapeHtml(tokens[i].content),
    html_block: (tokens, i) => /^(?:<svg\b|<(?:table|div)\b[^>]*\bclass="il-)/.test(tokens[i].content)
      ? sanitizeHtml(tokens[i].content) : '<p>' + escapeHtml(tokens[i].content) + '</p>\n',
  });
}

function renderMarkdown(md, assets = [], { allowRawHtml = true } = {}) {
  const renderer = allowRawHtml ? trustedPreviewMd : previewMd;
  const images = new Map(assets.map((asset) => [renderer.normalizeLink(asset.path), asset]));
  return renderer.render(String(md), { images });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

if (typeof customElements !== 'undefined' && !customElements.get('ingest-dropzone')) {
  customElements.define('ingest-dropzone', IngestDropzone);
}

export { IngestDropzone as IngestDropzoneElement };
export { renderMarkdown };

/**
 * React 18/19 wrapper:
 *   <IngestDropzone label="..." markdownProfile="rag" sceneThreshold={0.12} maxKeyframes={8}
 *                   onIngestResult={(e) => console.log(e.detail)} />
 * Uses React from props.react ?? globalThis.React — zero bundled framework.
 */
export function IngestDropzoneReact(props = {}) {
  const React = props.react || globalThis.React;
  if (!React) {
    throw new Error('ingestlab/widget: IngestDropzoneReact needs React (pass props.react or set globalThis.React)');
  }
  const { react, markdownProfile, sceneThreshold, maxKeyframes, onIngestResult, onIngestError, onIngestProgress, onIngestSample, ...rest } = props;
  const domProps = { ...rest };
  if (markdownProfile !== undefined) domProps['markdown-profile'] = markdownProfile;
  if (sceneThreshold !== undefined) domProps['scene-threshold'] = String(sceneThreshold);
  if (maxKeyframes !== undefined) domProps['max-keyframes'] = String(maxKeyframes);
  if (onIngestResult) domProps.oningestresult = onIngestResult;
  if (onIngestError) domProps.oningesterror = onIngestError;
  if (onIngestProgress) domProps.oningestprogress = onIngestProgress;
  if (onIngestSample) domProps.oningestsample = onIngestSample;
  return React.createElement('ingest-dropzone', domProps);
}
export { IngestDropzoneReact as IngestDropzone };

export { IngestLab, detectCapabilities, VERSION } from './index.js';
export { sniffKind, demuxVideo } from './demux.js';
export { destroyVideoEngine } from './video.js';
