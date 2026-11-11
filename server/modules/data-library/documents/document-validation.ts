import type { DocumentElement } from './document-provenance';

export interface NumericGold { elementId: string; expected: string; unit: string | null }
export interface NumericValidation { status: 'unknown' | 'verified' | 'needs_review'; checks: Array<NumericGold & { rawText: string | null; matched: boolean }> }
/** Validation records discrepancies; it never rewrites the extracted number or fabricates OCR confidence. */
export function validateDocumentNumbers(elements: DocumentElement[], gold: NumericGold[]): NumericValidation {
  const checks = gold.map(check => {
    const rawText = elements.find(element => element.locator.elementId === check.elementId)?.text ?? null;
    const tokens = rawText?.match(/(?:[（(][−-]?\d[\d,]*(?:\.\d+)?[）)]|[−-]?\d[\d,]*(?:\.\d+)?)/gu) ?? [];
    const values = tokens.map(token => token.replaceAll(',', '').replace('−', '-').replace(/^[（(](.*)[）)]$/u, '-$1'));
    return { ...check, rawText, matched: values.includes(check.expected) && (check.unit === null || Boolean(rawText?.includes(check.unit))) };
  });
  return { status: checks.length ? checks.every(check => check.matched) ? 'verified' : 'needs_review' : 'unknown', checks };
}
