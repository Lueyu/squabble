import type { ResearchThesis } from '@shared/research-memory.interface';
import { useResearchThesis } from '@/hooks/use-research-memory';
import type { MemoryCopy } from './memory-copy';
import { memoryAccessUnavailable, memoryErrorText } from './memory-presentation';
import { MemoryMonitors } from './MemoryMonitors';

/** Lives in the panel dialog, outside cards that move between active and inactive groups. */
export function MemoryMonitorSession({ snapshot, listed, listingError, copy, locale }: {
  snapshot: ResearchThesis; listed?: ResearchThesis; listingError?: unknown; copy: MemoryCopy; locale: string;
}) {
  const live = useResearchThesis(snapshot.id);
  if (memoryAccessUnavailable(listingError) || memoryAccessUnavailable(live.error)) return <p role="alert">{copy.sourceUnavailable}</p>;
  const unavailable = [listed, live.data].find(thesis => thesis && thesis.sourceStatus !== 'available');
  if (unavailable) return <p role="alert">{unavailable.sourceStatus === 'not-yet-known' ? copy.sourcePending : copy.sourceDeleted}</p>;
  if (!live.data) return <p role={live.error ? 'alert' : 'status'}>{live.error ? memoryErrorText(live.error, copy) : copy.loading}</p>;
  const latest = listed && listed.version > live.data.version ? listed : live.data;
  return <MemoryMonitors thesis={latest} copy={copy} locale={locale} blocked={Boolean(listingError || live.error)} />;
}
