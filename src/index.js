
import { openDocument, extractPage, loadPdfjs } from './pdfio.js';
import { fingerprintDoc, collectOutline, extractStructRoles } from './pdfInternals.js';
import { buildProfile, stripRepeatingChrome } from './profiler.js';
import { detectCapabilities } from './router.js';
import { cacheForBytes } from './opfs.js';
import { applyImageMode, emitBlocks } from './markdown.js';
import { mergeRegions, createVisionEngine, iou, nms } from './vision.js';
import { sniffKind } from './kind.js';
import { destroyOcrWorker, ocrPage, ocrPagesParallel, probeOcrLang, OCR_DEFAULT_LANGS } from './ocr.js';
import { normalizeOcrLanguages, resolveOcrModels } from './ocrLanguages.js';
import { addControlEvidence, pageOrderedBlocks, toRagBlocks, toRagChunks } from './rag.js';
import { addControlsToGraph, buildDocumentGraph, linkContainedElements } from './documentGraph.js';
import { applyRecognizers } from './recognizers.js';
import { mergeContinuedTables } from './tableContinuations.js';
export { addControlEvidence, rankRagChunks } from './rag.js';
export { addControlsToGraph, buildDocumentGraph, linkContainedElements } from './documentGraph.js';
export {
  applyRecognizers,
  createFormulaRecognizer,
  createChemistryRecognizer,
  createChartRecognizer,
  createHandwritingRecognizer,
} from './recognizers.js';
export { OCR_LANGUAGE_CODES } from './ocrLanguages.js';

export const VERSION = '1.1.3';

const DEFAULT_USD_PER_PAGE_CLOUD = 0.003;

const DEFAULT_OPTS = {
  dropHeadersFooters: true,
  detectBorderlessTables: true,
  cache: true,
  vision: false,
  ocr: true,
  ocrLangs: OCR_DEFAULT_LANGS,
  ocrPageLimit: Infinity,
  ocrWorkers: 0,
  ocrCacheDir: null,
  ocrAutoLang: true,
  ocrRoi: true,
  ocrImages: true,
  figures: true,
  maxFigures: Infinity,
};

export class IngestLab {
  /** @private */
  constructor({ pdfjs, caps, route, opts }) {
    this.pdfjs = pdfjs;
    this.caps = caps;
    this.route = route;
    this.opts = { ...DEFAULT_OPTS, ...opts };
    if (opts.ocrLangs !== undefined) this.opts.ocrAutoLang = false;
  }

  /**
   * @param {object} opts {pdfjs?: injected pdf.js module, docOpts?: pdf.js getDocument opts, ...parse defaults}
   */
  static async init(opts = {}) {
    const pdfjs = opts.pdfjs;
    const { caps, route } = await detectCapabilities();
    return new IngestLab({ pdfjs, caps, route, opts });
  }

  /**
   * Parse a PDF into markdown.
   * @param {Uint8Array|ArrayBuffer} bytes
   * @param {object} opts parse-time overrides + onProgress(ev)
   * @returns {Promise<{markdown, blocks, pages, stats, caps, route, fromCache}>}
   */
  async parse(input, opts = {}) {
    const o = { ...this.opts, ...opts };
    const explicitOcrLangs = opts.ocrLangs !== undefined || !o.ocrAutoLang;
    o.ocrLangs = normalizeOcrLanguages(o.ocrLangs);
    if (o.ocr) resolveOcrModels(o.ocrLangs, o.ocrRuntime);
    o.ocrAutoLang = o.ocrAutoLang && !explicitOcrLangs && !o.ocrRuntime?.langPath;
    o.imageMode ??= o.preservePages || o.vectorFigures ? 'refs' : 'none';
    const renderVisuals = o.imageMode !== 'none';
    // Copy Buffers into a plain Uint8Array for PDF.js.
    const bytes =
      input instanceof Uint8Array && input.constructor === Uint8Array
        ? input
        : new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
    const t0 = performance.now();

    let cache = null;
    if (o.cache && !o.debug && !o.docOpts && !o.ocrRuntime && !o.recognizers?.length) {
      // Include output options in the cache key. Apply image mode after reading the cached result.
      const cacheVersion =
        `${VERSION}:pdf:ocr${o.ocr ? 1 : 0}:${o.ocrLangs}:${o.vision ? 1 : 0}` +
        ` :dh${o.dropHeadersFooters ? 1 : 0}:bt${o.detectBorderlessTables ? 1 : 0}:fig${o.figures ? 1 : 0}` +
        `:ol${Number.isFinite(o.ocrPageLimit) ? o.ocrPageLimit : 'inf'}:roi${o.ocrRoi ? 1 : 0}:al${o.ocrAutoLang ? 1 : 0}` +
        `:fmax${o.maxFigures}:visual${+renderVisuals}:source${+!!o.preservePages}:html${+!!o.semanticHtml}:ocrimg${+!!o.ocrImages}` +
        `:svg${+!!o.vectorFigures}:raster${+!o.skipRasterFigures}:artifact${+!!o.dropArtifacts}:profile${o.markdownProfile || 'faithful'}:gfm24` +
        `:model${JSON.stringify([o.ocrRuntime?.langPath, o.ocrRuntime?.gzip])}`;
      cache = await cacheForBytes(bytes, cacheVersion);
      const hit = await cache.get();
      if (hit)
        return {
          ...hit,
          markdown: applyImageMode(hit.markdown, hit.assets, o.imageMode),
          richMarkdown: hit.richMarkdown && applyImageMode(hit.richMarkdown, hit.assets, o.imageMode),
          imageMode: o.imageMode,
          fromCache: true,
          cacheBackend: cache.backend,
        };
    }

    const onProgress = (ev) => opts.onProgress?.(ev);
    this.pdfjs ||= await loadPdfjs();
    const { doc, task } = await openDocument(bytes, { pdfjsModule: this.pdfjs, docOpts: o.docOpts });
    try {
      return await this.#parseDocument(doc, bytes, o, onProgress, cache, renderVisuals, t0);
    } finally {
      await Promise.all([task.destroy(), destroyOcrWorker()]);
    }
  }

