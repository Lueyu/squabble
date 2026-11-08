import type { ResearchDocumentSection } from './research-document.interface';
import { readableResearchSection, readableResearchSections } from './research-reading';

export const STRATEGY_SOURCE_MAX_CHARACTERS = 200000;
export const STRATEGY_ENTRY_MAX_CHARACTERS = 12000;
type StrategyReportReading = { sections: ResearchDocumentSection[];
  snapshot?: { executionPlan?: unknown; executionPlanError?: unknown } | null };

function sourceSections(version: StrategyReportReading): ResearchDocumentSection[] {
  const plan = version.snapshot?.executionPlan;
  const systemObservation = plan && typeof plan === 'object' && 'parameterOrigin' in plan && plan.parameterOrigin === 'system_observation';
  return version.sections.filter(section => section.id !== 'execution-strategy'
    || Boolean(plan) && (!version.snapshot?.executionPlanError || systemObservation));
}

/** Missing/invalid proposal notices and raw metadata are not research to import. */
export function strategyImportSections(version: StrategyReportReading): ResearchDocumentSection[] {
  return sourceSections(version).filter(section => readableResearchSection(section).trim().length > 0);
}

export function strategyImportReadableContent(version: StrategyReportReading, sectionId?: string): string {
  const readable = strategyImportSections(version);
  if (sectionId) {
    const section = readable.find(section => section.id === sectionId);
    return section ? readableResearchSection(section) : '';
  }
  // Keep public source links extracted by the shared reader, without raw evidence JSON.
  return readable.length ? readableResearchSections(sourceSections(version)) : '';
}

/** Preserve exact text, paragraph separators and surrogate pairs in bounded observations. */
export function splitStrategySourceText(text: string): string[] {
  if (text.length > STRATEGY_SOURCE_MAX_CHARACTERS) throw new RangeError('Report source exceeds 200000 characters');
  const parts: string[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + STRATEGY_ENTRY_MAX_CHARACTERS, text.length);
    if (end < text.length) {
      // Prefer nearby paragraph boundaries without multiplying a valid source past 20 entries.
      const preferredStart = offset + STRATEGY_ENTRY_MAX_CHARACTERS * 0.9;
      const paragraph = text.lastIndexOf('\n\n', end - 2);
      if (paragraph >= preferredStart) end = paragraph + 2;
      else {
        const line = text.lastIndexOf('\n', end - 1);
        if (line >= preferredStart) end = line + 1;
      }
      const before = text.charCodeAt(end - 1), after = text.charCodeAt(end);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
    }
    parts.push(text.slice(offset, end)); offset = end;
  }
  return parts;
}
