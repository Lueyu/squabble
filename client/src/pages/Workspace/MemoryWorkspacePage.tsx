import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { fetchMemoryInventory } from '@/api/workspace';
import { fetchChannelMemory } from '@/api/channel';
import { fetchCouncilSession, fetchCouncilSessions } from '@/api/council';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import CouncilMemberAvatar from '@/pages/Council/CouncilMemberAvatar';
import { CouncilMemoryPanel } from '@/pages/Council/CouncilMemoryPanel';
import CouncilMemoryInventory from '@/pages/Council/CouncilMemoryInventory';
import ResearchMemorySettings from '@/pages/Settings/ResearchMemorySettings';
import type { ResearchThesis, ResearchMemoryItem } from '@shared/research-memory.interface';
import './workspace-v4.css';

export default function MemoryWorkspacePage() {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  const [offset, setOffset] = useState(0);
  const [tab, setTab] = useState<'research' | 'preferences' | 'usage'>('research');
  const [selected, setSelected] = useState<ResearchThesis | ResearchMemoryItem | null>(null);
  const query = useQuery({ queryKey: ['memory-inventory', offset], queryFn: () => fetchMemoryInventory(offset) });
  const preferences = useQuery({ queryKey: ['channel-memory'], queryFn: fetchChannelMemory });
  const theses = query.data?.theses ?? [];
  const statusLabel = (thesis: ResearchThesis) => thesis.excluded ? (zh ? '已停用' : 'Excluded') : ({ candidate: zh ? '待确认线索' : 'Candidate', accepted: zh ? '研究已验收' : 'Research accepted', confirmed: zh ? '你已确认' : 'User confirmed', dismissed: zh ? '已否定' : 'Dismissed', expired: zh ? '已过期' : 'Expired' })[thesis.status];
  return <main className="workspace-v4"><header><h1>{zh ? '股友记忆' : 'Stock friend memory'}</h1><p className="muted">{zh ? '看得见、改得动，也能决定不再被使用。' : 'See what is remembered, correct it, or stop future use.'}</p></header>
    <div className="workspace-v4-actions" role="tablist" aria-label={zh ? '记忆分类' : 'Memory categories'}>{(['research', 'preferences', 'usage'] as const).map(value => <Button role="tab" aria-selected={tab === value} key={value} variant={tab === value ? 'secondary' : 'ghost'} onClick={() => setTab(value)}>{({ research: zh ? '研究记忆' : 'Research memory', preferences: zh ? '确认偏好与策略范围' : 'Preferences and strategy scope', usage: zh ? '记忆提交记录' : 'Memory submission records' })[value]}</Button>)}</div>
    <section className="workspace-v4-card workspace-v4-banner"><h2>{zh ? '股友记住的是可解释的线索' : 'Memory preserves explainable context'}</h2><p>{zh ? '确认偏好、策略约束与研究结论分别保存。待确认线索不会自动成为买卖规则；编辑和停用不会改写历史成交或报告。' : 'Confirmed preferences, strategy rules and research findings remain distinct. Candidates never become trading rules automatically; edits and exclusions preserve historical trades and reports.'}</p></section>
    {tab === 'research' && <>
      <dl className="workspace-v4-stats">{[[zh ? '已归档研究来源' : 'Archived sources', query.data?.total ?? '—'], [zh ? '本页可用论点' : 'Eligible claims on page', theses.filter(item => !item.excluded && ['accepted', 'confirmed'].includes(item.status) && item.sourceStatus === 'available').length], [zh ? '本页待确认' : 'Candidates on page', theses.filter(item => item.status === 'candidate' && !item.excluded).length], [zh ? '本页已停用' : 'Excluded on page', theses.filter(item => item.excluded).length]].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {query.isPending && <p role="status">{zh ? '正在读取记忆…' : 'Loading memory…'}</p>}{query.isError && <div role="alert"><p>{zh ? '记忆暂时无法读取。' : 'Memory is unavailable.'}</p><Button onClick={() => void query.refetch()}>{zh ? '重试' : 'Retry'}</Button></div>}
      <h2>{zh ? '当前记忆' : 'Current memory'}</h2><div className="workspace-v4-grid">{theses.map(thesis => <article className="workspace-v4-card" key={thesis.id}>
        <div className="workspace-v4-identity"><CouncilMemberAvatar avatar={thesis.status === 'confirmed' ? 'risk' : 'moderator'} role="researcher" className="size-12" /><div><h3>{thesis.ticker} · {zh ? '研究结论' : 'Research finding'}</h3><p className="muted">{thesis.market} · {thesis.topic} · v{thesis.version}</p></div></div>
        <div><Badge variant="secondary">{statusLabel(thesis)}</Badge></div><p>{thesis.claim || (zh ? '原始内容不可用' : 'Original content unavailable')}</p>
        <p className="muted">{zh ? '来源' : 'Source'}: {thesis.source ? `${new Date(thesis.source.reportCreatedAt).toLocaleDateString(i18n.language)} · v${thesis.source.reportVersion}` : (zh ? '不可用' : 'Unavailable')}<br />{zh ? '有效期' : 'Expires'}: {thesis.expiresAt ? new Date(thesis.expiresAt).toLocaleDateString(i18n.language) : (zh ? '未设定，仍需核对条件' : 'Unspecified; conditions still apply')}</p>
        <Button variant="outline" onClick={() => setSelected(thesis)}>{zh ? '查看来源、版本与管理' : 'Source, versions and controls'}</Button>
      </article>)}</div>
      {!theses.length && !query.isPending && <p className="muted">{zh ? '本页没有独立论点。旧报告保留为历史来源，不会自动捏造论点。' : 'No atomic claims on this page. Historical reports remain sources without invented claims.'}</p>}
      <details className="workspace-v4-card"><summary className="cursor-pointer font-medium">{zh ? '历史来源' : 'Historical sources'} ({query.data?.memories.length ?? 0})</summary>{query.data?.memories.map(memory => <div key={memory.id} className="border-t pt-3"><p>{memory.ticker} · {new Date(memory.createdAt).toLocaleDateString(i18n.language)}</p><p className="muted">{memory.summary || (zh ? '来源不可用' : 'Source unavailable')}</p><Button size="sm" variant="ghost" onClick={() => setSelected(memory)}>{zh ? '查看与管理' : 'Inspect and manage'}</Button></div>)}</details>
      <div className="workspace-v4-actions"><Button variant="outline" disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 24))}>{zh ? '上一页' : 'Previous'}</Button><Button variant="outline" disabled={offset + 24 >= (query.data?.total ?? 0)} onClick={() => setOffset(value => value + 24)}>{zh ? '下一页' : 'Next'}</Button></div>
    </>}
    {tab === 'preferences' && <><div className="workspace-v4-grid">{preferences.data?.items.filter(item => item.kind === 'user_stated_preference').map(item => <article className="workspace-v4-card" key={item.id}><div className="workspace-v4-identity"><CouncilMemberAvatar avatar="risk" role="researcher" className="size-12" /><h3>{zh ? '你明确保存的偏好' : 'Your explicitly saved preference'}</h3></div><p>{item.exactUserQuote ?? item.content}</p><p className="muted">{new Date(item.recordedAt).toLocaleString(i18n.language)} · {zh ? '个人研究上下文，不是其他模拟仓的执行规则' : 'Personal research context, not another account’s execution rule'}</p><p className="muted">{zh ? '此旧偏好记录尚不支持版本编辑与停用。可在频道保存新的明确偏好；不会伪装成已修改旧记录。' : 'This legacy preference does not yet support version edits or exclusion. A new explicit preference can be saved in the channel.'}</p><Button asChild variant="outline"><Link to="/council">{zh ? '查看与股友的对话' : 'Open the conversation'}</Link></Button></article>)}</div>{preferences.isError && <Button onClick={() => void preferences.refetch()}>{zh ? '重试读取偏好' : 'Retry preferences'}</Button>}{preferences.data && !preferences.data.items.some(item => item.kind === 'user_stated_preference') && <p className="muted">{zh ? '还没有明确保存的个人偏好。' : 'No personal preferences have been explicitly saved.'}</p>}<section className="workspace-v4-card"><h2>{zh ? '策略约束随模拟仓版本生效' : 'Strategy constraints belong to account versions'}</h2><p>{zh ? '集中度、买卖条件和资金限制以对应账户已确认的策略组合为准。研究记忆不能覆盖它们。' : 'Concentration, trade conditions and budgets follow each account’s confirmed combination. Research memory cannot override them.'}</p><Button asChild variant="outline"><Link to="/paper">{zh ? '查看各股友策略组合' : 'Inspect account strategies'}</Link></Button></section></>}
    {tab === 'usage' && <MemoryUsage />}
    <ResearchMemorySettings />
    <Dialog open={Boolean(selected)} onOpenChange={open => { if (!open) { setSelected(null); void query.refetch(); } }}><DialogContent className="workspace-v4-dialog sm:max-w-4xl"><DialogHeader><DialogTitle>{selected?.ticker} · {zh ? '来源、范围与版本' : 'Source, scope and versions'}</DialogTitle><DialogDescription>{zh ? '按标的和主题管理；操作使用保存版本校验，关闭后继续查看清单。' : 'Manage the symbol and topic using saved-version checks. Close to return to the inventory.'}</DialogDescription></DialogHeader>{selected && <CouncilMemoryPanel selection={{kind: 'claim' in selected ? 'thesis' : 'memory', id: selected.id}} ticker={selected.ticker} market={selected.market} topic={selected.topic} onChange={() => void query.refetch()} />}</DialogContent></Dialog>
  </main>;
}
function MemoryUsage() {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  const [sessionId, setSessionId] = useState('');
  const sessions = useQuery({ queryKey: ['memory-usage-sessions'], queryFn: () => fetchCouncilSessions() });
  const session = useQuery({ queryKey: ['memory-usage-session', sessionId], queryFn: () => fetchCouncilSession(sessionId), enabled: Boolean(sessionId) });
  const messages = session.data?.messages.filter(message => message.memory) ?? [];
  return <section className="workspace-v4-card"><h2>{zh ? '这次研究提交了哪些记忆' : 'Which memory was submitted to this research'}</h2><p className="muted">{zh ? '这是应用记录的提交清单。提交不等于模型实际引用；本地 Agent 的私有上下文不可观测。旧任务缺少记录时不会补造使用次数。' : 'These are recorded submissions, not proof of model use. Native agents’ private context is not observable. Missing historical inventories remain unknown.'}</p>
    <label className="text-sm">{zh ? '选择研究任务' : 'Choose research'}<select className="mt-2 w-full rounded-md border bg-background p-2" value={sessionId} onChange={event => setSessionId(event.target.value)}><option value="">{zh ? '请选择' : 'Select a task'}</option>{sessions.data?.map(item => <option key={item.id} value={item.id}>{item.title || item.ticker} · {new Date(item.createdAt).toLocaleDateString(i18n.language)}</option>)}</select></label>
    {(sessions.isError || session.isError) && <Button onClick={() => void (sessionId ? session.refetch() : sessions.refetch())}>{zh ? '重试读取记录' : 'Retry records'}</Button>}
    {session.isFetching && <p role="status">{zh ? '正在读取提交记录…' : 'Loading submission records…'}</p>}
    {session.data && !messages.length && <p>{zh ? '该任务没有保存记忆提交清单，使用情况未知。' : 'No memory submission inventory was recorded for this task.'}</p>}
    {messages.map(message => <article key={message.id} className="rounded-md border p-3"><h3>{message.memberName} · {new Date(message.createdAt).toLocaleString(i18n.language)}</h3><CouncilMemoryInventory inventory={message.memory} applicable /></article>)}
  </section>;
}
