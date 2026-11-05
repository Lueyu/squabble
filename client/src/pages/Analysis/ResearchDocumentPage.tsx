import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';
import { ArrowLeft, GitBranch, MessageSquare, Pencil, Check, LoaderCircle } from 'lucide-react';
import type { ResearchDocumentSection, ResearchRevisionDraft, ResearchSectionDiff } from '@shared/research-document.interface';
import { adoptResearchVersion, createResearchRevision, fetchResearchDocument, forkResearchVersion, publishResearchRevision, revokeResearchVersion, updateResearchRevision } from '@/api/research-documents';
import { researchDiscussionPath, researchSectionChanges, researchSectionsContent, researchStrategyPath } from '@/utils/research-documents';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import PortfolioDailyFactsPanel from '@/components/MultiAgent/PortfolioDailyFactsPanel';
import type { PortfolioDailyFacts } from '@shared/portfolio-report.interface';

interface Editor { draft: ResearchRevisionDraft | null; title: string; reason: string; sections: ResearchDocumentSection[] }
function Diff({ changes, en }: { changes: ResearchSectionDiff[]; en: boolean }) {
  return <div className="space-y-3">{changes.length ? changes.map(change => <div key={change.id} className="rounded-lg border p-3">
    <h4 className="mb-2 font-medium">{change.title}</h4>
    <div className="grid gap-3 md:grid-cols-2"><div className="min-w-0 rounded-md bg-destructive/5 p-3"><strong className="text-xs">{en ? 'Previous' : '修改前'}</strong><p className="mt-1 whitespace-pre-wrap break-words text-sm">{change.before ?? '—'}</p></div>
      <div className="min-w-0 rounded-md bg-primary/5 p-3"><strong className="text-xs">{en ? 'Proposed' : '修改后'}</strong><p className="mt-1 whitespace-pre-wrap break-words text-sm">{change.after ?? '—'}</p></div></div>
  </div>) : <p className="text-sm text-muted-foreground">{en ? 'No section changes.' : '章节内容尚无变化。'}</p>}</div>;
}

export default function ResearchDocumentPage() {
  const { versionId = '' } = useParams<{ versionId: string }>();
  // A route change remounts editing state so a draft cannot accidentally publish against another version.
  return <ResearchDocumentReader key={versionId} versionId={versionId} />;
}
function ResearchDocumentReader({ versionId }: { versionId: string }) {
  const { i18n } = useTranslation(); const en = Boolean(i18n.resolvedLanguage?.startsWith('en'));
  const label = (english: string, chinese: string) => en ? english : chinese;
  const navigate = useNavigate();
  const query = useQuery({ queryKey: ['research-document', versionId], queryFn: () => fetchResearchDocument(versionId), enabled: Boolean(versionId) });
  const [editor, setEditor] = useState<Editor | null>(null); const [busy, setBusy] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams(); const selectedDraft = searchParams.get('draftId');
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
  const { version, document, versions = [], drafts = [], diff = [], strategyUses = [] } = query.data;
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
    <Button asChild size="sm" variant="ghost"><Link to="/analysis"><ArrowLeft />{label('Analysis', '分析报告')}</Link></Button>
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
        <details className="rounded-xl border p-4"><summary className="cursor-pointer font-semibold">{label('Frozen inputs', '固定输入快照')}</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{version.snapshot ? JSON.stringify(version.snapshot, null, 2) : label('Unknown — no historical snapshot was supplied.', '未知：历史报告未提供输入快照。')}</pre></details>
        <div className="space-y-2 rounded-xl border p-4"><h2 className="font-semibold">{label('Provenance', '来源记录')}</h2><p className="break-all text-xs text-muted-foreground">{version.source ? `${version.source.type} / ${version.source.id}` : label('Research revision', '研究修订')}</p>
          {version.parentVersionId && <Link className="block underline" to={`/analysis/reports/${version.parentVersionId}`}>{label('Open parent version', '打开父版本')}</Link>}
          {strategyUses.map(use => <Link key={`${use.strategyId}:${use.versionId}`} className="block underline" to={`/paper?strategyId=${use.strategyId}&sourceReportVersionId=${use.versionId}`}>{label('Linked strategy', '关联策略')} · {versionLabel(use.versionId)}</Link>)}
        </div>
      </aside></div>
    {diff.length > 0 && <details className="rounded-xl border p-4"><summary className="cursor-pointer font-semibold">{label('Changes from parent version', '相对父版本的差异')}</summary><div className="mt-4"><Diff changes={diff} en={en} /></div></details>}
    {version.changeReason && <p className="text-sm text-muted-foreground">{label('Change reason: ', '修订原因：')}{version.changeReason}</p>}
    {adoptions.length > 0 && <details className="rounded-xl border p-4"><summary className="cursor-pointer font-semibold">{label('Adoption history', '采纳历史')}</summary><ol className="mt-3 space-y-2 text-sm">{adoptions.map(event => <li key={event.id}><Link className="underline" to={`/analysis/reports/${event.versionId}`}>{versionLabel(event.versionId)}</Link> · {new Date(event.createdAt).toLocaleString()} · {label('Adopted by you', '由你采纳')}{event.previousVersionId && <> · {label('Previously ', '此前 ')}<Link className="underline" to={`/analysis/reports/${event.previousVersionId}`}>{versionLabel(event.previousVersionId)}</Link></>}</li>)}</ol></details>}
    {version.status !== 'revoked' && <div className="space-y-3 border-t pt-4"><Button size="sm" variant="ghost" onClick={() => setShowRevoke(!showRevoke)}>{label('Evidence withdrawn / invalidate version', '证据撤回 / 作废此版本')}</Button>
      {showRevoke && <div className="flex flex-wrap gap-2"><Input aria-label={label('Reason for invalidation', '作废原因')} className="max-w-lg" placeholder={label('Reason for invalidation', '请填写作废原因')} value={revocation} onChange={event => setRevocation(event.target.value)} /><Button variant="destructive" disabled={busy || !revocation.trim()} onClick={() => void action(async () => { await revokeResearchVersion(version.id, revocation); setShowRevoke(false); })}>{label('Invalidate version', '作废版本')}</Button></div>}
    </div>}
  </div>;
}
