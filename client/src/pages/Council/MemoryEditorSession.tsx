import { useState } from 'react';
import type { ResearchThesis, UpdateResearchThesis } from '@shared/research-memory.interface';
import { useResearchMemoryById, useResearchThesis } from '@/hooks/use-research-memory';
import type { MemoryCopy } from './memory-copy';
import { memoryAccessUnavailable, memoryErrorCode, memoryErrorText } from './memory-presentation';
import { MemoryThesisEditor } from './MemoryThesisEditor';

export function MemoryEditorSession({ snapshot, mode, copy, busy, error, accessError, unavailable, onCancel, onReload, onSave }: {
  snapshot: ResearchThesis; mode: 'edit' | 'confirm'; copy: MemoryCopy; busy: boolean; error?: unknown;
  accessError?: unknown;
  unavailable?: ResearchThesis['sourceStatus'];
  onCancel: () => void; onReload: (thesis: ResearchThesis) => void; onSave: (input: UpdateResearchThesis) => void;
}) {
  const [reloading, setReloading] = useState(false);
  const live = useResearchThesis(snapshot.id);
  // A valid active thesis can be older than the history cap. Fetch all of its report's citations directly.
  const memory = useResearchMemoryById(snapshot.memoryId);
  const queryError = live.error ?? memory.error ?? accessError;
  if ([live.error, memory.error, accessError, error].some(memoryAccessUnavailable)) return <p role="alert">{copy.sourceUnavailable}</p>;
  if (unavailable && unavailable !== 'available' || live.data && live.data.sourceStatus !== 'available' || memory.data && memory.data.sourceStatus !== 'available') return <p role="alert">
    {unavailable === 'not-yet-known' || live.data?.sourceStatus === 'not-yet-known' || memory.data?.sourceStatus === 'not-yet-known' ? copy.sourcePending : copy.sourceDeleted}</p>;
  if (!live.data || !memory.data) return <p role={queryError ? 'alert' : 'status'}>{queryError ? memoryErrorText(queryError, copy) : copy.loading}</p>;
  const reload = async () => {
    setReloading(true);
    try {
      const latest = await live.refetch();
      if (!latest.isError && latest.data?.sourceStatus === 'available') onReload(latest.data);
    } finally { setReloading(false); }
  };
  return <MemoryThesisEditor key={`${snapshot.id}:${snapshot.version}:${mode}`} thesis={snapshot} mode={mode} citations={memory.data.citations} copy={copy} busy={busy || reloading || Boolean(queryError)}
    conflict={live.data.version !== snapshot.version || memoryErrorCode(error).includes('VERSION_CONFLICT')}
    error={error || queryError ? memoryErrorText(error ?? queryError, copy) : ''} onCancel={onCancel} onReload={() => { void reload(); }} onSave={onSave} />;
}
