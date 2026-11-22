function blockText(block) {
  if (typeof block.text === 'string') return block.text;
  if (block.type === 'code') return block.lines.join('\n');
  if (block.type === 'list') return block.items.map((item) => item.text).join('\n');
  if (block.type === 'figure') return [block.sourceText, block.sourceCaption, block.caption, ...(block.extraLabels || [])].filter(Boolean).join('\n');
  if (Array.isArray(block.rows)) return block.rows.map((row) => row.join(' | ')).join('\n');
  return '';
}

function elementType(block) {
  if (block.type === 'math') return 'formula';
  if (block.type === 'form_choice') return 'checkbox';
  if (block.type === 'field') return 'form_field';
  if (block.type === 'image') return block.rasterVisual?.kind === 'table' ? 'chart' : 'figure';
  if (block.type === 'figure') {
    if (block.kind === 'chart' || block.kind2 === 'chart') return 'chart';
    if (block.kind === 'schematic' || block.kind === 'circuit' || block.kind === 'diagram') return 'diagram';
  }
  if (block.type === 'form_line' || block.type === 'form_grid' || block.type === 'form_matrix' ||
      block.type === 'worksheet' || block.type === 'kv_panel' || block.type === 'form_section') return 'form_field';
  if (block.type === 'table') return 'table';
  return block.type;
}

function confidence(block, page) {
  if (block.confidence !== undefined) return block.confidence;
  if (page?.ocr) return page.ocrConfidence ?? 0.72;
  if (block.prov === 'geometricFallback') return 0.78;
  if (block.prov) return 0.92;
  return 0.86;
}

function cellElements(block, parentId, page, blockIndex) {
  if (!Array.isArray(block.rows)) return [];
  if (block.rows.some((row) => !Array.isArray(row))) return [];
  const rowCount = block.rows.length;
  const columnCount = Math.max(1, ...block.rows.map((row) => row.length));
  const rowHeight = block.bbox ? (block.bbox.y1 - block.bbox.y0) / Math.max(1, rowCount) : 0;
  const columnWidth = block.bbox ? (block.bbox.x1 - block.bbox.x0) / columnCount : 0;
  return block.rows.flatMap((row, rowIndex) => row.map((text, columnIndex) => {
    const bbox = block.bbox && rowHeight
      ? {
          x0: block.bbox.x0 + columnIndex * columnWidth,
          y0: block.bbox.y0 + rowIndex * rowHeight,
          x1: block.bbox.x0 + (columnIndex + 1) * columnWidth,
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
      provenance: block.prov || 'table-cell-inferred',
      ...(bbox && { bbox }),
    };
  }));
}

function tableSignature(element) {
  return element.text.split('\n')[0].toLowerCase().replace(/\s+/g, ' ').trim();
}

function sourceWords(block, pageData) {
  if (!block.bbox || !pageData?.words?.length) return undefined;
  const words = pageData.words.filter((word) => {
    const x = (word.x0 + word.x1) / 2;
    return x >= block.bbox.x0 && x <= block.bbox.x1 && word.y >= block.bbox.y0 && word.y <= block.bbox.y1;
  });
  return words.length ? words.map((word, index) => ({
    index,
    text: word.str,
    confidence: word.confidence,
    bbox: { x0: word.x0, y0: word.y - word.size, x1: word.x1, y1: word.y },
  })) : undefined;
}

export function buildDocumentGraph(pages, options = {}) {
  const elements = [];
  const pageInfo = [];
  const relations = [];
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
        sources: block.sources || [{ page: pageNumber, blockIndex }],
        ...(sourceWords(block, options.pageData?.[pageIndex]) && { sourceWords: sourceWords(block, options.pageData?.[pageIndex]) }),
        ...(block.kind && { kind: block.kind }),
        ...(block.kind2 && { kind2: block.kind2 }),
        ...(block.continuedPages && { continuedPages: block.continuedPages }),
        ...(block.reconstruction && { reconstruction: block.reconstruction }),
        ...(block.mermaid && { mermaid: block.mermaid }),
        ...(block.tableMd && { tableMd: block.tableMd }),
        ...(block.visualContent && { visualContent: block.visualContent }),
        ...(block.extraLabels?.length && { labels: block.extraLabels }),
      };
      const children = cellElements(block, id, pageNumber, blockIndex);
      if (children.length) element.children = children.map(({ id: childId }) => childId);
      elements.push(element, ...children);
      pageElements.push(id);
      if (block.type === 'figure' && block.sourceCaption) {
        relations.push({ from: id, type: 'has_caption', value: block.sourceCaption });
      }
      if (block.type === 'table' && block.continuedHeader) {
        relations.push({ from: id, type: 'continued_table' });
      }
    }
    pageInfo.push({ page: pageNumber, ...(options.pageData?.[pageIndex]?.width && { width: options.pageData[pageIndex].width }), ...(options.pageData?.[pageIndex]?.height && { height: options.pageData[pageIndex].height }), elements: pageElements });
  }
  const tables = elements.filter((element) => element.type === 'table');
  for (let i = 1; i < tables.length; i++) {
    const previous = tables[i - 1];
    const current = tables[i];
    if (current.page !== previous.page + 1 || tableSignature(current) !== tableSignature(previous)) continue;
    relations.push({ from: previous.id, to: current.id, type: 'continued_table' });
  }
  return {
    version: 1,
    elements,
    pages: pageInfo,
    relations,
    ...(options.fingerprint && { fingerprint: options.fingerprint }),
  };
}

export function addControlsToGraph(graph, controls = []) {
  for (const control of controls) {
    const id = `p${control.page}-control-${graph.elements.length}`;
    graph.elements.push({
      id,
      type: control.type === 'checkbox' || control.type === 'radio' ? 'checkbox' : 'form_field',
      text: control.label || control.name || '',
      page: control.page,
      blockIndex: -1,
      order: graph.elements.length,
      confidence: control.source === 'acroform' ? 0.98 : 0.82,
      provenance: control.source || 'form-control',
      bbox: control.bbox,
      control: { name: control.name, label: control.label, value: control.value, checked: control.checked, exportValue: control.exportValue, required: control.required, readOnly: control.readOnly },
    });
    graph.pages[control.page - 1]?.elements.push(id);
  }
  return graph;
}

export function linkContainedElements(graph) {
  const regions = graph.elements.filter((element) => ['figure', 'chart', 'diagram', 'table', 'form_field'].includes(element.type) && element.bbox);
  for (const element of graph.elements) {
    if (!element.bbox || regions.includes(element)) continue;
    const owner = regions.find((region) => region.page === element.page &&
      element.bbox.x0 >= region.bbox.x0 && element.bbox.y0 >= region.bbox.y0 &&
      element.bbox.x1 <= region.bbox.x1 && element.bbox.y1 <= region.bbox.y1);
    if (!owner) continue;
    graph.relations.push({ from: owner.id, to: element.id, type: 'contains' });
  }
  return graph;
}
