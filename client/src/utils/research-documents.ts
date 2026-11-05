import type { ResearchDocumentSection, ResearchDocumentVersion, ResearchSectionDiff } from '@shared/research-document.interface';

export function researchDiscussionPath(version: Pick<ResearchDocumentVersion, 'id' | 'kind' | 'ticker'>, sectionId?: string, excerpt?: string): string {
  const query = new URLSearchParams({ referenceVersionId: version.id, scene: version.kind === 'portfolio' || version.ticker === 'PORTFOLIO' ? 'portfolio_daily' : 'stock' });
  if (sectionId) query.set('sectionId', sectionId);
  if (excerpt) query.set('excerpt', excerpt);
  return `/council?${query}`;
}
export function researchStrategyPath(versionId: string, sectionId?: string): string {
  const query = new URLSearchParams({ sourceReportVersionId: versionId, draft: '1' });
  if (sectionId) query.set('sourceSectionId', sectionId);
  return `/paper?${query}`;
}
export function researchSectionsContent(sections: ResearchDocumentSection[]): string { return sections.map(s => `## ${s.title}\n\n${s.content}`).join('\n\n'); }
export function researchSectionChanges(before: ResearchDocumentSection[], after: ResearchDocumentSection[]): ResearchSectionDiff[] {
  return [...new Set([...before, ...after].map(s => s.id))].flatMap(id => {
    const a = before.find(s => s.id === id); const b = after.find(s => s.id === id);
    return a?.content === b?.content && a?.title === b?.title ? [] : [{ id, title: b?.title ?? a!.title,
      before: a?.content ?? null, after: b?.content ?? null, change: !a ? 'added' as const : !b ? 'removed' as const : 'changed' as const }];
  });
}
