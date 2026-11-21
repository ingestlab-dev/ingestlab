function headerSignature(table) {
  const count = Math.min(table.meta?.headerRows || 1, table.rows?.length || 0);
  return table.rows.slice(0, count).map((row) => row.map((cell) => String(cell ?? '').trim().toLowerCase()).join('\u001f')).join('\u001e');
}

function compatible(previous, current, previousPage, currentPage) {
  if (!previous?.rows?.length || !current?.rows?.length) return false;
  if (previous.meta?.headerRows !== current.meta?.headerRows) return false;
  if (previous.rows[0].length !== current.rows[0].length) return false;
  if (previous.bbox && previousPage?.height && previous.bbox.y1 < previousPage.height * 0.62) return false;
  if (current.bbox && currentPage?.height && current.bbox.y0 > currentPage.height * 0.38) return false;
  return headerSignature(previous) === headerSignature(current);
}

export function mergeContinuedTables(pages, options = {}) {
  const merged = pages.map((page) => page.map((block) => ({ ...block })));
  for (let pageIndex = 1; pageIndex < merged.length; pageIndex++) {
    const previous = merged[pageIndex - 1];
    const current = merged[pageIndex];
    const previousTables = previous.filter((block) => block.type === 'table');
    const currentTables = current.filter((block) => block.type === 'table');
    for (const table of currentTables) {
      const candidate = previousTables.find((prior) => compatible(prior, table, options.pageData?.[pageIndex - 1], options.pageData?.[pageIndex]));
      if (!candidate) continue;
      const headerCount = table.meta?.headerRows || 1;
      const body = table.rows.slice(headerCount);
      candidate.rows = [...candidate.rows, ...body];
      candidate.continuedPages = [...(candidate.continuedPages || []), pageIndex + 1];
      candidate.continuedSources = [...(candidate.continuedSources || []), { page: pageIndex + 1 }];
      table._continuedDuplicate = true;
      table.continuedFromPage = pageIndex;
    }
  }
  return merged;
}