  async #parseDocument(doc, bytes, o, onProgress, cache, renderVisuals, t0) {
    const fingerprint = await fingerprintDoc(doc);
    const outline = await collectOutline(doc);
    const pages = doc.numPages;

    const tExtract0 = performance.now();
    const pageData = [];
    let ocrPages = 0;
    let ocrFailed = 0;
    let scannedUnread = 0;
    let figBudget = o.maxFigures;
    let analyzeFig = null;
    let ocrAttempts = 0;
    const pendingOcr = [];
    const isNodeEnv = typeof process !== 'undefined' && process.versions?.node;
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      let data = await extractPage(page, this.pdfjs, { dropArtifacts: o.dropArtifacts });
      if (data.annotations.length >= 2) {
        try {
          const { readTaggedForm } = await import('./taggedForm.js');
          data.taggedForm = await readTaggedForm(page, data, {
            dropArtifacts: o.dropArtifacts, includeRowInfo: o.markdownProfile === 'rag',
          });
        } catch { /* Fall back to geometric layout. */ }
      }
      try {
        data.structRoles = await extractStructRoles(page);
      } catch {
        data.structRoles = [];
      }
      onProgress({ stage: 'extract', page: p, pages });
      // Queue image-only pages for OCR after native extraction.
      if (data.words.length === 0) {
        data.scannedPage = true;
        if (!o.ocr || ocrAttempts >= o.ocrPageLimit) {
          scannedUnread++;
          pageData.push(data);
          page.cleanup?.();
          continue;
        }
        if (true) {
          ocrAttempts++;
          data = {
            width: data.width,
            height: data.height,
            words: [],
            segments: { h: [], v: [] },
            drawPts: [],
            images: data.images || [],
            rotated: [],
            curves: [],
            fills: [],
            primitives: [],
            annotations: [],
            checkboxes: [],
            diags: [],
            scannedPage: true,
            ocr: true,
            _pendingOcr: true,
          };
          pendingOcr.push(p);
          pageData.push(data);
          page.cleanup?.();
          continue;
        }
        ocrAttempts++;
        onProgress({ stage: 'ocr', page: p, pages });
        try {
          const ocr = await ocrPage(page, this.pdfjs, {
            ocrLangs: o.ocrLangs,
            ocrRuntime: o.ocrRuntime,
            ocrConfidenceRetry: o.ocrConfidenceRetry,
            ocrConfidenceThreshold: o.ocrConfidenceThreshold,
            ocrPreprocess: o.ocrPreprocess,
          });
          if (ocr.words.length) {
            data = {
              width: data.width,
              height: data.height,
              words: ocr.words,
              segments: ocr.segments || { h: [], v: [] },
              drawPts: data.drawPts || [],
              images: data.images || [],
              rotated: data.rotated || [],
              curves: data.curves || [],
              fills: data.fills || [],
              primitives: data.primitives || [],
              annotations: [],
              checkboxes: [],
              diags: [],
              scannedPage: true,
              ocr: true,
              ocrConfidence: ocr.confidence,
              ocrConfidenceRetry: ocr.confidenceRetry,
            };
            ocrPages++;
          } else {
            scannedUnread++;
          }
        } catch (e) {
          ocrFailed++;
          scannedUnread++;
          if (ocrFailed === 1) console.warn('ingestlab: OCR unavailable for this page:', String(e?.message || e).slice(0, 140));
        }
      }
      pageData.push(data);
      page.cleanup?.();
    }

    if (pendingOcr.length) {
      let docHash = null;
      if (o.ocrCacheDir) {
        const { createHash } = await import('node:crypto');
        docHash = createHash('sha1').update(bytes).digest('hex');
      }
      // Reuse the probe result when it matches the selected OCR language.
      let ocrLangs = o.ocrLangs;
      let precomputed = null;
      if (o.ocrAutoLang && o.ocrLangs === OCR_DEFAULT_LANGS) {
        const probe = await probeOcrLang(doc, pendingOcr, this.pdfjs, {
          ocrLangs: o.ocrLangs, ocrRoi: o.ocrRoi, ocrRuntime: o.ocrRuntime,
        });
        ocrLangs = probe.langs;
        precomputed = probe.results;
      }
      const pool = await ocrPagesParallel(
        doc,
        pendingOcr,
        this.pdfjs,
        { ocrLangs, ocrWorkers: o.ocrWorkers, ocrCacheDir: o.ocrCacheDir, docHash, ocrRoi: o.ocrRoi, precomputed,
          ocrRuntime: o.ocrRuntime, ocrConfidenceRetry: o.ocrConfidenceRetry,
          ocrConfidenceThreshold: o.ocrConfidenceThreshold },
        { onProgress: (ev) => onProgress({ stage: 'ocr', page: ev.page, pages, ocrDone: ev.done, ocrTotal: ev.total }) }
      );
      if (pool) {
        for (const p of pendingOcr) {
          const r = pool.get(p);
          const data = pageData[p - 1];
          delete data._pendingOcr;
          if (r && r.words.length) {
            data.words = r.words;
            data.segments = r.segments;
              data.ocrConfidence = r.confidence;
            ocrPages++;
          } else if (r) {
            scannedUnread++;
          } else {
            ocrFailed++;
            scannedUnread++;
            if (ocrFailed === 1) console.warn('ingestlab: OCR unavailable for one or more pages; see stats.');
          }
        }
      } else {
        for (const p of pendingOcr) {
          onProgress({ stage: 'ocr', page: p, pages });
          try {
            const pg = await doc.getPage(p);
            const ocr = await ocrPage(pg, this.pdfjs, { ocrLangs, ocrRuntime: o.ocrRuntime, ocrConfidenceRetry: o.ocrConfidenceRetry, ocrConfidenceThreshold: o.ocrConfidenceThreshold, ocrPreprocess: o.ocrPreprocess });
            pg.cleanup?.();
            const data = pageData[p - 1];
            delete data._pendingOcr;
            if (ocr.words.length) {
              data.words = ocr.words;
              data.segments = ocr.segments;
              data.ocrConfidence = ocr.confidence;
              ocrPages++;
            } else {
              scannedUnread++;
            }
          } catch (e) {
            ocrFailed++;
            scannedUnread++;
            if (ocrFailed === 1) console.warn('ingestlab: OCR unavailable for this page:', String(e?.message || e).slice(0, 140));
          }
        }
      }
    }

    const { findFigureRegions, diagramMermaid, linkContinuedFigures, findParallelPanels } = await import('./figures.js');
    const { detectRuledTables, detectSemiRuledTables } = await import('./tables.js');
    const { describeConnections, extractStandaloneFlows, figureLabels } = await import('./visualText.js');
    if (o.figures) linkContinuedFigures(pageData);
    const { extractFormGrids } = await import('./formGrids.js');
    for (let p = 1; p <= pages; p++) {
      const data = pageData[p - 1];
      delete data._pendingOcr;
      data.figures = [];
      if (!data.taggedForm) data.formGrids = extractFormGrids(data);
      if (o.figures && !data.formGrids?.length && !data.ocr && figBudget > 0 && ((data.drawPts?.length ?? 0) > 20 || data.images?.length)) {
        try {
          const ruledBboxes = [...detectRuledTables(data.words, data.segments, data.width, data.height, { tol: 14 }), ...detectSemiRuledTables(data.words, data.segments, data.width, data.height, { tol: 14 })].map(
            (t) => t.bbox
          );
          if (!analyzeFig) analyzeFig = await import('./figrecon.js');
          const exactPanels = [...analyzeFig.extractLabeledBarPanels(data), ...analyzeFig.extractHierarchyPanels(data)];
          const exactDiagrams = [...analyzeFig.extractDualInlinePinouts(data), ...analyzeFig.extractCircuitPanels(data)];
          let regions = [...exactPanels, ...findFigureRegions(data, ruledBboxes, {}).filter((r) =>
            !exactPanels.some((b) => r.x0 >= b.x0 - 3 && r.x1 <= b.x1 + 3 && r.y0 >= b.y0 - 3 && r.y1 <= b.y1 + 3))];
          const area = (r) => (r.x1 - r.x0) * (r.y1 - r.y0);
          const overlap = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
            Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
          if (exactDiagrams.length) regions = [...exactDiagrams, ...regions.filter((r) => !exactDiagrams.some((p) =>
            overlap(r, p) > 0.7 * Math.min(area(r), area(p))))];
          const cards = findParallelPanels(data);
          if (cards.length) {
            for (const card of cards) {
              const exact = exactPanels.find((b) => overlap(b, card) > 0.85 * area(card));
              if (exact) Object.assign(card, { printedBars: exact.printedBars, hierarchy: exact.hierarchy });
            }
            regions = [...cards, ...regions.filter((r) => !cards.some((b) =>
              overlap(r, b) > 0.48 * Math.min(area(r), area(b))))];
          }
          const standalone = [...analyzeFig.extractAxisBarPanels(data), ...extractStandaloneFlows(data)];
          const intersects = (a, b) => overlap(a, b) > 0.4 * Math.min(area(a), area(b));
          for (const next of standalone) {
            if (regions.some((r) => (r.sourcePanel || r.printedBars || r.hierarchy) && intersects(next, r))) continue;
            regions = [...regions.filter((r) => !intersects(next, r)), next];
          }
          for (const r0 of regions) {
            if (figBudget <= 0) break;
            let analysis = null;
            try {
              analysis = analyzeFig.analyzeFigure(data, r0);
            } catch (e) {
              console.warn('ingestlab: figure analysis failed:', String(e?.message || e).slice(0, 120));
            }
            const hasStructured = analysis?.structured || r0.printedBars || r0.hierarchy;
            const connections = hasStructured ? null : describeConnections(data, r0);
            const labels = !connections && (!hasStructured || analysis?.kind2 === 'scatter') ? figureLabels(r0.labels) : [];
            data.figures.push({
              type: 'figure',
              bbox: r0,
              kind: r0.kind,
              kind2: analysis?.kind2 || null,
              mermaid: connections ? null : analysis?.mermaid || (!r0.sourcePanel ? diagramMermaid(r0) : null),
              svg: analysis?.svg || null,
              tableMd: connections ? null : analysis?.tableMd || null,
              visualContent: connections || (labels.length ? { labels } : undefined),
              data: analysis?.data || null,
              page: p,
              reconstruction: r0.circuit ? 'circuit-partial' : hasStructured ? 'geometry' : connections ? 'relations' :
                analysis?.mermaid || analysis?.tableMd ? 'heuristic' : labels.length ? 'labels' : 'none',
            });
            figBudget--;
          }
        } catch (e) {
          console.warn('ingestlab: figure reconstruction failed:', String(e?.message || e).slice(0, 120));
        }
      }

    }
    const extractMs = performance.now() - tExtract0;

    const { groupLines, computeDocScale, buildPageLayout } = await import('./layout.js');
    const linesPerPage = pageData.map((d) => groupLines(d.words, d.segments?.v || [], d.width));
    let dropped = o.dropHeadersFooters ? dropHeadersFooters(pageData, linesPerPage) : [];
    // Digit normalization can group unrelated headers, so this pass is opt-in.
    let chromeStripped = 0;
    if (o.hashChrome) {
      try {
      const chrome = stripRepeatingChrome(
        pageData.map((d, i2) => ({ lines: linesPerPage[i2], height: d.height })),
        { support: 0.4, band: 0.1, minPages: 2 }
      );
      dropped = linesPerPage.map((_, i2) => new Set([...(dropped[i2] || []), ...(chrome.dropped[i2] || [])]));
      chromeStripped = chrome.stripped;
      } catch { /* profiler is best-effort */ }
    }

    const tLayout0 = performance.now();
    const allLines = linesPerPage.flatMap((ls, i) => ls.filter((_, li) => !dropped[i]?.has(li)));
    const scale = computeDocScale(allLines);
    const typeProfile = buildProfile(pageData.map((d) => d.words || []));
    const pageBlocks = [];
    let maskedTotal = 0;
    for (let i = 0; i < pageData.length; i++) {
      const drop = dropped[i] || new Set();
      const activeLines = linesPerPage[i].filter((_, li) => !drop.has(li));
      const pi = i + 1;
      if (pageData[i].taggedForm) {
        pageBlocks.push(pageData[i].taggedForm);
        onProgress({ stage: 'layout', page: pi, pages });
        continue;
      }
      if (pageData[i].formGrids?.length) {
        pageBlocks.push(pageData[i].formGrids);
        onProgress({ stage: 'layout', page: pi, pages });
        continue;
      }
      const emittedWords = new Set();
      const blocks = buildPageLayout(
        {
          ...pageData[i],
          lines: activeLines,
          internals: {
            fingerprint,
            pageNum: pi,
            outlineAnchors: outline.filter((a) => a.page === i),
            structRoles: pageData[i].structRoles || [],
            typeProfile,
          },
        },
        scale,
        { borderless: o.detectBorderlessTables, emittedWords }
      );
      {
        const coveredText = blocks
          .map((b) => {
            if (b.type === 'table') return b.rows.flat().join(' ');
            if (b.type === 'list') return b.items.map((it) => it.text).join(' ');
            if (b.type === 'code') return b.lines.join(' ');
            if (b.type === 'figure') return [b.sourceText, b.sourceCaption, b.caption, ...(b.extraLabels || [])].filter(Boolean).join(' ');
            if (b.type === 'worksheet' || b.type === 'form_grid' || b.type === 'form_matrix' || b.type === 'kv_panel') return emitBlocks([b]);
            return b.text || '';
          })
          .join(' ');
        const covered = new Set(coveredText.split(/\s+/));
        const maskedBoxes = blocks
          .filter((b) => (b.type === 'table' || b.type === 'figure') && b.bbox)
          .map((b) => b.bbox);
        let masked = 0;
        const orphans = [];
        for (const w of activeLines.flatMap((l) => l.words)) {
          if (emittedWords.has(w)) continue;
          const t = w.str.trim();
          if (!t || covered.has(t)) continue;
          if (/^\s*[-–—*•▪◦●·‣⁃]\s*$/.test(t)) continue;
          // Suppress words only if the region's output already contains them.
          if (
            maskedBoxes.some((bb) => w.x0 >= bb.x0 - 2 && w.x1 <= bb.x1 + 2 && w.y >= bb.y0 - 2 && w.y <= bb.y1 + 2) &&
            coveredText.includes(t)
          ) {
            masked++;
            continue;
          }
          // Match text that was joined across a hyphen or within a word.
          if ((t.length <= 4 || t.endsWith('-')) && (coveredText.includes(t) || (t.endsWith('-') && coveredText.includes(t.slice(0, -1))))) continue;
          orphans.push(w);
        }
        if (maskedTotal !== undefined) maskedTotal += masked;
        if (orphans.length) {
          orphans.sort((a, b) => a.y - b.y || a.x0 - b.x0);
          const groups = [];
          let g = null;
          for (const w of orphans) {
            if (!g || w.y - g.y > Math.max(2.5, 1.8 * w.size)) {
              g = { y: w.y, words: [] };
              groups.push(g);
            }
            g.words.push(w);
          }
          const insertByY = (arr, y) => {
            let idx = arr.length;
            for (let bi = 0; bi < arr.length; bi++) {
              const b = arr[bi];
              const bY = b.bbox ? b.bbox.y1 : b._y1;
              if (bY === undefined) continue;
              if (bY > y + 2) {
                idx = bi;
                break;
              }
            }
            return idx;
          };
          for (const grp of groups) {
            const ys2 = grp.words.map((w) => w.y).sort((a, b) => a - b);
            const gy = ys2[Math.floor(ys2.length / 2)];
            const text2 = grp.words.map((w) => w.str.trim()).filter(Boolean).join(' ');
            blocks.splice(insertByY(blocks, gy), 0, { type: 'paragraph', text: text2 });
          }
        }
      }
      pageBlocks.push(blocks);
      onProgress({ stage: 'layout', page: i + 1, pages });
    }
    const stitchedPageBlocks = mergeContinuedTables(pageBlocks, { pageData });
    pageBlocks.splice(0, pageBlocks.length, ...stitchedPageBlocks);
    const recognizerResult = await applyRecognizers(pageBlocks, o.recognizers, { pageData, document: doc });
    for (let pageIndex = 0; pageIndex < pageBlocks.length; pageIndex++) {
      await o.onPage?.({
        page: pageIndex + 1,
        pages,
        blocks: pageBlocks[pageIndex],
        data: pageData[pageIndex],
      });
    }
    const layoutMs = performance.now() - tLayout0;

    const imageOcr = o.ocr && o.ocrImages
      ? await (await import('./ocr.js')).ocrImageRegions(doc, pageBlocks, pageData, o.ocrLangs,
        onProgress, o.ocrRuntime)
      : { done: 0, failed: 0 };
    const vectors = renderVisuals && o.vectorFigures
      ? await (await import('./vectorVisuals.js')).rebuildVectorFigures(doc, pageBlocks, onProgress)
      : { assets: [], failed: 0, unrepresented: 0 };
    const { assets, failed: visualFailed } = renderVisuals && (!o.skipRasterFigures || o.preservePages)
      ? await (await import('./pdfVisuals.js')).preserveVisuals(doc, pageBlocks, {
          preservePages: o.preservePages, scanPages: pageData.map((page) => page.ocr),
          skipRasterFigures: o.skipRasterFigures, onProgress,
        })
      : { assets: [], failed: 0 };
    assets.push(...vectors.assets);
    const tMd0 = performance.now();
    const { collectControls, renderControls, semanticTable } = await import('./semantic.js');
    const controls = pageData.flatMap((page, i) => collectControls(page, i + 1));
    const blocks = pageBlocks.flat();
    const ragBlocks = o.markdownProfile === 'rag' ? toRagBlocks(pageBlocks) : null;
    const outputMarkdown = emitBlocks(ragBlocks ?? pageOrderedBlocks(pageBlocks)).trimEnd() + '\n';
    const ragChunks = ragBlocks ? addControlEvidence(toRagChunks(ragBlocks), controls) : null;
    const richMarkdown = o.semanticHtml
      ? emitBlocks(ragBlocks ?? blocks, semanticTable)
      : undefined;
    const markdownMs = performance.now() - tMd0;

    const figures = pageData.flatMap((d) => d.figures || []);
    const documentGraph = linkContainedElements(addControlsToGraph(buildDocumentGraph(pageBlocks, { pageData, fingerprint }), controls));
    const stats = {
      pages,
      words: pageData.reduce((s, d) => s + d.words.length, 0),
      lines: allLines.length,
      headings: blocks.filter((b) => b.type === 'heading').length,
      tables: blocks.filter((b) => b.type === 'table').length,
      lists: blocks.filter((b) => b.type === 'list').length,
      codeBlocks: blocks.filter((b) => b.type === 'code').length,
      figures: blocks.filter((b) => b.type === 'figure').length,
      forms: blocks.filter((b) => b.form || ['form_grid', 'form_matrix', 'worksheet', 'kv_panel', 'form_section'].includes(b.type)).length,
      ocrPages,
      ocrConfidence: pageData.filter((page) => page.ocr).length
        ? pageData.filter((page) => page.ocr).reduce((sum, page) => sum + (page.ocrConfidence ?? 0), 0) /
          pageData.filter((page) => page.ocr).length
        : null,
      ocrFailed,
      scannedUnread,
      visualFailed,
      vectorFigures: vectors.assets.length,
      vectorFailed: vectors.failed,
      vectorUnrepresented: vectors.unrepresented,
      imageOcrRegions: imageOcr.done,
      imageOcrFailed: imageOcr.failed,
      chars: outputMarkdown.length,
      ms: Math.round((performance.now() - t0) * 10) / 10,
      extractMs: Math.round(extractMs * 10) / 10,
      layoutMs: Math.round(layoutMs * 10) / 10,
      markdownMs: Math.round(markdownMs * 10) / 10,
    };
    const result = {
      markdown: outputMarkdown,
      ...(ragChunks && { ragChunks }),
      controls,
      richMarkdown,
      formHtml: o.semanticHtml ? renderControls(controls) : undefined,
      blocks,
      figures,
      pages: pageBlocks,
      documentGraph,
      recognizers: recognizerResult,
      assets,
      stats,
      caps: this.caps,
      route: this.route,
      version: VERSION,
    };
    if (o.debug) {
      const provenance = {};
      for (const blocks of pageBlocks) {
        for (const b of blocks) {
          const k = b.prov || 'geometricFallback';
          provenance[k] = (provenance[k] || 0) + 1;
        }
      }
      const fauxBoldTotal = pageData.reduce((a2, d2) => a2 + (d2.fauxBold || 0), 0);
      const cellsMerged = pageBlocks.flat().reduce((a2, b2) => a2 + ((b2.spans && b2.spans.length) || 0), 0);
      result.debug = {
        fingerprint,
        outlineCount: outline.length,
        typeProfile,
        provenance,
        metrics: { fauxBoldRemoved: fauxBoldTotal, headersStripped: chromeStripped, cellsMerged, maskedWords: maskedTotal },
      };
    }
    onProgress({ stage: 'done', stats });

    // Don't cache incomplete results or binary assets.
    if (cache && ocrFailed === 0 && imageOcr.failed === 0 && visualFailed === 0 && vectors.failed === 0 && assets.length === 0) {
      await cache.put(result);
    }
    return {
      ...result,
      markdown: applyImageMode(result.markdown, result.assets, o.imageMode),
      richMarkdown: result.richMarkdown && applyImageMode(result.richMarkdown, result.assets, o.imageMode),
      imageMode: o.imageMode,
      fromCache: false,
      cacheBackend: cache ? cache.backend : 'off',
    };
  }

  /**
   * Detect the file format and run the PDF, video, or image pipeline.
   *
   * @param {File|Blob|Uint8Array|ArrayBuffer} fileOrBlob
   * @param {object} options { sceneThreshold, maxKeyframes, minGapUs, cache,
   *                           usdPerFrameCloud, usdPerPageCloud, onProgress }
   * @returns {Promise<{kind, markdown?, keyframes?, metrics}>}
   *   metrics: { backend, latencyMs, originalBytes, outputBytes,
   *              compressionRatio, estimatedSavedUsd, cacheHit }
   */
  async ingest(fileOrBlob, options = {}) {
    const o = { ...this.opts, ...options };
    const blob =
      fileOrBlob instanceof Blob ? fileOrBlob : new Blob([fileOrBlob instanceof Uint8Array ? fileOrBlob : new Uint8Array(fileOrBlob)]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const kind = sniffKind(bytes);
    const t0 = performance.now();

    if (kind === 'pdf') {
      const doc = await this.parse(bytes, options);
      const originalBytes = bytes.length;
      const outputBytes = new TextEncoder().encode(doc.markdown).length +
        (doc.imageMode === 'refs' ? doc.assets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0) : 0);
      return {
        kind,
        markdown: doc.markdown,
        ...(doc.ragChunks && { ragChunks: doc.ragChunks }),
        richMarkdown: doc.richMarkdown,
        formHtml: doc.formHtml,
        controls: doc.controls,
        assets: doc.assets,
        pages: doc.stats.pages,
        stats: doc.stats,
        metrics: {
          backend: doc.route.engine,
          latencyMs: Math.round((performance.now() - t0) * 10) / 10,
          originalBytes,
          outputBytes,
          compressionRatio: outputBytes ? Math.round((originalBytes / outputBytes) * 100) / 100 : 0,
          estimatedSavedUsd:
            Math.round(doc.stats.pages * (o.usdPerPageCloud ?? DEFAULT_USD_PER_PAGE_CLOUD) * 1e4) / 1e4,
          cacheHit: !!doc.fromCache,
        },
      };
    }

    if (kind === 'video/mp4' || kind === 'video/webm') {
      const { analyzeVideo, videoOptions } = await import('./video.js');
      const cacheVersion = `${VERSION}:storyboard3:${JSON.stringify(videoOptions(o))}:cost${o.usdPerFrameCloud ?? 0.0008}`;
      let cache = null;
      if (o.cache !== false) {
        cache = await cacheForBytes(bytes, cacheVersion);
        const hit = await cache.get();
        if (hit) {
          const keyframes = hit.keyframes.map(({ b64, type, ...k }) => ({
            ...k, blob: new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type }),
          }));
          return {
            kind: 'video',
            keyframes,
            framesProcessed: hit.framesProcessed,
            sceneCuts: hit.sceneCuts,
            scenes: hit.scenes,
            scenesRepresented: hit.scenesRepresented,
            maxFrameGapUs: hit.maxFrameGapUs,
            durationUs: hit.durationUs,
            width: hit.width,
            height: hit.height,
            metrics: {
              ...hit.metrics,
              cacheHit: true,
              latencyMs: Math.round((performance.now() - t0) * 10) / 10,
            },
          };
        }
      }

      const result = await analyzeVideo(bytes, o);
      const originalBytes = bytes.length;
      const outputBytes = result.keyframes.reduce((s, k) => s + (k.blob ? k.blob.size : 0), 0);
      const metrics = {
        backend: result.backend,
        latencyMs: Math.round((performance.now() - t0) * 10) / 10,
        originalBytes,
        outputBytes,
        compressionRatio: outputBytes ? Math.round((originalBytes / outputBytes) * 100) / 100 : 0,
        estimatedSavedUsd:
          Math.round(result.framesProcessed * (o.usdPerFrameCloud ?? 0.0008) * 1e4) / 1e4,
        cacheHit: false,
      };
      if (cache && outputBytes <= 4000000) {
        await cache.put({
          keyframes: await Promise.all(
            result.keyframes.map(async ({ blob, ...k }) => ({ ...k, type: blob.type, b64: await blobToBase64(blob) }))
          ),
          framesProcessed: result.framesProcessed,
          sceneCuts: result.sceneCuts,
          scenes: result.scenes,
          scenesRepresented: result.scenesRepresented,
          maxFrameGapUs: result.maxFrameGapUs,
          durationUs: result.durationUs,
          width: result.width,
          height: result.height,
          metrics,
        });
      }
      return {
        kind: 'video',
        keyframes: result.keyframes,
        framesProcessed: result.framesProcessed,
        sceneCuts: result.sceneCuts,
        scenes: result.scenes,
        scenesRepresented: result.scenesRepresented,
        maxFrameGapUs: result.maxFrameGapUs,
        durationUs: result.durationUs,
        width: result.width,
        height: result.height,
        metrics,
      };
    }

    if (kind.startsWith('image/')) {
      const { optimizeImage } = await import('./image.js');
      const { blob: out, width, height, optimized, animatedPreserved } = await optimizeImage(bytes, kind, o);
      const originalBytes = bytes.length;
      const outputBytes = out.size;
      return {
        kind: 'image',
        width, height, optimized, animatedPreserved,
        keyframes: [{ timestamp: 0, timestampUs: 0, diffScore: 0, isSceneCut: false, blob: out }],
        metrics: {
          backend: 'canvas-2d',
          latencyMs: Math.round((performance.now() - t0) * 10) / 10,
          originalBytes,
          outputBytes,
          compressionRatio: outputBytes ? Math.round((originalBytes / outputBytes) * 100) / 100 : 0,
          estimatedSavedUsd: 0,
          cacheHit: false,
        },
      };
    }

    throw new Error(`ingestlab.ingest: unsupported file type "${kind}" (need PDF, MP4/WebM video, or image)`);
  }
}

