const TEXT_TYPES = new Set(['paragraph', 'heading', 'aside', 'instruction', 'field', 'form_choice', 'math', 'code']);

function blockText(block) {
  if (typeof block.text === 'string') return block.text;
  if (block.type === 'code') return block.lines.join('\n');
  if (block.type === 'list') return block.items.map((item) => item.text).join('\n');
  if (Array.isArray(block.rows)) return block.rows.map((row) => row.join(' | ')).join('\n');
  return '';
}

function elementType(block) {
  if (block.type === 'math') return 'formula';
  if (block.type === 'form_choice') return 'checkbox';
  if (block.type === 'field') return 'form_field';
  if (block.type === 'image') return 'figure';
  if (block.type === 'table') return 'table';
  return block.type;
}

function confidence(block, page) {
  if (block.confidence !== undefined) return block.confidence;
  if (page?.ocr) return 0.72;
  if (block.prov === 'geometricFallback') return 0.78;
  if (block.prov) return 0.92;
  return 0.86;
}

function cellElements(block, parentId, page, blockIndex) {
  if (!Array.isArray(block.rows)) return [];
  const rowCount = block.rows.length;
  const rowHeight = block.bbox ? (block.bbox.y1 - block.bbox.y0) / Math.max(1, rowCount) : 0;
  return block.rows.flatMap((row, rowIndex) => row.map((text, columnIndex) => {
    const bbox = block.bbox && rowHeight
      ? {
          x0: block.bbox.x0,
          y0: block.bbox.y0 + rowIndex * rowHeight,
          x1: block.bbox.x1,
          y1: block.bbox.y0 + (rowIndex + 1) * rowHeight,
        }
      : undefined;
    return {
      id: `${parentId}-r${rowIndex}-c${columnIndex}`,
      type: 'table_cell',
      text: String(text ?? ''),
      page,
      blockIndex,
      rowIndex,
      columnIndex,
      parentId,
      ...(bbox && { bbox }),
    };
  }));
}

export function buildDocumentGraph(pages, options = {}) {
  const elements = [];
  const pageInfo = [];
  let order = 0;
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex] || [];
    const pageNumber = pageIndex + 1;
    const pageElements = [];
    for (let blockIndex = 0; blockIndex < page.length; blockIndex++) {
      const block = page[blockIndex];
      if (!block || block.type === 'source_page') continue;
      const id = `p${pageNumber}-b${blockIndex}`;
      const element = {
        id,
        type: elementType(block),
        text: blockText(block),
        page: pageNumber,
        blockIndex,
        order: order++,
        confidence: confidence(block, options.pageData?.[pageIndex]),
        provenance: block.prov || (options.pageData?.[pageIndex]?.ocr ? 'ocr' : 'geometricFallback'),
        ...(block.bbox && { bbox: block.bbox }),
        ...(block.sources && { sources: block.sources }),
        ...(block.kind && { kind: block.kind }),
        ...(block.kind2 && { kind2: block.kind2 }),
      };
      const children = cellElements(block, id, pageNumber, blockIndex);
      if (children.length) element.children = children.map(({ id: childId }) => childId);
      elements.push(element, ...children);
      pageElements.push(id);
    }
    pageInfo.push({ page: pageNumber, ...(options.pageData?.[pageIndex]?.width && { width: options.pageData[pageIndex].width }), ...(options.pageData?.[pageIndex]?.height && { height: options.pageData[pageIndex].height }), elements: pageElements });
  }
  return {
    version: 1,
    elements,
    pages: pageInfo,
    ...(options.fingerprint && { fingerprint: options.fingerprint }),
  };
}
