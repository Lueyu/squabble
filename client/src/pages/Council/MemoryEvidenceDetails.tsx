import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { MemoryCitation, ResearchEvidenceGraph } from '@shared/research-memory.interface';
import type { EvidenceSourceMetadata, TypedEvidenceFact } from '@shared/research-evidence.interface';
import { fetchResearchEvidence } from '@/api/research-memory';
import type { MemoryCopy } from './memory-copy';
import { formatMemoryDate, safeMemoryUrl } from './memory-presentation';

export function MemoryEvidenceDetails({ memoryId, citations, thesisId, version, copy, locale }: {
  memoryId: string; citations: MemoryCitation[]; thesisId: string; version: number; copy: MemoryCopy; locale: string;
}) {
  const query = useQuery({ queryKey: ['research-memory', 'evidence', memoryId], queryFn: () => fetchResearchEvidence(memoryId),
    retry: false, refetchInterval: 15_000 });
  if (query.isError) return <p role="alert">{copy.sourceUnavailable}</p>;
  if (!query.data) return <p role="status">{copy.loading}</p>;
  return <EvidenceGraph graph={query.data} citations={citations} thesisId={thesisId} version={version} copy={copy} locale={locale} />;
}

function Fact({ fact, copy, locale }: { fact: TypedEvidenceFact; copy: MemoryCopy; locale: string }) {
  return <dl className="grid min-w-0 gap-x-4 gap-y-1 rounded-md bg-muted/40 p-2 sm:grid-cols-2">
    {(['entity', 'metric', 'value', 'unit', 'currency', 'basis', 'actuality', 'periodStart', 'periodEnd', 'instant'] as const).map(key =>
      <div className="min-w-0" key={key}><dt className="text-muted-foreground">{copy[key]}</dt><dd className="[overflow-wrap:anywhere]">
        {key === 'actuality' ? fact.actuality ? copy[fact.actuality] : copy.unknown
          : key === 'periodStart' || key === 'periodEnd' || key === 'instant' ? formatMemoryDate(fact[key], locale, copy.unknown)
            : fact[key] ?? copy.unknown}</dd></div>)}
  </dl>;
}

function SourceContext({ source, title, copy, locale }: { source: EvidenceSourceMetadata; title: string; copy: MemoryCopy; locale: string }) {
  const url = safeMemoryUrl(source.sourceUrl);
  return <div className="space-y-1">
    <p>{source.provider ?? copy.unknown} · {source.verification === 'server-verified' ? copy.verified
      : source.verification === 'unverified' ? copy.unverifiedSource : copy.unknownSource}</p>
    <p>{copy.sourceOrigin}: {source.origin === 'provider' ? copy.providerOrigin : source.origin === 'agent' ? copy.agentAuthor : copy.legacyAuthor}</p>
    {url && <a className="text-primary underline" href={url} target="_blank" rel="noopener noreferrer">{title}</a>}
    <p>{copy.publishedAt}: {formatMemoryDate(source.publishedAt, locale, copy.unknown)}{source.publicationPrecision === 'day' && ` (${copy.dayPrecision})`}</p>
    <p>{copy.observedAt}: {formatMemoryDate(source.observedAt, locale, copy.unknown)} · {source.observationBasis === 'server'
      ? copy.serverObservation : source.observationBasis === 'legacy_fetched_at' ? copy.legacyObservation : copy.unknownObservation}</p>
    {source.revisionReason && <p>{copy.changeReason}: {source.revisionReason}</p>}
    <details><summary className="cursor-pointer">{copy.sourceRevision}</summary><p>{source.sourceRevision ?? copy.unknown}</p>
      {source.supersedesSourceRevision && <p>{copy.supersededRevision}: {source.supersedesSourceRevision}</p>}</details>
  </div>;
}

