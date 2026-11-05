import { useResearchThesis, useResearchThesisVersions } from '@/hooks/use-research-memory';
import type { MemoryCopy } from './memory-copy';
import { formatMemoryDate, thesisListFields } from './memory-presentation';
import { ThesisBoundaries } from './MemoryThesisDetails';

export function MemoryVersions({ id, copy, locale }: { id: string; copy: MemoryCopy; locale: string }) {
  const live = useResearchThesis(id);
  const versions = useResearchThesisVersions(id);
  if (live.error || live.data?.sourceStatus === 'source-deleted') return <p role="alert">{copy.sourceDeleted}</p>;
  if (live.data?.sourceStatus === 'not-yet-known') return <p>{copy.sourcePending}</p>;
  if (versions.error) return <p role="alert">{copy.failed}</p>;
  if (!live.data || !versions.data) return <p role="status">{copy.loading}</p>;
  return <div className="space-y-3 [overflow-wrap:anywhere]">
    {!versions.data.length && <p>{copy.versionsEmpty}</p>}
    {versions.data.map(version => <details key={version.version} className="space-y-3 border-t pt-2">
      <summary className="cursor-pointer text-sm">{copy.version} {version.version} · {copy[version.status]} · {formatMemoryDate(version.createdAt, locale, copy.unknown)}</summary>
      <p className="text-xs text-muted-foreground">{version.action === 'candidate' ? copy.candidate : version.action === 'accept' ? copy.accepted : copy[`${version.action}Action`]}</p>
      <p className="whitespace-pre-wrap text-sm">{copy.changeReason}: {version.changeReason ?? copy.none}</p>
      {version.content ? <div className="space-y-3 text-sm"><p className="whitespace-pre-wrap font-medium">{version.content.claim}</p>
        <p>{copy.author}: {version.content.provenance?.origin === 'agent' ? copy.agentAuthor : version.content.provenance?.origin === 'user' ? copy.userAuthor : copy.legacyAuthor}</p>
        <ThesisBoundaries content={version.content} expiresAt={version.expiresAt} copy={copy} locale={locale} />
        {thesisListFields.filter(field => field !== 'assumptions' && field !== 'invalidationConditions').map(field => <div key={field}><strong>{copy[field]}</strong>
          <ul className="list-inside list-disc">{version.content![field].map((line, index) => <li key={index}>{line}</li>)}</ul></div>)}
        {!!version.content.evidenceRelations?.length && <details><summary>{copy.relation}</summary>{version.content.evidenceRelations.map((relation, index) =>
          <p key={index}>{copy[relation.role]} · {relation.evidenceId}</p>)}</details>}
        {!!version.content.monitorConditions?.length && <details><summary>{copy.monitors}</summary>{version.content.monitorConditions.map((condition, index) => <div key={index} className="mt-2">
          <p>{copy.metrics[condition.metric]} {({ lt: '<', lte: '≤', gt: '>', gte: '≥' })[condition.operator]} {condition.threshold} {copy.units[condition.unit]}</p><p>{condition.rationale}</p>
          <p>{formatMemoryDate(condition.validFrom, locale, copy.unknown)} – {formatMemoryDate(condition.validUntil, locale, copy.unknown)}</p></div>)}</details>}
        <details><summary>{copy.technical}</summary>{version.content.supportingEvidence.map(ref => <p key={ref.evidenceId}>{copy.supportingEvidence}: {ref.evidenceId}</p>)}</details>
        {version.content.supersedes && <div><p>{copy.replacementClaimed}</p><p>{version.content.supersedes.reason}</p>
          <details><summary>{copy.technical}</summary>{version.content.supersedes.thesisId} v{version.content.supersedes.version}</details></div>}
      </div> : <p>{version.sourceStatus === 'not-yet-known' ? copy.sourcePending : copy.sourceDeleted}</p>}
    </details>)}
  </div>;
}
