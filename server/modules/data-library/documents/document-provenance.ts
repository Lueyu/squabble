import type { ResearchDocumentLocator } from '../../../../shared/research-artifact.interface';

export interface DocumentElement { text: string; locator: ResearchDocumentLocator; extractionConfidence: 'unknown' }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export function extractDocumentElements(raw: unknown, format: 'pdf' | 'docx'): DocumentElement[] {
  const document = object(raw), pages = object(document.pages);
  const middle = document.schema === 'docvortex.middle' ? document : Object.values(document).map(object).find(value => value.schema === 'docvortex.middle');
  if (middle) return mineruElements(middle, format);
  const entries = [...(Array.isArray(document.texts) ? document.texts : []), ...(Array.isArray(document.tables) ? document.tables : [])];
  return entries.flatMap<DocumentElement>((value, index): DocumentElement[] => {
    const entry = object(value), elementId = typeof entry.self_ref === 'string' ? entry.self_ref : `element:${index}`;
    const text = typeof entry.text === 'string' ? entry.text : JSON.stringify(entry.data ?? '');
    if (!text) return [];
    if (format === 'docx') {
      const tableId = elementId.startsWith('#/tables/') ? elementId : null;
      const result: DocumentElement[] = [{ text, extractionConfidence: 'unknown' as const, locator: { kind: 'docx' as const,
      elementId, paragraphId: elementId.startsWith('#/texts/') ? elementId : null,
      tableId, cellId: null } }];
      const cells = object(entry.data).table_cells;
      if (tableId && Array.isArray(cells)) for (const cellValue of cells) {
        const cell = object(cellValue);
        if (typeof cell.text !== 'string' || !Number.isSafeInteger(cell.start_row_offset_idx) || !Number.isSafeInteger(cell.start_col_offset_idx)) continue;
        const cellId = `${tableId}/cells/${cell.start_row_offset_idx}:${cell.start_col_offset_idx}`;
        result.push({ text: cell.text, extractionConfidence: 'unknown', locator: { kind: 'docx', elementId: cellId,
          paragraphId: null, tableId, cellId } });
      }
      return result;
    }
    const provenance = Array.isArray(entry.prov) ? entry.prov : [];
    return provenance.flatMap(prov => {
      const source = object(prov), page = source.page_no;
      if (!Number.isSafeInteger(page) || Number(page) < 1) return [];
      const bbox = object(source.bbox), size = object(object(pages[String(page)]).size);
      const origin = bbox.coord_origin === 'BOTTOMLEFT' ? 'bottom_left' as const : bbox.coord_origin === 'TOPLEFT' ? 'top_left' as const : null;
      return [{ text, extractionConfidence: 'unknown' as const, locator: { kind: 'pdf' as const, elementId, physicalPage: Number(page),
        pageLabel: typeof source.page_label === 'string' ? source.page_label : null,
        bbox: origin && finite(bbox.l) && finite(bbox.r) && finite(bbox.t) && finite(bbox.b) ?
          { x: Math.min(bbox.l, bbox.r), y: Math.min(bbox.t, bbox.b), width: Math.abs(bbox.r - bbox.l), height: Math.abs(bbox.t - bbox.b), origin } : null,
        pageSize: finite(size.width) && finite(size.height) && size.width > 0 && size.height > 0 ?
          { width: size.width, height: size.height, unit: 'pt' as const } : null } }];
    });
  });
}
function spanText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(spanText).filter(Boolean).join(' ');
  const span = object(value); return spanText(span.content ?? span.text ?? null);
}
function mineruElements(document: Record<string, unknown>, format: 'pdf' | 'docx'): DocumentElement[] {
  if (document.schema_version !== '2.0' || !Array.isArray(document.pages)) throw new Error('MINERU_DOCUMENT_SCHEMA_UNSUPPORTED');
  const sizes = object(object(document.extensions).docvortex_layout).pages;
  return document.pages.flatMap<DocumentElement>(pageValue => {
    const page = object(pageValue); if (!Number.isSafeInteger(page.page_idx) || Number(page.page_idx) < 0 || !Array.isArray(page.blocks)) return [];
    return page.blocks.flatMap<DocumentElement>((blockValue, index) => {
      const block = object(blockValue), text = spanText(block.content);
      if (!text) return [];
      const elementId = `mineru:page:${page.page_idx}:block:${Number.isSafeInteger(block.index) ? block.index : index}`;
      if (format === 'docx') return [{ text, extractionConfidence: 'unknown', locator: { kind: 'docx', elementId,
        paragraphId: block.type === 'text' ? elementId : null, tableId: block.type === 'table' ? elementId : null, cellId: null } }];
      const size = Array.isArray(sizes) ? object(sizes.find(value => object(value).page_idx === page.page_idx)) : {};
      return [{ text, extractionConfidence: 'unknown', locator: { kind: 'pdf', elementId, physicalPage: Number(page.page_idx) + 1,
        pageLabel: null, bbox: null, pageSize: finite(size.width_pt) && finite(size.height_pt) ?
          { width: size.width_pt, height: size.height_pt, unit: 'pt' } : null } }];
    });
  });
}