export function EvidenceGraph({ graph, citations, thesisId, version, copy, locale }: {
  graph: ResearchEvidenceGraph; citations: MemoryCitation[]; thesisId: string; version: number; copy: MemoryCopy; locale: string;
}) {
  return <div className="space-y-4 text-xs leading-5 [overflow-wrap:anywhere]">
    {!graph.evidence.length && !citations.length && <p>{copy.noEvidence}</p>}
    {citations.filter(citation => !graph.evidence.some(record => record.evidenceId === citation.evidenceId)).map(citation => {
      const url = safeMemoryUrl(citation.sourceUrl);
      return <div key={citation.evidenceId} className="space-y-1 rounded-md border p-2">
        {url ? <a className="text-primary underline" href={url} target="_blank" rel="noopener noreferrer">{citation.title}</a> : <p>{citation.title}</p>}
        <p>{copy.facts}: {copy.unknown}</p><p>{copy.legacyObservation}: {formatMemoryDate(citation.fetchedAt, locale, copy.unknown)}</p>
      </div>;
    })}
    {graph.evidence.map(record => {
      const citation = citations.find(item => item.evidenceId === record.evidenceId);
      const roles = graph.relations.filter(item => item.thesisId === thesisId && item.version === version && item.evidenceRecordId === record.id);
      return <section key={record.id} className="space-y-2 border-t pt-3">
        <h5 className="font-semibold">{citation?.title ?? copy.facts}</h5>
        <p>{roles.length ? [...new Set(roles.map(item => copy[item.role]))].join(' · ') : copy.noRelation}</p>
        <p>{copy.ingestedAt}: {formatMemoryDate(record.ingestedAt, locale, copy.unknown)}</p>
        {record.metadata.sources.map((source, index) => {
          return <div key={index} className="space-y-2 rounded-md border p-3">
            <SourceContext source={source} title={citation?.title ?? record.title ?? copy.source} copy={copy} locale={locale} />
            {!source.facts.length && <p>{copy.facts}: {copy.unknown}</p>}
            {source.facts.map((fact, factIndex) => <Fact key={factIndex} fact={fact} copy={copy} locale={locale} />)}
          </div>;
        })}
        <details><summary className="cursor-pointer">{copy.technical}</summary>
          <p>{record.evidenceId} · {record.id}</p><p>{record.reportId} · v{record.reportVersion} / r{record.reportRevision}</p></details>
      </section>;
    })}
    {!!graph.comparisons.length && <section className="space-y-2"><h5 className="font-semibold">{copy.comparisons}</h5>
      <p>{copy.comparisonHint}</p>
      {graph.comparisonsTruncated && <p>{copy.comparisonsTruncated}</p>}
      {graph.comparisons.map((comparison, index) => <details key={index}>
        <summary className="cursor-pointer">{copy.comparison[comparison.kind]}</summary>
        {(['left', 'right'] as const).map(side => {
          const record = [...graph.evidence, ...(graph.comparisonEvidence ?? [])].find(item => item.id === comparison[side]);
          const sourceIndex = comparison[`${side}SourceIndex`]; const factIndex = comparison[`${side}FactIndex`];
          const source = record?.metadata.sources[sourceIndex]; const fact = source?.facts[factIndex];
          return <div className="my-3 space-y-2 rounded-md border p-3" key={side}>
            <h6 className="font-medium">{record?.title ?? copy.facts}</h6>
            {record && <p>{copy.ingestedAt}: {formatMemoryDate(record.ingestedAt, locale, copy.unknown)}</p>}
            {source && <SourceContext source={source} title={record?.title ?? copy.source} copy={copy} locale={locale} />}
            {record?.source && <Link className="inline-block text-primary underline" to={record.source.url}>{copy.source} · {copy.version} {record.source.reportVersion}</Link>}
            {fact ? <Fact fact={fact} copy={copy} locale={locale} /> : <p>{copy.unknown}</p>}
            <details><summary>{copy.technical}</summary><p>{comparison[side]} / {sourceIndex} / {factIndex}</p></details></div>;
        })}
      </details>)}
    </section>}
  </div>;
}
