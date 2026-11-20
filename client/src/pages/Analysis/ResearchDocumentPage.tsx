import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';
import { ArrowLeft, GitBranch, MessageSquare, Pencil, Check, LoaderCircle } from 'lucide-react';
import type { ResearchDocumentSection, ResearchDocumentVersion, ResearchDocumentView, ResearchInputSnapshot, ResearchRevisionDraft, ResearchSectionDiff } from '@shared/research-document.interface';
import { adoptResearchVersion, createResearchRevision, fetchResearchDocument, forkResearchVersion, publishResearchRevision, revokeResearchVersion, updateResearchRevision } from '@/api/research-documents';
import { researchDiscussionPath, researchSectionChanges, researchSectionsContent, researchStrategyPath } from '@/utils/research-documents';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import PortfolioDailyFactsPanel from '@/components/MultiAgent/PortfolioDailyFactsPanel';
import type { PortfolioDailyFacts } from '@shared/portfolio-report.interface';
import { useSimpleExperience } from '@/hooks/use-simple-experience';
import SimpleReportReader from './SimpleReportReader';
import { safeReturnPath } from '@/features/navigation/workspace-navigation';

interface Editor { draft: ResearchRevisionDraft | null; title: string; reason: string; sections: ResearchDocumentSection[] }
function Diff({ changes, en }: { changes: ResearchSectionDiff[]; en: boolean }) {
  return <div className="space-y-3">{changes.length ? changes.map(change => <div key={change.id} className="rounded-lg border p-3">
    <h4 className="mb-2 font-medium">{change.title}</h4>
    <div className="grid gap-3 md:grid-cols-2"><div className="min-w-0 rounded-md bg-destructive/5 p-3"><strong className="text-xs">{en ? 'Previous' : '修改前'}</strong><p className="mt-1 whitespace-pre-wrap break-words text-sm">{change.before ?? '—'}</p></div>
      <div className="min-w-0 rounded-md bg-primary/5 p-3"><strong className="text-xs">{en ? 'Proposed' : '修改后'}</strong><p className="mt-1 whitespace-pre-wrap break-words text-sm">{change.after ?? '—'}</p></div></div>
  </div>) : <p className="text-sm text-muted-foreground">{en ? 'No section changes.' : '章节内容尚无变化。'}</p>}</div>;
}

