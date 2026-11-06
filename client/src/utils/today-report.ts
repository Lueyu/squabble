import type { CurrentResearchView, TodayView } from '@shared/simple-experience.interface';
import { readableResearchText } from './research-experience';

/** Compare complete publications; task activity stays on TodayView.analysis. */
export function latestTodayReport(data: Pick<TodayView, 'analysis' | 'initialAnalysis' | 'discussionAnalysis' | 'reportHistory'>): CurrentResearchView {
  // Formatting a newer task can overlay pending on the retained publication.
  // Recover only that exact version: history may also contain partial discussions.
  const retained = data.analysis.readingState === 'pending'
    ? data.reportHistory?.find(view => view.documentId === data.analysis.documentId && view.readingState === 'ready')
    : undefined;
  const candidates = [data.analysis, retained, data.discussionAnalysis, data.initialAnalysis]
    .filter((view): view is CurrentResearchView => Boolean(view?.documentId)
      && view?.researchLevel !== 'facts_only' && view?.readingState !== 'pending'
      && Boolean(readableResearchText(view?.content) || readableResearchText(view?.summary)));
  return candidates.reduce<CurrentResearchView | undefined>((latest, view) => {
    const published = Date.parse(view.updatedAt ?? '') || 0;
    const previous = Date.parse(latest?.updatedAt ?? '') || 0;
    return !latest || published > previous ? view : latest;
  }, undefined) ?? data.analysis;
}
