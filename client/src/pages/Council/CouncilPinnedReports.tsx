import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CouncilSession } from '@shared/council.interface';
import { threadCopy } from './thread-copy';

export default function CouncilPinnedReports({ session }: { session: CouncilSession }) {
  const { i18n } = useTranslation();
  const copy = threadCopy(i18n.language);
  const [search, setSearch] = useState('');
  const zh = i18n.language.startsWith('zh');
  const matches = session.inheritedContext?.filter(message => !search.trim() || `${message.memberName} ${message.content}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? [];
  if (!session.references?.length && !session.parentSessionId) return null;
  return <div className="max-h-48 shrink-0 space-y-2 overflow-y-auto border-b border-border bg-muted/20 p-3 text-xs">
    {session.parentSessionId && <Link className="text-primary underline" to={`/council?session=${encodeURIComponent(session.parentSessionId)}`}>{copy.parent}</Link>}
    {!!session.references?.length && <p className="font-semibold">{copy.pinned}</p>}
    <div className="flex flex-wrap gap-2">{session.resolvedReferences?.map((ref, index) => <div key={`${ref.versionId}:${ref.sectionId ?? ''}:${index}`}
      className="min-w-0 max-w-full rounded-md border border-border bg-background p-2">
      <Link className="break-words text-primary underline" to={`/analysis/reports/${encodeURIComponent(ref.versionId)}${ref.sectionId ? `#${encodeURIComponent(ref.sectionId)}` : ''}`}>
        {ref.title} · v{ref.version}{ref.section ? ` · ${ref.section.title}` : ''}</Link>
      <p className="mt-1 text-muted-foreground">{copy.asOf}: {ref.dataAsOf ?? copy.unknown}</p>
      {ref.excerpt && <p className="mt-1 whitespace-pre-wrap break-words">{ref.excerpt}</p>}
      {(ref.status !== 'valid' || ref.sourceStatus !== 'available') && <p role="alert" className="text-destructive">{copy.invalid}</p>}
    </div>)}</div>
    {session.continuationSummary && <details><summary className="cursor-pointer">{zh ? '审阅后的续聊摘要（非事实证据）' : 'Reviewed continuation summary (not factual evidence)'}</summary><p className="mt-2 whitespace-pre-wrap">{session.continuationSummary.content}</p></details>}
    {!!session.inheritedContext?.length && <details><summary className="cursor-pointer">{copy.inherited} · {session.inheritedContext.length}</summary>
      <Input aria-label={zh ? '检索冻结原文' : 'Search frozen transcript'} placeholder={zh ? '检索冻结原文' : 'Search frozen transcript'} value={search} onChange={event => setSearch(event.target.value)} className="my-2" />
      <p>{matches.length} / {session.inheritedContext.length}</p>
      {matches.map(message => <p id={`frozen-message-${message.id}`} key={message.id} className="mt-2 whitespace-pre-wrap break-words"><strong>{message.memberName}: </strong>{message.content}</p>)}</details>}
  </div>;
}