function linkedStrategies(report: ResearchDocumentView, returnTo: string, en: boolean) {
  return report.strategyUses?.map(use => {
    const params = new URLSearchParams({
      strategyId: use.strategyId,
      sourceReportVersionId: use.versionId,
      returnTo,
    });
    const version = report.versions?.find(item => item.id === use.versionId);
    return (
      <Link key={`${use.strategyId}:${use.versionId}`} className="block break-words text-primary underline" to={`/paper?${params}`}>
        {en ? 'Linked strategy' : '关联策略'}{version && ` · v${version.version}`}
      </Link>
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown) {
  return isRecord(value) ? value : undefined;
}

function records(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function currencies(value: unknown) {
  return [...new Set(records(value).flatMap(item => text(item.currency) ?? []))].join(', ');
}

interface FrozenSource {
  name?: string;
  url?: string;
  fetchedAt?: string;
  metadata?: { publishedAt?: string; observedAt?: string; currencies: string };
}

function frozenSources(snapshot: ResearchInputSnapshot | null): FrozenSource[] {
  return records(snapshot?.evidence).flatMap((item): FrozenSource[] => {
    const sources = records(record(item.metadata)?.sources);
    if (sources.length) return sources.map(source => ({
      name: text(source.provider), url: text(source.sourceUrl),
      metadata: {
        publishedAt: text(source.publishedAt),
        observedAt: text(source.observedAt),
        currencies: currencies(source.facts),
      },
    }));
    const name = text(item.sourceName);
    const url = text(item.sourceUrl);
    const fetchedAt = text(item.fetchedAt);
    return name || url || fetchedAt ? [{ name, url, fetchedAt }] : [];
  });
}

function FrozenInputs({ version: { snapshot, source }, en, showRaw = true }: {
  version: Pick<ResearchDocumentVersion, 'snapshot' | 'source'>;
  en: boolean;
  showRaw?: boolean;
}) {
  const label = (english: string, chinese: string) => en ? english : chinese;
  const unknown = label('Unknown', '未知');
  const daily = record(snapshot?.dailyFacts);
  const commission = record(record(snapshot?.teamExecutionContext)?.inputSnapshot);
  const timeRows = [
    { title: label('Captured at', '采集时间'), value: text(snapshot?.capturedAt) },
    { title: label('Ledger captured at', '账本采集时间'), value: text(daily?.capturedAt) },
    { title: label('Team inputs captured at', '团队输入采集时间'), value: text(commission?.capturedAt) },
    { title: label('Overall daily inputs read at', '总体日报输入读取时间'), value: text(record(snapshot?.overallDaily)?.readAt) },
  ].filter(row => row.value);
  const currencyRows = [
    { title: label('Holding currencies', '持仓币种'), value: currencies(snapshot?.holdings ?? commission?.positions) },
    { title: label('Ledger currencies', '账本币种'), value: currencies(daily?.byCurrency) },
    { title: label('Return calculation currency', '收益计算币种'), value: text(record(daily?.returnBasis)?.currency) },
  ].filter(row => row.value);
  const sources = frozenSources(snapshot);
  const references = new Set([
    ...records(snapshot?.references), ...records(snapshot?.reportReferences),
  ].flatMap(ref => text(ref.versionId) ?? []));
  const sourceType = text(source?.type);
  const sourceId = text(source?.id);
  return (
    <section className="min-w-0 space-y-3 rounded-xl border p-4 text-sm">
      <h2 className="font-semibold">{label('Frozen inputs', '固定输入快照')}</h2>
      <dl className="space-y-2 break-words">
        {(timeRows.length ? timeRows : [{ title: label('Captured at', '采集时间'), value: unknown }]).map(row => (
          <div key={row.title}><dt className="text-muted-foreground">{row.title}</dt><dd>{row.value}</dd></div>
        ))}
        {!currencyRows.length && !sources.some(source => source.metadata?.currencies) && (
          <div><dt className="text-muted-foreground">{label('Currencies', '币种')}</dt><dd>{unknown}</dd></div>
        )}
        {currencyRows.map(row => (
          <div key={row.title}><dt className="text-muted-foreground">{row.title}</dt><dd>{row.value}</dd></div>
        ))}
        <div>
          <dt className="text-muted-foreground">{label('Report source', '报告来源')}</dt>
          <dd>{sourceType && sourceId ? `${sourceType} / ${sourceId}` : unknown}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{label('Input sources', '输入来源')}</dt>
          <dd>{sources.length || references.size ? (
            <ul className="mt-1 space-y-2">
              {sources.map(({ name, url, fetchedAt, metadata }, index) => (
                <li key={index}>
                  <p className="break-words">{name ?? url ?? unknown}</p>
                  {name && url && <p className="break-all text-xs text-muted-foreground">{url}</p>}
                  {metadata ? (
                    <dl className="text-xs">
                      <div><dt className="inline text-muted-foreground">{label('Published', '发布时间')} </dt><dd className="inline">{metadata.publishedAt ?? unknown}</dd></div>
                      <div><dt className="inline text-muted-foreground">{label('Observed', '观测时间')} </dt><dd className="inline">{metadata.observedAt ?? unknown}</dd></div>
                      <div><dt className="inline text-muted-foreground">{label('Evidence currencies', '证据币种')} </dt><dd className="inline">{metadata.currencies || unknown}</dd></div>
                    </dl>
                  ) : fetchedAt && <p className="text-xs">{label('Fetched', '获取时间')} {fetchedAt}</p>}
                </li>
              ))}
              {[...references].map(id => <li key={id}>{label('Report version', '报告版本')} {id}</li>)}
            </ul>
          ) : unknown}</dd>
        </div>
      </dl>
      {showRaw && snapshot != null && (
        <details>
          <summary className="cursor-pointer font-medium">{label('View raw snapshot', '查看原始快照')}</summary>
          <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(snapshot, null, 2)}</pre>
        </details>
      )}
    </section>
  );
}

export default function ResearchDocumentPage() {
  const { versionId = '' } = useParams<{ versionId: string }>();
  const { enabled } = useSimpleExperience();
  if (enabled) return <SimpleResearchDocument key={versionId} versionId={versionId} />;
  // A route change remounts editing state so a draft cannot accidentally publish against another version.
  return <ResearchDocumentReader key={versionId} versionId={versionId} />;
}

function SimpleResearchDocument({ versionId }: { versionId: string }) {
  const { i18n } = useTranslation();
  const location = useLocation();
  const reportPath = location.pathname + location.search + location.hash;
  const { data } = useQuery({ queryKey: ['research-document', versionId], queryFn: () => fetchResearchDocument(versionId), enabled: Boolean(versionId) });
  const en = i18n.language.startsWith('en');
  return (
    <>
      <SimpleReportReader versionId={versionId} />
      {data && (
        <div className="mx-auto mb-6 max-w-5xl space-y-4 px-4">
          <FrozenInputs version={data.version} en={en} showRaw={false} />
          {Boolean(data.strategyUses?.length) && <aside className="text-sm">{linkedStrategies(data, reportPath, en)}</aside>}
        </div>
      )}
    </>
  );
}
function ResearchDocumentReader({ versionId }: { versionId: string }) {
  const { i18n } = useTranslation(); const en = Boolean(i18n.resolvedLanguage?.startsWith('en'));
  const label = (english: string, chinese: string) => en ? english : chinese;
  const navigate = useNavigate();
  const query = useQuery({ queryKey: ['research-document', versionId], queryFn: () => fetchResearchDocument(versionId), enabled: Boolean(versionId) });
  const [editor, setEditor] = useState<Editor | null>(null); const [busy, setBusy] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams(); const selectedDraft = searchParams.get('draftId');
  const location = useLocation();
  const returnTo = safeReturnPath(location.state?.returnTo) ?? safeReturnPath(searchParams.get('returnTo')) ?? '/analysis';
  useEffect(() => {
    const draft = query.data?.drafts.find(item => item.id === selectedDraft);
    if (draft && editor?.draft?.id !== draft.id) setEditor({ draft, title: draft.title, reason: draft.changeReason, sections: (draft.sections ?? []).map(section => ({ ...section })) });
  }, [selectedDraft, query.data?.drafts, editor?.draft?.id]);
  const [revocation, setRevocation] = useState(''); const [showRevoke, setShowRevoke] = useState(false);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    try { await work(); await query.refetch(); }
    catch (error) {
      const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '';
      toast.error(message.includes('CONFLICT') || message.includes('BASE_CHANGED')
        ? label('The base version changed. Refresh or create a branch before publishing.', '基准版本已变化，请刷新或创建分支后再发布。')
        : label('The action could not be saved. Please retry.', '操作未能保存，请重试。'));
    } finally { setBusy(false); }
  }
  if (query.isPending) return <div role="status" className="flex items-center gap-2 p-8"><LoaderCircle className="size-4 animate-spin" />{label('Loading report…', '正在加载报告…')}</div>;
  if (query.isError || !query.data) return <div role="alert" className="space-y-4 p-8"><p>{label('This report is unavailable or belongs to another workspace.', '报告不存在或不属于当前账户。')}</p><Button onClick={() => void query.refetch()}>{label('Retry', '重试')}</Button></div>;
  const { version, document, versions = [], drafts = [], diff = [] } = query.data;
  const adoptions = query.data.adoptions ?? [];
  const strategyVersionIds = document.strategyVersionIds ?? [];
  const invalid = version.status === 'revoked' || version.sourceStatus === 'missing';
  const versionLabel = (id: string | null) => id ? `v${versions.find(v => v.id === id)?.version ?? '?'}` : label('None', '未设置');
  function startEdit(draft?: ResearchRevisionDraft) {
    setSearchParams({});
    setEditor({ draft: draft ?? null, title: draft?.title ?? version.title, reason: draft?.changeReason ?? '',
      sections: (draft?.sections ?? version.sections).map(s => ({ ...s })) });
  }
  async function saveDraft(): Promise<ResearchRevisionDraft> {
    if (!editor) throw new Error('No revision');
    const input = { title: editor.title, content: researchSectionsContent(editor.sections), sections: editor.sections, changeReason: editor.reason };
    const saved = editor.draft ? await updateResearchRevision(editor.draft.id, input, editor.draft.revision) : await createResearchRevision(version.id, input);
    setEditor({ ...editor, draft: saved }); return saved;
  }
  const editChanges = editor ? researchSectionChanges(version.sections, editor.sections) : [];
  return <div className="mx-auto max-w-6xl space-y-6 px-3 py-5 pb-16 sm:px-6">
    <Button asChild size="sm" variant="ghost"><Link to={returnTo}><ArrowLeft />{label('Report history', '报告历史')}</Link></Button>
    <header className="space-y-3"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{version.kind}</Badge><Badge>v{version.version}</Badge>
      {document.adoptedVersionId === version.id && <Badge variant="secondary">{label('Adopted', '已采纳')}</Badge>}
      {invalid && <Badge variant="destructive">{version.status === 'revoked' ? label('Revoked', '已撤销') : label('Source unavailable', '来源已不可用')}</Badge>}</div>
      <h1 className="break-words font-serif text-3xl font-semibold">{version.title}</h1>
      <p className="text-sm text-muted-foreground">{label('Saved versions remain unchanged. Adopting research does not publish a trading strategy.', '固定版本保留原文。采纳研究结论不会自动发布交易策略。')}</p>
      <dl className="grid gap-2 rounded-xl border bg-muted/20 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div><dt className="text-muted-foreground">{label('Latest generated', '最新生成')}</dt><dd>{document.latestVersionId && <Link className="underline" to={`/analysis/reports/${document.latestVersionId}`}>{versionLabel(document.latestVersionId)}</Link>}</dd></div>
        <div><dt className="text-muted-foreground">{label('Current adopted', '当前采纳')}</dt><dd>{document.adoptedVersionId ? <Link className="underline" to={`/analysis/reports/${document.adoptedVersionId}`}>{versionLabel(document.adoptedVersionId)}</Link> : label('None', '未设置')}</dd></div>
        <div><dt className="text-muted-foreground">{label('Used by strategies', '策略使用版本')}</dt><dd>{strategyVersionIds.length ? strategyVersionIds.map(id => <Link key={id} className="mr-2 underline" to={`/analysis/reports/${id}`}>{versionLabel(id)}</Link>) : label('None', '未使用')}</dd></div>
        <div><dt className="text-muted-foreground">{label('Data as of', '数据截至')}</dt><dd>{version.dataAsOf ?? label('Unknown', '未知')}</dd></div>
        <div><dt className="text-muted-foreground">{label('First available', '首次可用')}</dt><dd>{version.availableAt ?? label('Unknown', '未知')}</dd></div>
        <div><dt className="text-muted-foreground">{label('Version saved', '版本保存')}</dt><dd>{new Date(version.createdAt).toLocaleString()}</dd></div>
      </dl>
      {invalid && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">{label('The saved text remains readable. This version cannot be adopted or used for a new strategy until its evidence is repaired.', '原文仍可查阅。修复证据之前，此版本不能采纳或用于新策略。')}</p>}
    </header>
    <div className="flex flex-wrap gap-2">
      <Button disabled={invalid} onClick={() => navigate(researchDiscussionPath(version))}><MessageSquare />{label('Discuss report', '讨论报告')}</Button>
      <Button variant="outline" disabled={busy || invalid} onClick={() => startEdit()}><Pencil />{label('Revise draft', '起草修订')}</Button>
      <Button variant="outline" disabled={busy || invalid || document.adoptedVersionId === version.id} onClick={() => void action(async () => { await adoptResearchVersion(version.id, document.adoptedVersionId); })}><Check />{label('Adopt this version', '采纳此版本')}</Button>
      <Button variant="outline" disabled={busy || invalid} onClick={() => void action(async () => { const fork = await forkResearchVersion(version.id, `${version.title} · ${label('Branch', '分支')}`); navigate(`/analysis/reports/${fork.id}`); })}><GitBranch />{label('Create branch', '创建分支')}</Button>
      <Button variant="secondary" disabled={invalid} onClick={() => navigate(researchStrategyPath(version.id))}>{label('Draft strategy', '起草策略')}</Button>
    </div>
    <nav aria-label={label('Report history', '报告历史')} className="flex flex-wrap gap-2 rounded-lg border p-3">{versions.map(item => <Button key={item.id} size="sm" variant={item.id === version.id ? 'default' : 'ghost'} asChild><Link to={`/analysis/reports/${item.id}`}>v{item.version} · {new Date(item.createdAt).toLocaleDateString()}</Link></Button>)}</nav>
    {version.snapshot?.dailyFacts != null && <PortfolioDailyFactsPanel facts={version.snapshot.dailyFacts as PortfolioDailyFacts} />}
    {drafts.length > 0 && <div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{label('Saved drafts', '已保存草稿')}</strong>{drafts.map(draft => <Button key={draft.id} size="sm" variant="outline" onClick={() => navigate(`/analysis/reports/${draft.parentVersionId}?draftId=${draft.id}`)}>{draft.title} · r{draft.revision}</Button>)}</div>}
    {editor && <section className="space-y-4 rounded-xl border border-primary/30 bg-primary/5 p-4" aria-label={label('Revision editor', '修订编辑器')}>
      <h2 className="text-lg font-semibold">{label('Revision draft', '修订草稿')}</h2>
      <label className="block space-y-1 text-sm"><span>{label('Title', '标题')}</span><Input value={editor.title} maxLength={300} onChange={event => setEditor({ ...editor, title: event.target.value })} /></label>
      <label className="block space-y-1 text-sm"><span>{label('Reason for change', '修订原因')}</span><Textarea value={editor.reason} maxLength={3000} onChange={event => setEditor({ ...editor, reason: event.target.value })} /></label>
      {editor.sections.map((section, index) => <label key={section.id} className="block space-y-1 text-sm"><span>{section.title}</span><Textarea className="min-h-28" value={section.content} onChange={event => setEditor({ ...editor, sections: editor.sections.map((s, i) => i === index ? { ...s, content: event.target.value } : s) })} /></label>)}
      <details><summary className="cursor-pointer text-sm font-medium">{label('Review section changes', '查看章节差异')} ({editChanges.length})</summary><div className="mt-3"><Diff changes={editChanges} en={en} /></div></details>
      <div className="flex flex-wrap gap-2"><Button disabled={busy || !editor.reason.trim() || !editor.title.trim()} onClick={() => void action(async () => { await saveDraft(); toast.success(label('Draft saved', '草稿已保存')); })}>{label('Save draft', '保存草稿')}</Button>
        <Button variant="secondary" disabled={busy || !editor.reason.trim() || !editor.title.trim()} onClick={() => void action(async () => { const saved = await saveDraft(); const published = await publishResearchRevision(saved.id, saved.revision); setEditor(null); navigate(`/analysis/reports/${published.id}`); })}>{label('Save as new version', '保存为新版本')}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => { setSearchParams({}); setEditor(null); }}>{label('Close editor', '关闭编辑')}</Button></div>
    </section>}
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_240px]"><article className="min-w-0 space-y-6">{version.sections.map(section => <section id={section.id} key={section.id} className="scroll-mt-20 rounded-xl border p-4 sm:p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="font-serif text-xl font-semibold">{section.title}</h2><div className="flex flex-wrap gap-1"><Button size="sm" variant="ghost" disabled={invalid} onClick={() => {
        const selection = window.getSelection()?.toString().trim() ?? '';
        navigate(researchDiscussionPath(version, section.id, selection && selection.length <= 6000 && section.content.includes(selection) ? selection : undefined));
      }}>{label('Quote and discuss', '引用讨论')}</Button><Button size="sm" variant="ghost" disabled={invalid} onClick={() => navigate(researchStrategyPath(version.id, section.id))}>{label('Draft strategy from section', '从本节起草策略')}</Button></div></div>
      <div className="prose prose-sm max-w-none break-words dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{section.content}</ReactMarkdown></div>
    </section>)}</article>
      <aside className="space-y-4 text-sm"><div className="rounded-xl border p-4"><h2 className="mb-3 font-semibold">{label('Sections', '章节')}</h2><div className="space-y-2">{version.sections.map(section => <a key={section.id} className="block break-words text-muted-foreground hover:text-primary" href={`#${section.id}`}>{section.title}</a>)}</div></div>
        <FrozenInputs version={version} en={en} />
        {(version.parentVersionId || Boolean(query.data.strategyUses?.length)) && <div className="space-y-2 rounded-xl border p-4"><h2 className="font-semibold">{label('Provenance', '来源记录')}</h2>
          {version.parentVersionId && <Link className="block underline" to={`/analysis/reports/${version.parentVersionId}`}>{label('Open parent version', '打开父版本')}</Link>}
          {linkedStrategies(query.data, location.pathname + location.search + location.hash, en)}
        </div>}
      </aside></div>
    {diff.length > 0 && <details className="rounded-xl border p-4"><summary className="cursor-pointer font-semibold">{label('Changes from parent version', '相对父版本的差异')}</summary><div className="mt-4"><Diff changes={diff} en={en} /></div></details>}
    {version.changeReason && <p className="text-sm text-muted-foreground">{label('Change reason: ', '修订原因：')}{version.changeReason}</p>}
    {adoptions.length > 0 && <details className="rounded-xl border p-4"><summary className="cursor-pointer font-semibold">{label('Adoption history', '采纳历史')}</summary><ol className="mt-3 space-y-2 text-sm">{adoptions.map(event => <li key={event.id}><Link className="underline" to={`/analysis/reports/${event.versionId}`}>{versionLabel(event.versionId)}</Link> · {new Date(event.createdAt).toLocaleString()} · {label('Adopted by you', '由你采纳')}{event.previousVersionId && <> · {label('Previously ', '此前 ')}<Link className="underline" to={`/analysis/reports/${event.previousVersionId}`}>{versionLabel(event.previousVersionId)}</Link></>}</li>)}</ol></details>}
    {version.status !== 'revoked' && <div className="space-y-3 border-t pt-4"><Button size="sm" variant="ghost" onClick={() => setShowRevoke(!showRevoke)}>{label('Evidence withdrawn / invalidate version', '证据撤回 / 作废此版本')}</Button>
      {showRevoke && <div className="flex flex-wrap gap-2"><Input aria-label={label('Reason for invalidation', '作废原因')} className="max-w-lg" placeholder={label('Reason for invalidation', '请填写作废原因')} value={revocation} onChange={event => setRevocation(event.target.value)} /><Button variant="destructive" disabled={busy || !revocation.trim()} onClick={() => void action(async () => { await revokeResearchVersion(version.id, revocation); setShowRevoke(false); })}>{label('Invalidate version', '作废版本')}</Button></div>}
    </div>}
  </div>;
}
