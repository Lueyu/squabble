import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fetchOverallDailyResearch, startOverallDailyResearch } from '@/api/workspace';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import ResearchMarkdown from '@/components/ResearchMarkdown';
import ArchivedCouncilPage from '@/pages/Council/ArchivedCouncilPage';
import ResumeDailyReportButton from '@/pages/Today/ResumeDailyReportButton';

export default function OverallDailyResearch({ date, onEvidence }: { date: string; onEvidence: (id: string) => void }) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  const client = useQueryClient(), [params, setParams] = useSearchParams();
  const key = ['overall-daily-research', date];
  const query = useQuery({ queryKey: key, queryFn: () => fetchOverallDailyResearch(date),
    refetchInterval: query => ['idle', 'running'].includes(query.state.data?.latest?.status ?? '') ? 3000 : false, retry: false });
  const storageKey = `squabble.overall-daily-request.${date}`;
  const request = useRef<string | null>(null);
  const generation = useMutation({ mutationFn: async () => {
    if (!request.current) {
      try { request.current = window.sessionStorage.getItem(storageKey); } catch { /* Storage is optional. */ }
      request.current ??= crypto.randomUUID();
      try { window.sessionStorage.setItem(storageKey, request.current); } catch { /* In-memory retry remains available. */ }
    }
    return startOverallDailyResearch({ date, requestKey: request.current });
  }, retry: false, onSuccess: view => {
    client.setQueryData(key, view); request.current = null;
    try { window.sessionStorage.removeItem(storageKey); } catch { /* Optional storage. */ }
    void client.invalidateQueries({ queryKey: key });
  } });
  const current = query.data?.latest, report = query.data?.reports[0];
  const running = ['idle', 'running'].includes(current?.status ?? '');
  const selectedSession = params.get('session');
  const allowedSession = selectedSession && (current?.sessionId === selectedSession || query.data?.reports.some(item => item.sessionId === selectedSession));
  const inspect = (id: string | null) => {
    const next = new URLSearchParams(params); if (id) next.set('session', id); else next.delete('session');
    setParams(next, { replace: true });
  };
  return <section className="workspace-v4-card">
    <h2>{zh ? '总体日报 · 股友共同总结' : 'Overall daily · Independent research and synthesis'}</h2>
    <p className="muted">{zh ? '明确发起后，冻结个人账本、历史持仓输入和全部模拟仓当日记录，再独立分析、反向核查与封存。使用已配置研究连接与预算；不同起点不排名，不授权交易。' : 'An explicit request freezes the real ledger, historical portfolio inputs and all simulation results, then runs independent research, a reverse check and publication. Uses configured connections and budgets; different starting points are not ranked and no trade is authorized.'}</p>
    <div className="workspace-v4-actions"><Button disabled={generation.isPending || running || !query.data} onClick={() => generation.mutate()}>
      {generation.isPending ? (zh ? '正在保存研究请求…' : 'Saving request…') : running ? (zh ? '总体研究进行中' : 'Overall research in progress') : report ? (zh ? '重新生成总体日报' : 'Generate a new overall report') : (zh ? '生成总体日报' : 'Generate overall daily report')}
    </Button><Button variant="ghost" onClick={() => void query.refetch()}>{zh ? '读取进度' : 'Read progress'}</Button>
      {current && <Button variant="outline" onClick={() => inspect(current.sessionId)}>{zh ? '查看过程与处理失败' : 'Inspect progress and recovery'}</Button>}</div>
    {generation.isError && <p role="alert">{zh ? '请求尚未确认，重试会沿用原请求，不会自动另开研究。' : 'The request is unconfirmed. Retry retains the original request; no new research starts automatically.'}</p>}
    {query.isError && <p role="alert">{zh ? '总体日报暂时无法读取，可重试读取。' : 'Overall reports could not be read. Retry the read.'}</p>}
    {current && <p className="muted">{current.status} · {current.stage} · {zh ? '资料冻结于' : 'Facts frozen at'} {new Date(current.readAt).toLocaleString(i18n.language)} · Asia/Shanghai</p>}
    {current?.error && <p role="alert">{current.error}</p>}
    {current && ['idle', 'paused', 'failed'].includes(current.status) && <ResumeDailyReportButton sessionId={current.sessionId} />}
    {report ? <><ResearchMarkdown>{report.content}</ResearchMarkdown><Button variant="outline" onClick={() => onEvidence(report.versionId)}>{zh ? '核对总体日报与冻结资料' : 'Inspect overall report and frozen inputs'}</Button></> : <p className="muted">{zh ? '尚无已发布总体总结。下方事实和原始持仓研究继续保留。' : 'No overall synthesis has been published. Saved facts and original portfolio research remain below.'}</p>}
    <Dialog open={Boolean(selectedSession)} onOpenChange={open => { if (!open) { inspect(null); void query.refetch(); } }}><DialogContent className="workspace-v4-dialog sm:max-w-5xl"><DialogHeader><DialogTitle>{zh ? '总体研究过程与恢复' : 'Overall research and recovery'}</DialogTitle><DialogDescription>{zh ? '保留已完成的独立观点；付费重试与续接都需要明确点击。关闭回到原日报。' : 'Retained independent work stays available. Retrying or continuing requires an explicit action. Close to return to this daily.'}</DialogDescription></DialogHeader>{allowedSession ? <ArchivedCouncilPage embeddedSessionId={selectedSession!} /> : <p role="alert">{zh ? '此任务不属于当前可读取的总体日报。请关闭后从本日记录重新打开。' : 'This task is not part of the available overall reports for this date. Close and reopen it from this day’s records.'}</p>}</DialogContent></Dialog>
  </section>;
}
