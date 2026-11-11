import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractDocumentElements } from './document-provenance';
import { validateDocumentNumbers } from './document-validation';

test('PDF locators preserve physical pages independently of printed labels and unknown geometry', () => {
  const document = { texts: [{ self_ref: '#/texts/0', text: 'Revenue 2025: (120) 万元',
    prov: [{ page_no: 4, page_label: 'iii', bbox: { l: 10, t: 700, r: 200, b: 680, coord_origin: 'BOTTOMLEFT' } }] }],
    pages: { 4: { size: { width: 600, height: 800 } } } };
  const elements = extractDocumentElements(document, 'pdf');
  assert.equal(elements[0].locator.kind, 'pdf');
  if (elements[0].locator.kind !== 'pdf') throw new Error('wrong locator');
  assert.equal(elements[0].locator.physicalPage, 4); assert.equal(elements[0].locator.pageLabel, 'iii');
  assert.equal(elements[0].locator.bbox?.origin, 'bottom_left');
  assert.equal(elements[0].locator.bbox?.height, 20);
  assert.equal(validateDocumentNumbers(elements, [{ elementId: '#/texts/0', expected: '-120', unit: '万元' }]).status, 'verified');
});
test('MinerU 4 middle JSON retains original zero-based source pages as physical PDF pages', () => {
  const elements = extractDocumentElements({ 'middle_json.json': { schema: 'docvortex.middle', schema_version: '2.0',
    pages: [{ page_idx: 4, blocks: [{ index: 2, type: 'text', content: [{ type: 'text', content: 'Cash 25' }] }] }],
    extensions: { docvortex_layout: { pages: [{ page_idx: 4, width_pt: 600, height_pt: 800 }] } } } }, 'pdf');
  assert.equal(elements.length, 1); assert.equal(elements[0].locator.kind, 'pdf');
  if (elements[0].locator.kind !== 'pdf') throw new Error('wrong locator');
  assert.equal(elements[0].locator.physicalPage, 5); assert.equal(elements[0].locator.pageLabel, null);
  assert.equal(elements[0].locator.bbox, null);
});
test('DOCX keeps stable element identity without inventing physical pages', () => {
  const elements = extractDocumentElements({ texts: [{ self_ref: '#/texts/0', text: 'A paragraph',
    prov: [{ page_no: 99 }] }] }, 'docx');
  assert.deepEqual(elements[0].locator, { kind: 'docx', elementId: '#/texts/0', paragraphId: '#/texts/0', tableId: null, cellId: null });
  assert.equal(validateDocumentNumbers(elements, [{ elementId: '#/texts/0', expected: '10', unit: null }]).status, 'needs_review');
});
test('DOCX table cells retain stable row and column identities and Unicode negatives remain negative', () => {
  const elements = extractDocumentElements({ tables: [{ self_ref: '#/tables/0', data: { table_cells: [
    { text: '经营现金流（20）万元', start_row_offset_idx: 1, start_col_offset_idx: 2 },
  ] } }] }, 'docx');
  const cell = elements.find(element => element.locator.kind === 'docx' && element.locator.cellId !== null);
  assert.ok(cell); assert.equal(cell.locator.kind, 'docx');
  assert.equal(validateDocumentNumbers(elements, [{ elementId: cell.locator.elementId, expected: '-20', unit: '万元' }]).status, 'verified');
});
