import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { teamRunsApi } from '@/api/team-runs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { createRequestIntent } from '@/utils/simple-experience';
import { friendlyError } from '@/utils/error-message';
import type { TeamDetail } from '@shared/team-workspace.interface';
import type { TradingMarket } from '@shared/trading-market.interface';
import type { TeamRunAgreement, TeamRunAgreementInput, TeamRunAgreementPreview } from '@shared/team-run.interface';
import { guidedRunBudget } from './guided-team-state';

export interface RunSetupRecord {
  key: string; payload: Omit<TeamRunAgreementInput, 'requestKey'>;
  preview?: TeamRunAgreementPreview; agreement?: TeamRunAgreement;
}
export function runSetupNeedsReview(error: unknown): boolean {
  const data = (error as { response?: { data?: { code?: string; message?: string } | string } })?.response?.data;
  const code = typeof data === 'string' ? data : data?.code ?? data?.message;
  return ['TEAM_PREVIEW_STALE', 'TEAM_PREVIEW_CONSUMED', 'PREVIEW_EXPIRED', 'SOURCE_CHANGED_REPREVIEW', 'TEAM_REAPPROVAL_REQUIRED'].includes(code ?? '');
}
/** Retain exact preview, confirmation and start identities after an unknown response. */
export async function executeRunSetup(teamId: string, record: RunSetupRecord, api: Pick<typeof teamRunsApi, 'preview' | 'confirm' | 'start'> = teamRunsApi): Promise<TeamRunAgreement> {
  record.preview ??= await api.preview(teamId, { ...record.payload, requestKey: `${record.key}:preview` });
  record.agreement ??= await api.confirm(teamId, { requestKey: `${record.key}:confirm`, previewId: record.preview.previewId, previewHash: record.preview.previewHash });
  return api.start(teamId, { requestKey: `${record.key}:start`, expectedRevision: record.agreement.revision });
}