async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    s += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function dropHeadersFooters(pageData, linesPerPage) {
  const out = pageData.map(() => new Set());
  const norm = (s) => s.toLowerCase().replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
  // Repeating table footnotes are content, not page chrome.
  const FOOTNOTE_RE = /^[*†‡§¶②③④⑤]|^note\b/i;
  const zones = [];
  pageData.forEach((d, pi) => {
    const top = 0.11 * d.height;
    const bottom = 0.92 * d.height;
    for (let li = 0; li < linesPerPage[pi].length; li++) {
      const l = linesPerPage[pi][li];
      if (l.x1 - l.x0 > 0.6 * d.width && l.words.length >= 6) continue;
      if (l.x0 < 0.08 * d.width && l.x1 < 0.22 * d.width) continue;
      if (FOOTNOTE_RE.test(l.text.trim())) continue;
      // Ignore digit-only titles unless the line is a page number.
      const raw = l.text.trim();
      if (!norm(raw) && !/^\d{1,4}$/.test(raw)) continue;
      if (l.y < top) zones.push({ zone: 'top', text: norm(raw), pi, li });
      else if (l.y > bottom) zones.push({ zone: 'bottom', text: norm(raw), pi, li });
    }
  });
  const seen = new Map();
  for (const z of zones) {
    const k = z.zone + '|' + z.text;
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(z);
  }
  const total = pageData.length;
  for (const [k, group] of seen) {
    const pages = new Set(group.map((z) => z.pi));
    const isPageNumber = /^\d{1,4}$/.test(group[0].text) || (group[0].text === '' && k.endsWith('|'));
    const chrome =
      isPageNumber ||
      (pages.size >= 2 && (total <= 4 || pages.size / total >= 0.25));
    if (chrome) {
      // Keep a repeated line on page one if it serves as the title.
      const first = Math.min(...group.map((z) => z.pi));
      const firstLines = linesPerPage[first];
      const headerY = Math.min(...group.filter((z) => z.pi === first).map((z) => linesPerPage[z.pi][z.li].y));
      const biggerBelow = firstLines.some((l) => l.y > headerY && l.size > linesPerPage[first][group.find((z) => z.pi === first).li].size + 0.5);
      const topZone = group[0].zone === 'top';
      for (const z of group) {
        if (isPageNumber || z.pi > first || biggerBelow || !topZone) out[z.pi].add(z.li);
      }
    }
  }
  return out;
}

export { detectCapabilities, mergeRegions, createVisionEngine, iou, nms };
