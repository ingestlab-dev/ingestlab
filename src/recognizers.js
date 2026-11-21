const RECOGNIZABLE = new Set([
  'formula', 'figure', 'chart', 'diagram', 'form_field', 'checkbox', 'ocr_low_confidence',
]);

function blockType(block, page) {
  if (page?.ocr && (page.ocrConfidence ?? 1) < 0.7) return 'ocr_low_confidence';
  if (block.type === 'math') return 'formula';
  if (block.type === 'figure' && ['chart'].includes(block.kind)) return 'chart';
  if (block.type === 'figure' && ['diagram', 'schematic', 'circuit'].includes(block.kind)) return 'diagram';
  if (block.type === 'field' || block.type === 'form_line') return 'form_field';
  if (block.type === 'form_choice') return 'checkbox';
  return block.type;
}

function matches(recognizer, type) {
  const types = recognizer.types || recognizer.type;
  if (!types) return RECOGNIZABLE.has(type);
  return Array.isArray(types) ? types.includes(type) : types === type;
}

export async function applyRecognizers(pages, recognizers = [], context = {}) {
  if (!recognizers?.length) return { applied: 0, failures: [] };
  let applied = 0;
  const failures = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    for (let blockIndex = 0; blockIndex < page.length; blockIndex++) {
      const block = page[blockIndex];
      const type = blockType(block, context.pageData?.[pageIndex]);
      for (const recognizer of recognizers) {
        if (!recognizer || typeof recognizer.recognize !== 'function' || !matches(recognizer, type)) continue;
        try {
          const result = await recognizer.recognize({
            block,
            type,
            page: pageIndex + 1,
            blockIndex,
            pageData: context.pageData?.[pageIndex],
            document: context.document,
          });
          if (!result || typeof result !== 'object') continue;
          Object.assign(block, result);
          block.recognizer = recognizer.name || recognizer.id || 'custom';
          block.recognizerConfidence = result.confidence ?? block.confidence;
          block.prov = result.prov || `recognizer:${block.recognizer}`;
          applied++;
        } catch (error) {
          failures.push({ page: pageIndex + 1, blockIndex, type, recognizer: recognizer.name || recognizer.id || 'custom', error: String(error?.message || error) });
        }
      }
    }
  }
  return { applied, failures };
}