export function TeamRunPanel({ team, zh }: { team: TeamDetail; zh: boolean }) {
  const client = useQueryClient(); const intent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const [setup, setSetup] = useState(false); const [daily, setDaily] = useState('2'); const [market, setMarket] = useState<TradingMarket>('CN'); const [ack, setAck] = useState(false); const [error, setError] = useState('');
  const status = useQuery({ queryKey: ['team-run', team.id], queryFn: () => teamRunsApi.status(team.id), refetchInterval: 15_000, retry: false });
  const agreement = status.data?.agreement;
  const externalFeesUnknown = team.publishedVersion?.config.roles.filter(role => role.participation === 'enabled').some(role => role.executor?.executionMode !== 'model') ?? true;
  const setupRecord = useRef<RunSetupRecord | null>(null);
  const renewalRecord = useRef<RunSetupRecord | null>(null);
  const [reviewRequired, setReviewRequired] = useState(false);
  const refresh = async () => { await client.invalidateQueries({ queryKey: ['team-run', team.id] }); await client.invalidateQueries({ queryKey: ['teams'] }); await client.invalidateQueries({ queryKey: ['onboarding'] }); };
  const control = useMutation({ retry: false, mutationFn: async (action: 'start' | 'pause' | 'resume') => {
    if (!agreement) throw new Error('Missing agreement');
    return teamRunsApi[action](team.id, { requestKey: intent.current.keyFor({ action, id: agreement.id, revision: agreement.revision }), expectedRevision: agreement.revision });
  }, onSuccess: refresh, onError: failure => setError(friendlyError(failure, zh, { zh: '操作结果尚未确认，请先核对运行状态，再使用相同操作继续。', en: 'The result is not confirmed. Check the run state before continuing the same action.' })) });
  const enable = useMutation({ retry: false, mutationFn: async () => {
    if (reviewRequired) throw new Error('Refresh the review first');
    if (!ack) throw new Error('Review the run rules first');
    setupRecord.current ??= prepareSetupForReview();
    return executeRunSetup(team.id, setupRecord.current);
  }, onSuccess: async () => { setSetup(false); setupRecord.current = null; await refresh(); }, onError: failure => {
    if (runSetupNeedsReview(failure)) { setReviewRequired(true); setAck(false); }
    void status.refetch();
    setError(friendlyError(failure, zh, { zh: '启动尚未完成。已保存本次请求；结果未知时继续会核对原请求。预览过期时请重新核对，再确认。', en: 'Startup is incomplete. The request is retained; an unknown result retries the original request. Refresh an expired review before confirming again.' }));
  } });
  const renew = useMutation({ retry: false, mutationFn: async () => {
    // A definitive rejection permits a new preview. A lost renewal response keeps its new exact key.
    renewalRecord.current ??= prepareSetupForReview();
    const record = renewalRecord.current;
    record.preview ??= await teamRunsApi.preview(team.id, { ...record.payload, requestKey: `${record.key}:preview` });
    return record;
  }, onSuccess: record => { setupRecord.current = record; renewalRecord.current = null; setReviewRequired(false); setAck(false); setError(''); }, onError: failure => {
    if (runSetupNeedsReview(failure)) renewalRecord.current = null;
    setError(zh ? '重新核对尚未完成，输入保留。再次读取会保留结果未知的请求。' : 'The refreshed review is unconfirmed. Inputs are retained; retry keeps an unknown request identity.');
  } });
  function prepareSetupForReview(): RunSetupRecord {
    if (!team.binding || !team.currentVersionId) throw new Error('Review the team and account first');
    return { key: crypto.randomUUID(), payload: { teamVersionId: team.currentVersionId, bindingId: team.binding.id, expectedBindingRevision: team.bindingRevision, objective: 'Research the simulated portfolio, retain uncertainty and act only within the confirmed account risk rules.', market, budget: guidedRunBudget(daily, externalFeesUnknown), replacementPolicy: { kind: 'replace_combination', allocationPct: 100 }, inputRefs: [] } };
  }
  const states: Record<string, string> = zh ? { confirmed: '已准备，等待启动', running: '自动运行中', paused: '已暂停', suspended: '需要处理' } : { confirmed: 'Ready to start', running: 'Running automatically', paused: 'Paused', suspended: 'Needs attention' };
  const cycles: Record<string, string> = zh ? { reserved: '已预留额度', researching: '正在研究', processing: '正在核对判断', applied: '模拟执行规则已应用', observed: '本轮继续观察', blocked: '本轮需要处理', uncertain: '结果待核对', cancelled: '已取消' } : { reserved: 'Budget reserved', researching: 'Researching', processing: 'Checking decisions', applied: 'Paper rules applied', observed: 'Observing', blocked: 'Needs attention', uncertain: 'Outcome unknown', cancelled: 'Cancelled' };
  return <section className="space-y-5 rounded-xl border bg-card p-5 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">{agreement ? states[agreement.state] : (zh ? '让团队自动工作' : 'Let your team work')}</h2><p className="text-sm text-muted-foreground mt-2">{agreement ? (zh ? `主市场 ${agreement.configuration.market} · 每个交易日收盘后 ${agreement.configuration.cadence.delayMinutes} 分钟研究。` : `${agreement.configuration.market} · Research ${agreement.configuration.cadence.delayMinutes} minutes after each trading close.`) : (zh ? '成员、账户和运行规则核对完成后，一次确认启动。' : 'Review members, account and run rules, then confirm once to start.')}</p></div>{agreement?.state === 'running' ? <Button variant="outline" disabled={control.isPending} onClick={() => control.mutate('pause')}>{zh ? '暂停团队' : 'Pause team'}</Button> : agreement?.state === 'paused' ? <Button disabled={control.isPending} onClick={() => control.mutate('resume')}>{zh ? '恢复运行' : 'Resume'}</Button> : !agreement || agreement.state === 'suspended' ? <Button disabled={!team.binding || team.status === 'archived'} onClick={() => { setAck(false); setSetup(true); }}>{zh ? '设置并启动自动运行' : 'Set up automatic runs'}</Button> : null}</div>
    {agreement?.state === 'confirmed' && <Button disabled={control.isPending} onClick={() => control.mutate('start')}>{zh ? '启动已确认的规则' : 'Start confirmed rules'}</Button>}
    {agreement?.state === 'paused' && <Button variant="ghost" onClick={() => { setDaily(agreement.configuration.budget.daily.costUsd); setMarket(agreement.configuration.market); setAck(false); setSetup(true); }}>{zh ? '调整运行规则' : 'Adjust run rules'}</Button>}
    {status.isError && <p role="alert" className="text-sm text-muted-foreground">{zh ? '暂时无法更新运行状态，上次读取的信息已保留。' : 'Run state could not refresh. The last saved view is retained.'}<button className="underline ml-2" onClick={() => void status.refetch()}>{zh ? '重新读取' : 'Reload'}</button></p>}
    {agreement && <div className="grid gap-3 sm:grid-cols-3"><div className="rounded-lg bg-muted/40 p-3"><p className="text-xs text-muted-foreground">{zh ? '研究预算' : 'Research budget'}</p><p className="font-medium">{agreement.configuration.budget.daily.costUsd} USD / {zh ? '日' : 'day'}</p><p className="text-xs text-muted-foreground">{agreement.configuration.budget.monthly.costUsd} USD / {zh ? '月' : 'month'}</p></div><div className="rounded-lg bg-muted/40 p-3"><p className="text-xs text-muted-foreground">{zh ? '成员' : 'Members'}</p><p className="font-medium">{agreement.members.length} {zh ? '位已有股友' : 'saved agents'}</p><p className="text-xs text-muted-foreground">{zh ? '固定版本，团队记忆隔离' : 'Pinned versions; isolated team memory'}</p></div><div className="rounded-lg bg-muted/40 p-3"><p className="text-xs text-muted-foreground">{zh ? '模拟账户' : 'Paper account'}</p><Button asChild size="sm" variant="ghost"><Link to={`/holdings?accountId=${encodeURIComponent(agreement.accountId)}`}>{zh ? '查看持仓与成交' : 'View holdings and fills'}</Link></Button><p className="text-xs text-muted-foreground">{zh ? '保持独立账本' : 'Independent ledger'}</p></div></div>}
    {agreement?.externalCostUnknown && <p className="text-xs text-amber-700">{zh ? '部分助手的实际费用未知；调用次数受限，上述金额不代表外部账单的保证上限。' : 'Some actual fees are unknown. Calls are bounded; the amounts do not guarantee an external bill cap.'}</p>}
    {agreement?.state === 'suspended' && <p role="alert" className="text-sm">{agreement.suspensionReason === 'AGENT_ARCHIVED_SETTLEMENT_ONLY' ? (zh ? '股友已归档：已停止新研究与自动模拟执行，已派发研究可继续结算。请调整成员后重新确认。' : 'An agent was archived. New research and automatic paper execution stopped; dispatched research may settle. Update members and confirm again.') : (zh ? '团队版本、账户、权限或运行条件已变化，自动工作已停止。请检查后重新确认规则。' : 'Team, account, permissions or run conditions changed. Automatic work stopped. Review the setup and confirm new rules.')}</p>}
    <div><h3 className="font-medium mb-3">{zh ? '最近做了什么' : 'Recent work'}</h3>{!status.data?.recentCycles.length && <p className="text-sm text-muted-foreground">{zh ? '还没有已记录的自动周期。启动后等待下一个有效研究窗口；没有任务时不会产生研究费用。' : 'No automatic cycle is recorded yet. After startup, wait for a valid research window; idle time does not start model calls.'}</p>}<ul className="space-y-3">{status.data?.recentCycles.slice(0, 6).map(cycle => <li className="rounded-lg border p-3 text-sm" key={cycle.id}><div className="flex justify-between gap-3"><strong>{cycles[cycle.state] ?? cycle.state}</strong><span>{cycle.tradingDate}</span></div>{cycle.commissionId && <Link className="underline text-primary block mt-2" to={`/teams/${team.id}/commissions/${cycle.commissionId}`}>{zh ? '查看原判断与执行记录' : 'View original decision and execution'}</Link>}{cycle.lastError && <details className="text-xs text-muted-foreground mt-2"><summary>{zh ? '处理详情' : 'Details'}</summary>{cycle.lastError}</details>}</li>)}</ul></div>
    <p className="text-xs text-muted-foreground">{zh ? '暂停会停止后续研究及全部模拟交易，包括保护单；在途任务会显示实际取消或结算状态。' : 'Pausing stops future research and all paper trades, including protective orders. In-flight tasks retain their real cancellation or settlement state.'}</p>
    {setup && <div className="space-y-3 border-t pt-4"><h3 className="font-semibold">{zh ? '核对运行规则' : 'Review run rules'}</h3><p className="text-sm">{zh ? '只使用本团队已授权资料和工具，沿用模拟账户风险规则。每轮可用额度为每日的一半，月度为每日的20倍，调用最多8/轮、16/日、320/月。' : 'Use only authorized team data/tools and account risk rules. Each run reserves half the daily amount, monthly cap is 20 daily amounts; calls cap at 8/run, 16/day and 320/month.'}</p>{externalFeesUnknown && <p className="text-sm text-amber-700">{zh ? '本地或外部助手的实际费用未知。本系统限制调用次数，上述金额不能保证服务商账单上限。' : 'Actual local or external fees are unknown. This system bounds calls; the amount cannot guarantee the provider’s bill.'}</p>}<Input aria-label={zh ? '每日预算 USD' : 'Daily budget USD'} type="number" min="0.02" value={daily} disabled={enable.isPending || renew.isPending || Boolean(renewalRecord.current) || Boolean(setupRecord.current) && !reviewRequired} onChange={e => setDaily(e.target.value)} /><select className="w-full rounded border p-2 bg-background" aria-label={zh ? '主市场' : 'Main market'} value={market} disabled={enable.isPending || renew.isPending || Boolean(renewalRecord.current) || Boolean(setupRecord.current) && !reviewRequired} onChange={e => setMarket(e.target.value as TradingMarket)}>{['CN', 'HK', 'US'].map(m => <option key={m}>{m}</option>)}</select>{setupRecord.current?.preview && !reviewRequired && <p className="text-sm">{zh ? '已核对成员：' : 'Reviewed members: '}{setupRecord.current.preview.result.members.map(member => member.label).join(' · ')} · <Link className="underline" to={`/holdings?accountId=${encodeURIComponent(setupRecord.current.preview.result.accountId)}`}>{zh ? '查看本次模拟账户' : 'Review this paper account'}</Link></p>}{reviewRequired && <div className="space-y-2 text-sm" role="alert"><p>{zh ? '预览已过期或运行条件变化，请先重新读取，再核对并勾选确认。' : 'The preview expired or run conditions changed. Refresh it, review the details, and confirm again.'}</p><Button variant="outline" disabled={renew.isPending} onClick={() => renew.mutate()}>{zh ? '重新核对运行规则' : 'Refresh run review'}</Button></div>}<label className="flex gap-3 text-sm"><Checkbox checked={ack} onCheckedChange={value => setAck(value === true)} /><span>{zh ? '我确认授权范围与费用方式，允许自动研究和模拟交易；全部现有模拟组合将按本团队的新判断替换。' : 'I confirm scope and billing limits and allow automatic research and paper trades; this team’s decisions replace the current paper combination.'}</span></label><Button disabled={!ack || enable.isPending || renew.isPending || reviewRequired} onClick={() => enable.mutate()}>{enable.isPending ? (zh ? '正在核对…' : 'Checking…') : (zh ? '确认并启动' : 'Confirm and start')}</Button></div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
