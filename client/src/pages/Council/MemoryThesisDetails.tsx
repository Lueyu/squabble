import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ResearchThesis, ThesisContent } from '@shared/research-memory.interface';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { MemoryCopy } from './memory-copy';
import { formatMemoryDate } from './memory-presentation';
import { MemoryEvidenceDetails } from './MemoryEvidenceDetails';

export function ThesisBoundaries({ content, expiresAt, copy, locale }: {
  content: ThesisContent; expiresAt?: string | null; copy: MemoryCopy; locale: string;
}) {
  return <div className="space-y-3 text-sm leading-6">
    <div><h4 className="font-medium">{copy.invalidationConditions}</h4>
      {content.invalidationConditions.length ? <ul className="list-inside list-disc">{content.invalidationConditions.map((line, index) => <li key={index}>{line}</li>)}</ul>
        : <p className="text-muted-foreground">{copy.missingBoundary}</p>}
      <p className="text-xs text-muted-foreground">{copy.boundary}: {content.boundaryOrigin === 'stated' ? copy.stated : content.boundaryOrigin === 'proposed' ? copy.proposed : copy.unknownBoundary}</p>
    </div>
    <div><h4 className="font-medium">{copy.assumptions}</h4>{content.assumptions.length
      ? <ul className="list-inside list-disc">{content.assumptions.map((line, index) => <li key={index}>{line}</li>)}</ul> : <p className="text-muted-foreground">{copy.unknown}</p>}</div>
    <dl className="grid gap-2 text-xs sm:grid-cols-2">
      {(['startAt', 'endAt', 'reviewAt'] as const).map(key => <div key={key}><dt className="text-muted-foreground">{copy[key]}</dt>
        <dd>{formatMemoryDate(content.horizon?.[key], locale, copy.unknown)}</dd></div>)}
      <div><dt className="text-muted-foreground">{copy.expiresAt}</dt><dd>{formatMemoryDate(expiresAt, locale, copy.unknown)}</dd></div>
    </dl>
  </div>;
}

export function MemoryThesisDetails({ thesis, copy, locale, onMonitors }: {
  thesis: ResearchThesis; copy: MemoryCopy; locale: string; onMonitors?: React.MouseEventHandler<HTMLButtonElement>;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!thesis.source || thesis.sourceStatus !== 'available') return <p className="text-sm text-muted-foreground">
    {thesis.sourceStatus === 'not-yet-known' ? copy.sourcePending : copy.sourceDeleted}</p>;
  const origin = thesis.provenance?.origin;
  return <div className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
    <p className="whitespace-pre-wrap font-medium leading-6">{thesis.claim}</p>
    <div className="flex flex-wrap gap-2 text-xs"><Badge variant={thesis.status === 'confirmed' ? 'secondary' : 'outline'}>{copy[thesis.status]}</Badge>
      <span>{copy.author}{locale === 'zh-CN' ? '：' : ': '}{origin === 'agent' ? copy.agentAuthor : origin === 'user' ? copy.userAuthor : copy.legacyAuthor}</span>
      <span>{copy.version} {thesis.version}</span>{thesis.excluded && <Badge variant="outline">{copy.excluded}</Badge>}</div>
    <p className="text-xs text-muted-foreground">{copy.freshnessLabel}: {thesis.freshness === 'unknown' || !thesis.freshness ? copy.unknownFreshness : copy[thesis.freshness]}</p>
    {!!thesis.flags.length && <div className="flex flex-wrap gap-1">{thesis.flags.map(flag => <Badge key={flag} variant="outline">{copy[flag]}</Badge>)}</div>}
    <ThesisBoundaries content={thesis} expiresAt={thesis.expiresAt} copy={copy} locale={locale} />
    <p className="text-xs text-muted-foreground">{thesis.status === 'candidate' ? copy.confirmHint : copy.eligibilityHint}</p>
    <Link className="inline-block text-sm text-primary underline" to={thesis.source.url}>{copy.source} · {copy.version} {thesis.source.reportVersion}</Link>
    <details onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer py-1 text-sm font-medium">{copy.details}</summary>
      <div className="space-y-3 pt-2 text-sm">
        {!!thesis.evidenceRelations?.length && <div><h4 className="font-medium">{copy.relation}</h4><ul className="list-inside list-disc">
          {thesis.evidenceRelations.map((relation, index) => <li key={index}>{copy[relation.role]} · {thesis.citations.find(item => item.evidenceId === relation.evidenceId)?.title ?? copy.unknown}</li>)}
        </ul></div>}
        {(['opposingEvidence', 'indicators'] as const).map(field => <div key={field}><h4 className="font-medium">{copy[field]}</h4>
          {thesis[field].length ? <ul className="list-inside list-disc">{thesis[field].map((line, index) => <li key={index}>{line}</li>)}</ul> : <p>{copy.none}</p>}</div>)}
        {expanded && <MemoryEvidenceDetails memoryId={thesis.memoryId} citations={thesis.citations} thesisId={thesis.id} version={thesis.version} copy={copy} locale={locale} />}
        <details className="text-xs"><summary className="cursor-pointer">{copy.technical}</summary><p>{thesis.id} · {thesis.memoryId}</p>
          <p>{copy.updated}: {formatMemoryDate(thesis.updatedAt, locale, copy.unknown)}</p>
          {thesis.provenance?.workflow && <p>{Object.values(thesis.provenance.workflow).join(' · ')}</p>}</details>
      </div>
    </details>
    <Button size="sm" variant="outline" onClick={onMonitors}>{copy.monitors}</Button>
  </div>;
}
