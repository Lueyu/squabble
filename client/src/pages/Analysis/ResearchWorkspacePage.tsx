import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { fetchCouncilSessions } from '@/api/council';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import CouncilMemberAvatar from '@/pages/Council/CouncilMemberAvatar';
import '../Workspace/workspace-v4.css';

export default function ResearchWorkspacePage() {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  const [question, setQuestion] = useState('');
  const navigate = useNavigate();
  const sessions = useQuery({ queryKey: ['research-workspace-sessions'], queryFn: () => fetchCouncilSessions() });
  const entries = [
    { title: zh ? '我的持仓研究' : 'Portfolio research', body: zh ? '核对真实持仓、风险与后续观察，明确发起研究或继续已有任务。' : 'Review real positions, risks and next checks. Explicitly start research or continue a saved task.', to: '/research/portfolio', avatar: 'risk' as const },
    { title: zh ? '自选与单标的研究' : 'Watchlist and stock research', body: zh ? '从关注的标的出发，查看行情、资料与观点变化。' : 'Inspect quotes, evidence and changes in views for watched securities.', to: '/watchlist', avatar: 'technical' as const },
    { title: zh ? '讨论与研究团队' : 'Discussion and research team', body: zh ? '配置独立研究、核查与总结的参与者和真实执行连接。' : 'Configure independent research, verification and synthesis participants.', to: '/settings/agents', avatar: 'news' as const },
    { title: zh ? '研究档案与复盘' : 'Research archive and review', body: zh ? '按日期阅读历史报告，已保存材料不会被最新结果替换。' : 'Read historical reports by date without replacing them with newer findings.', to: '/analysis', avatar: 'moderator' as const },
  ];
  return <main className="workspace-v4"><header><h1>{zh ? '研究室' : 'Research room'}</h1><p className="muted">{zh ? '从具体问题开始，保留每一种有依据的观点。' : 'Start with a concrete question and preserve evidence-backed differences.'}</p></header>
    <form className="workspace-v4-card workspace-v4-banner" onSubmit={event => { event.preventDefault(); if (question.trim()) navigate(`/council?question=${encodeURIComponent(question.trim())}`); }}><h2>{zh ? '今天想研究什么' : 'What would you like to investigate?'}</h2><label className="space-y-2 text-sm"><span>{zh ? '研究问题' : 'Research question'}</span><Textarea value={question} maxLength={2000} rows={3} onChange={event => setQuestion(event.target.value)} placeholder={zh ? '例如：当前持仓是否过于集中？' : 'For example: Is my portfolio too concentrated?'} /></label><p className="muted">{zh ? '进入讨论后核对范围并发送。这里保存输入到下一页，不会自动调用模型。' : 'Review scope and send in the discussion. Continuing transfers your question without calling a model.'}</p><Button type="submit" className="self-start" disabled={!question.trim()}>{zh ? '带着问题进入讨论' : 'Continue to discussion'}</Button></form>
    <h2>{zh ? '熟悉的研究能力' : 'Your research capabilities'}</h2><div className="workspace-v4-grid">{entries.map(entry => <article className="workspace-v4-card" key={entry.to}><div className="workspace-v4-identity"><CouncilMemberAvatar role="researcher" avatar={entry.avatar} className="size-12" /><h3>{entry.title}</h3></div><p>{entry.body}</p><Button asChild variant="outline"><Link to={entry.to}>{zh ? '打开' : 'Open'}</Link></Button></article>)}</div>
    <section className="workspace-v4-card"><h2>{zh ? '最近的研究任务' : 'Recent research tasks'}</h2>{sessions.isPending && <p role="status">{zh ? '正在读取…' : 'Loading…'}</p>}{sessions.isError && <Button onClick={() => void sessions.refetch()}>{zh ? '重试读取' : 'Retry'}</Button>}{sessions.data?.slice(0, 12).map(session => <article key={session.id} className="border-b pb-3"><div className="workspace-v4-header"><div><h3>{session.title || session.ticker}</h3><p className="muted">{session.status} · {new Date(session.createdAt).toLocaleString(i18n.language)}</p></div><Button asChild variant="outline"><Link to={`/council?session=${encodeURIComponent(session.id)}`}>{zh ? '查看研究' : 'Inspect research'}</Link></Button></div></article>)}{sessions.data?.length === 0 && <p className="muted">{zh ? '尚无研究任务。从一个具体问题开始。' : 'No research tasks yet. Start with a specific question.'}</p>}</section>
  </main>;
}
