import { useEffect, useRef, useState } from 'react';
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
import { automaticRunBudget, requiredRunCalls } from './team-run-setup';

export interface RunSetupRecord {
  key: string; payload: Omit<TeamRunAgreementInput, 'requestKey'>;
  preview?: TeamRunAgreementPreview; agreement?: TeamRunAgreement;
}
export interface TeamRunPanelProps {
  team: TeamDetail; zh: boolean;
  onConfigure?: () => void; onPublish?: () => void; onBind?: () => void;
  setupBlocked?: boolean;
}
export function runSetupNeedsReview(error: unknown): boolean {
  const data = (error as { response?: { data?: { code?: string; message?: string; error?: { code?: string; message?: string } } | string } })?.response?.data;
  const code = typeof data === 'string' ? data : data?.error?.code ?? data?.code ?? data?.error?.message ?? data?.message;
  return ['TEAM_PREVIEW_STALE', 'TEAM_PREVIEW_CONSUMED', 'PREVIEW_EXPIRED', 'SOURCE_CHANGED_REPREVIEW', 'TEAM_REAPPROVAL_REQUIRED'].includes(code ?? '');
}
/** Retain exact preview, confirmation and start identities after an unknown response. */
export async function executeRunSetup(teamId: string, record: RunSetupRecord, api: Pick<typeof teamRunsApi, 'preview' | 'confirm' | 'start'> = teamRunsApi): Promise<TeamRunAgreement> {
  record.preview ??= await api.preview(teamId, { ...record.payload, requestKey: `${record.key}:preview` });
  record.agreement ??= await api.confirm(teamId, { requestKey: `${record.key}:confirm`, previewId: record.preview.previewId, previewHash: record.preview.previewHash });
  return api.start(teamId, { requestKey: `${record.key}:start`, expectedRevision: record.agreement.revision });
}

export function TeamRunPanel({ team, zh, onConfigure, onPublish, onBind, setupBlocked = false }: TeamRunPanelProps) {
  const client = useQueryClient(); const intent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const [setup, setSetup] = useState(false); const [daily, setDaily] = useState(''); const [amountLimited, setAmountLimited] = useState(false); const [market, setMarket] = useState<TradingMarket>('CN'); const [immediate, setImmediate] = useState(true); const [ack, setAck] = useState(false); const [error, setError] = useState('');
  const status = useQuery({ queryKey: ['team-run', team.id], queryFn: () => teamRunsApi.status(team.id), refetchInterval: 15_000, retry: false });
  const agreement = status.data?.agreement;
  const externalFeesUnknown = team.publishedVersion?.config.roles.filter(role => role.participation === 'enabled').some(role => role.executor?.executionMode !== 'model') ?? true;
  const setupRecord = useRef<RunSetupRecord | null>(null);
  const renewalRecord = useRef<RunSetupRecord | null>(null);
  const [reviewRequired, setReviewRequired] = useState(false);
  const [preview, setPreview] = useState<TeamRunAgreementPreview | null>(null);
  const [now, setNow] = useState(Date.now());
  const confirmAttempted = useRef(false);
  const stateKnown = Boolean(status.data) && !status.isPending && !status.isError;
  const config = team.publishedVersion?.config ?? team.draft?.config;
  const roles = config?.roles.filter(role => role.participation === 'enabled') ?? [];
  const blueprint = config?.workBlueprint;
  const requiredRoleIds = new Set(roles.map(role => role.id));
  if (blueprint) {
    blueprint.works.forEach(work => { requiredRoleIds.add(work.roleId); requiredRoleIds.add(work.reviewerRoleId); });
    if (config.defaults.leadRoleId) requiredRoleIds.add(config.defaults.leadRoleId);
    requiredRoleIds.add(blueprint.summary.reviewerRoleId);
  }
  const missingMembers = [...requiredRoleIds].filter(id => {
    const role = config?.roles.find(item => item.id === id);
    return !role || role.participation !== 'enabled' || !role.agentId || !role.agentVersionId || !role.executor;
  });
  const membersReady = requiredRoleIds.size > 0 && missingMembers.length === 0;
  const published = Boolean(team.currentVersionId && team.publishedVersion);
  const bound = Boolean(team.binding && team.binding.state !== 'released' && team.binding.state !== 'superseded' && team.binding.state !== 'archived');
  const canSetup = stateKnown && !setupBlocked && team.status !== 'archived' && team.capabilities?.researchEnabled !== false && published && bound && membersReady;
  const callLimit = config ? requiredRunCalls(config) : 8;
  const expired = Boolean(preview && Date.parse(preview.expiresAt) <= now);
  useEffect(() => {
    if (!preview) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [preview]);
  useEffect(() => {
    const input = setupRecord.current?.payload;
    if (input && !confirmAttempted.current && (input.teamVersionId !== team.currentVersionId || input.bindingId !== team.binding?.id || input.expectedBindingRevision !== team.bindingRevision)) {
      setReviewRequired(true); setAck(false);
    }
  }, [team.currentVersionId, team.binding?.id, team.bindingRevision]);
  const refresh = async () => { await client.invalidateQueries({ queryKey: ['team-run', team.id] }); await client.invalidateQueries({ queryKey: ['teams'] }); await client.invalidateQueries({ queryKey: ['onboarding'] }); };
  const control = useMutation({ retry: false, mutationFn: async (action: 'start' | 'pause' | 'resume') => {
    if (!agreement) throw new Error('Missing agreement');
    if (setupBlocked || action !== 'pause' && !stateKnown) throw new Error('Read the current run status first');
    return teamRunsApi[action](team.id, { requestKey: intent.current.keyFor({ action, id: agreement.id, revision: agreement.revision }), expectedRevision: agreement.revision });
  }, onSuccess: refresh, onError: failure => setError(friendlyError(failure, zh, { zh: '操作结果尚未确认，请先核对运行状态，再使用相同操作继续。', en: 'The result is not confirmed. Check the run state before continuing the same action.' })) });
  const enable = useMutation({ retry: false, mutationFn: async () => {
    if (!canSetup) throw new Error('Read the current team and run status first');
    if (reviewRequired) throw new Error('Refresh the review first');
    if (!ack) throw new Error('Review the run rules first');
    if (!setupRecord.current?.preview) throw new Error('Preview the actual run rules first');
    // A lost confirmation/start response must settle the same receipt, even if its preview subsequently expires.
    if (expired && !confirmAttempted.current) throw new Error('Refresh the expired review first');
    confirmAttempted.current = true;
    return executeRunSetup(team.id, setupRecord.current);
  }, onSuccess: async () => { setSetup(false); setupRecord.current = null; setPreview(null); confirmAttempted.current = false; await refresh(); }, onError: failure => {
    if (runSetupNeedsReview(failure)) { setReviewRequired(true); setAck(false); }
    void status.refetch();
    setError(friendlyError(failure, zh, { zh: '启动尚未完成。已保存本次请求；结果未知时继续会核对原请求。预览过期时请重新核对，再确认。', en: 'Startup is incomplete. The request is retained; an unknown result retries the original request. Refresh an expired review before confirming again.' }));
  } });
  const renew = useMutation({ retry: false, mutationFn: async () => {
    if (!canSetup) throw new Error('Read the current team and run status first');
    // A definitive rejection permits a new preview. A lost renewal response keeps its new exact key.
    renewalRecord.current ??= prepareSetupForReview();
    const record = renewalRecord.current;
    record.preview ??= await teamRunsApi.preview(team.id, { ...record.payload, requestKey: `${record.key}:preview` });
    return record;
  }, onSuccess: record => { setupRecord.current = record; renewalRecord.current = null; setPreview(record.preview ?? null); confirmAttempted.current = false; setReviewRequired(false); setAck(false); setError(''); }, onError: failure => {
    const responseStatus = (failure as { response?: { status?: number } })?.response?.status;
    if (runSetupNeedsReview(failure) || responseStatus && responseStatus >= 400 && responseStatus < 500 && responseStatus !== 408 && responseStatus !== 429) renewalRecord.current = null;
    setError(friendlyError(failure, zh, { zh: '核对尚未完成，输入保留。再次读取会保留结果未知的请求。', en: 'The review is unconfirmed. Inputs are retained; retry keeps an unknown request identity.' }));
  } });
  function prepareSetupForReview(): RunSetupRecord {
    if (!team.binding || !team.currentVersionId) throw new Error('Review the team and account first');
    return { key: crypto.randomUUID(), payload: { teamVersionId: team.currentVersionId, bindingId: team.binding.id, expectedBindingRevision: team.bindingRevision, objective: 'Research the simulated portfolio, retain uncertainty and act only within the confirmed account risk rules.', market, initialRun: immediate ? 'immediate' : 'scheduled', cadence: { kind: 'after_close', delayMinutes: 60 }, budget: automaticRunBudget(amountLimited ? daily : null, externalFeesUnknown, callLimit), replacementPolicy: { kind: 'replace_combination', allocationPct: 100 }, inputRefs: [] } };
  }
  const states: Record<string, string> = zh ? { confirmed: '已准备，等待启动', running: '自动运行中', paused: '已暂停', suspended: '需要处理' } : { confirmed: 'Ready to start', running: 'Running automatically', paused: 'Paused', suspended: 'Needs attention' };
  const cycles: Record<string, string> = zh ? { reserved: '已预留额度', researching: '正在研究', processing: '正在核对判断', applied: '模拟执行规则已应用', observed: '本轮继续观察', blocked: '本轮需要处理', uncertain: '结果待核对', cancelled: '已取消' } : { reserved: 'Budget reserved', researching: 'Researching', processing: 'Checking decisions', applied: 'Paper rules applied', observed: 'Observing', blocked: 'Needs attention', uncertain: 'Outcome unknown', cancelled: 'Cancelled' };
  return <section className="space-y-5 rounded-xl border bg-card p-5 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">{agreement ? states[agreement.state] : (zh ? '让团队自动工作' : 'Let your team work')}</h2><p className="text-sm text-muted-foreground mt-2">{agreement ? (zh ? `主市场 ${agreement.configuration.market} · 每个交易日收盘后 ${agreement.configuration.cadence.delayMinutes} 分钟研究。` : `${agreement.configuration.market} · Research ${agreement.configuration.cadence.delayMinutes} minutes after each trading close.`) : (zh ? '完成成员、发布和模拟账户设置，再预览并确认自动运行规则。' : 'Complete members, publication and a paper account, then preview and confirm automatic run rules.')}</p></div>{agreement?.state === 'running' ? <Button variant="outline" disabled={control.isPending || setupBlocked} onClick={() => control.mutate('pause')}>{zh ? '暂停团队' : 'Pause team'}</Button> : agreement?.state === 'paused' ? <Button disabled={control.isPending || !stateKnown || setupBlocked} onClick={() => control.mutate('resume')}>{zh ? '恢复运行' : 'Resume'}</Button> : stateKnown && (!agreement || agreement.state === 'suspended') ? <Button disabled={!canSetup} onClick={() => { setAck(false); setSetup(true); }}>{zh ? '设置并启动自动运行' : 'Set up automatic runs'}</Button> : null}</div>
    {status.isPending && <p role="status" className="text-sm text-muted-foreground">{zh ? '正在读取运行状态…' : 'Reading run state…'}</p>}
    {!setup && (!published || !bound || !membersReady) && team.status !== 'archived' && <div className="rounded-lg border p-4 space-y-3" aria-label={zh ? '自动运行准备' : 'Automatic run readiness'}>
      <h3 className="font-medium">{zh ? '完成这些设置即可启动' : 'Complete these steps to start'}</h3>
      {!membersReady && <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm">{zh ? (missingMembers.length ? `${missingMembers.length} 个启用岗位尚未关联可执行的股友版本。` : '先为团队配置至少一位可执行股友。') : (missingMembers.length ? `${missingMembers.length} enabled seats need a saved agent version and executor.` : 'Configure at least one enabled agent with an executor.')}</p>{onConfigure && <Button variant="outline" disabled={setupBlocked} onClick={onConfigure}>{zh ? '配置成员' : 'Configure members'}</Button>}</div>}
      {!published && <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm">{zh ? '自动运行使用已发布的固定团队版本。' : 'Automatic runs use a published, fixed team version.'}</p>{onPublish && <Button variant="outline" disabled={setupBlocked} onClick={onPublish}>{zh ? '发布团队版本' : 'Publish team version'}</Button>}</div>}
      {!bound && <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm">{zh ? '选择或新建本团队使用的模拟账户。' : 'Choose or create the paper account this team will manage.'}</p>{onBind && <Button variant="outline" disabled={setupBlocked || !published} onClick={onBind}>{zh ? '关联模拟盘' : 'Link paper account'}</Button>}</div>}
    </div>}
    {agreement?.state === 'confirmed' && !setup && <Button disabled={control.isPending || !stateKnown || setupBlocked} onClick={() => control.mutate('start')}>{zh ? '启动已确认的规则' : 'Start confirmed rules'}</Button>}
    {agreement?.state === 'paused' && <Button variant="ghost" disabled={!canSetup} onClick={() => { setAmountLimited(agreement.configuration.budget.daily.costUsd !== null); setDaily(agreement.configuration.budget.daily.costUsd ?? ''); setMarket(agreement.configuration.market); setImmediate(agreement.configuration.initialRun === 'immediate'); setAck(false); setSetup(true); }}>{zh ? '调整运行规则' : 'Adjust run rules'}</Button>}
    {status.isError && <p role="alert" className="text-sm text-muted-foreground">{zh ? '暂时无法更新运行状态，上次读取的信息已保留。' : 'Run state could not refresh. The last saved view is retained.'}<button className="underline ml-2" onClick={() => void status.refetch()}>{zh ? '重新读取' : 'Reload'}</button></p>}
    {agreement && <div className="grid gap-3 sm:grid-cols-3"><div className="rounded-lg bg-muted/40 p-3"><p className="text-xs text-muted-foreground">{zh ? '研究预算上限' : 'Research budget cap'}</p><RunBudgetLimits budget={agreement.configuration.budget} zh={zh} /><p className="text-xs text-muted-foreground">{zh ? '这是预算上限，实际消费尚未汇总。' : 'These are caps, not recorded spending; actual spending is not summarized here.'}</p></div><div className="rounded-lg bg-muted/40 p-3"><p className="text-xs text-muted-foreground">{zh ? '成员' : 'Members'}</p><p className="font-medium">{agreement.members.length} {zh ? '位已有股友' : 'saved agents'}</p><p className="text-xs text-muted-foreground">{zh ? '固定版本，团队记忆隔离' : 'Pinned versions; isolated team memory'}</p></div><div className="rounded-lg bg-muted/40 p-3"><p className="text-xs text-muted-foreground">{zh ? '模拟账户' : 'Paper account'}</p><Button asChild size="sm" variant="ghost"><Link to={`/holdings?accountId=${encodeURIComponent(agreement.accountId)}`}>{zh ? '查看持仓与成交' : 'View holdings and fills'}</Link></Button><p className="text-xs text-muted-foreground">{zh ? '保持独立账本' : 'Independent ledger'}</p></div>{agreement.configuration.workPlanProof && <div className="rounded-lg bg-muted/40 p-3"><p className="text-xs text-muted-foreground">{zh ? '研究分工' : 'Research division'}</p><p className="font-medium">{agreement.configuration.workPlanProof.mode === 'blueprint_v1' ? (zh ? '工作蓝图 v1 · 已发布组织分工' : 'Work blueprint v1 · published division') : agreement.configuration.workPlanProof.mode === 'manual_custom' ? (zh ? '仅本次自定义分工' : 'Custom division for this run') : (zh ? '旧版分工：独立研究 + 负责人汇总' : 'Legacy division: independent research plus lead summary')}</p><p className="text-xs text-muted-foreground">{zh ? '协议固定此分工；发布新团队版本后需重新确认运行规则。' : 'The agreement freezes this division; publish a new team version and reconfirm the run rules to change it.'}</p></div>}</div>}
    {agreement?.externalCostUnknown && <p className="text-xs text-amber-700">{zh ? '部分助手的实际费用未知；调用次数受限，上述金额不代表外部账单的保证上限。' : 'Some actual fees are unknown. Calls are bounded; the amounts do not guarantee an external bill cap.'}</p>}
    {agreement?.state === 'suspended' && <p role="alert" className="text-sm">{agreement.suspensionReason === 'AGENT_ARCHIVED_SETTLEMENT_ONLY' ? (zh ? '股友已归档：已停止新研究与自动模拟执行，已派发研究可继续结算。请调整成员后重新确认。' : 'An agent was archived. New research and automatic paper execution stopped; dispatched research may settle. Update members and confirm again.') : (zh ? '团队版本、账户、权限或运行条件已变化，自动工作已停止。请检查后重新确认规则。' : 'Team, account, permissions or run conditions changed. Automatic work stopped. Review the setup and confirm new rules.')}</p>}
    <div><h3 className="font-medium mb-3">{zh ? '最近做了什么' : 'Recent work'}</h3>{!status.data?.recentCycles.length && <p className="text-sm text-muted-foreground">{agreement?.state === 'running' && agreement.configuration.initialRun === 'immediate' ? (zh ? '已启用首轮研究，正在等待调度器领取；后续按每日收盘节奏运行。' : 'First research is enabled and waiting for the scheduler; later research follows the daily close.') : (zh ? '还没有已记录的自动周期。确认启动后按所选首轮方式和每日节奏运行。' : 'No automatic cycle is recorded yet. Confirmed startup follows the selected first-run mode and daily cadence.')}</p>}<ul className="space-y-3">{status.data?.recentCycles.slice(0, 6).map(cycle => <li className="rounded-lg border p-3 text-sm" key={cycle.id}><div className="flex justify-between gap-3"><strong>{cycles[cycle.state] ?? cycle.state}</strong><span>{cycle.tradingDate}</span></div>{cycle.commissionId && <Link className="underline text-primary block mt-2" to={`/teams/${encodeURIComponent(team.id)}?panel=history&commissionId=${encodeURIComponent(cycle.commissionId)}`}>{zh ? '查看原判断与执行记录' : 'View original decision and execution'}</Link>}{cycle.lastError && <details className="text-xs text-muted-foreground mt-2"><summary>{zh ? '处理详情' : 'Details'}</summary>{cycle.lastError}</details>}</li>)}</ul></div>
    <p className="text-xs text-muted-foreground">{zh ? '暂停会停止后续研究及全部模拟交易，包括保护单；在途任务会显示实际取消或结算状态。' : 'Pausing stops future research and all paper trades, including protective orders. In-flight tasks retain their real cancellation or settlement state.'}</p>
    {setup && <div className="space-y-3 border-t pt-4">
      <h3 className="font-semibold">{zh ? '核对运行规则' : 'Review run rules'}</h3>
      <p className="text-sm">{zh ? `每轮最多 ${callLimit} 次调用，包含工作与复核，使单轮研究能有限完成。不额外设置团队每日或每月调用上限，已有全局和账户限制仍生效。` : `Up to ${callLimit} calls/run, including work and reviews, to keep each cycle finite. No extra team daily/monthly call cap; existing global and account limits still apply.`}</p>
      {externalFeesUnknown && <p className="text-sm text-amber-700">{zh ? '本地或外部助手的实际费用未知。本系统限制调用次数，上述金额不能保证服务商账单上限。' : 'Actual local or external fees are unknown. Calls are bounded; the amount cannot guarantee the provider’s bill.'}</p>}
      <label className="flex gap-3 text-sm"><Checkbox aria-label={zh ? '研究金额无上限' : 'No research amount cap'} checked={!amountLimited} disabled={enable.isPending || renew.isPending || Boolean(renewalRecord.current) || Boolean(setupRecord.current) && !reviewRequired} onCheckedChange={value => setAmountLimited(value !== true)} /><span>{zh ? '研究金额无上限，可取消勾选并填写每日上限（USD）。实际费用由所用模型和服务商计费。' : 'No research amount cap. Uncheck to enter a daily USD limit. Models and providers bill actual usage.'}</span></label>
      {amountLimited && <label className="block text-sm space-y-1"><span>{zh ? '每日研究预算上限（USD）' : 'Daily research budget cap (USD)'}</span><Input aria-label={zh ? '每日预算 USD' : 'Daily budget USD'} type="number" min="0.02" value={daily} disabled={enable.isPending || renew.isPending || Boolean(renewalRecord.current) || Boolean(setupRecord.current) && !reviewRequired} onChange={e => setDaily(e.target.value)} /></label>}
      <label className="block text-sm space-y-1"><span>{zh ? '主市场' : 'Main market'}</span><select className="w-full rounded border p-2 bg-background" aria-label={zh ? '主市场' : 'Main market'} value={market} disabled={enable.isPending || renew.isPending || Boolean(renewalRecord.current) || Boolean(setupRecord.current) && !reviewRequired} onChange={e => setMarket(e.target.value as TradingMarket)}>{['CN', 'HK', 'US'].map(m => <option key={m}>{m}</option>)}</select></label>
      <label className="flex gap-3 text-sm"><Checkbox aria-label={zh ? '启动时先研究一轮' : 'Research once at startup'} checked={immediate} disabled={enable.isPending || renew.isPending || Boolean(renewalRecord.current) || Boolean(setupRecord.current) && !reviewRequired} onCheckedChange={value => setImmediate(value === true)} /><span>{zh ? '启动时先研究一轮，之后每个主市场交易日收盘后一小时研究。' : 'Research once at startup, then one hour after each main-market trading close.'}</span></label>
      {!preview && !reviewRequired && <Button disabled={!canSetup || renew.isPending || enable.isPending} onClick={() => renew.mutate()}>{renew.isPending ? (zh ? '正在读取预览…' : 'Reading preview…') : (zh ? '预览运行规则' : 'Preview run rules')}</Button>}
      {(reviewRequired || expired && !confirmAttempted.current) && <div className="space-y-2 text-sm" role="alert"><p>{zh ? '预览已过期或运行条件变化，请重新读取并确认。' : 'The preview expired or run conditions changed. Refresh it and confirm again.'}</p><Button variant="outline" disabled={!canSetup || renew.isPending || enable.isPending} onClick={() => renew.mutate()}>{zh ? '重新核对运行规则' : 'Refresh run review'}</Button></div>}
      {preview && !reviewRequired && <>
        <RunReview preview={preview} zh={zh} />
        {!confirmAttempted.current && <Button variant="ghost" disabled={enable.isPending || renew.isPending} onClick={() => { setupRecord.current = null; renewalRecord.current = null; setPreview(null); setAck(false); setError(''); }}>{zh ? '修改运行选项' : 'Edit run options'}</Button>}
        <label className="flex gap-3 text-sm"><Checkbox aria-label={zh ? '确认已核对的运行规则' : 'Confirm reviewed run rules'} checked={ack} disabled={enable.isPending || expired && !confirmAttempted.current} onCheckedChange={value => setAck(value === true)} /><span>{zh ? '我已核对以上实际成员、模拟账户、额度和首轮方式，允许在此范围内自动研究与模拟交易；新判断将替换此模拟账户的执行组合，保留我的草稿。' : 'I confirm scope, the actual members, paper account, limits and startup mode above, and allow automatic research and paper trades. New decisions replace this paper account’s execution combination and preserve my drafts.'}</span></label>
        <Button disabled={!canSetup || !ack || enable.isPending || renew.isPending || expired && !confirmAttempted.current} onClick={() => enable.mutate()}>{enable.isPending ? (zh ? '正在核对…' : 'Checking…') : (zh ? '确认并启动' : 'Confirm and start')}</Button>
      </>}
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}

/** Render the exact server-reviewed agreement rather than the editable proposed values. */
function RunBudgetLimits({ budget, zh }: { budget: TeamRunAgreement['configuration']['budget']; zh: boolean }) {
  const money = (value: string | null): string => value === null ? (zh ? '无金额上限' : 'No amount cap') : `${value} USD`;
  const calls = (value: number | null): string => value === null ? (zh ? '无周期上限' : 'No period cap') : String(value);
  return <div className="space-y-1">
    <p>{money(budget.perRun.ceiling.amount)} / {zh ? '轮' : 'run'} · {money(budget.daily.costUsd)} / {zh ? '日' : 'day'} · {money(budget.monthly.costUsd)} / {zh ? '月' : 'month'}</p>
    <p>{zh ? '调用上限：' : 'Call limits: '}{budget.perRun.callLimit}/{zh ? '轮' : 'run'} · {calls(budget.daily.calls)}/{zh ? '日' : 'day'} · {calls(budget.monthly.calls)}/{zh ? '月' : 'month'}</p>
  </div>;
}

function RunReview({ preview, zh }: { preview: TeamRunAgreementPreview; zh: boolean }) {
  const { configuration, accountId, members } = preview.result;
  return <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-2" aria-label={zh ? '本次实际运行规则' : 'Actual reviewed run rules'}>
    <p>{zh ? '已核对成员：' : 'Reviewed members: '}{members.map(member => member.label).join(' · ')}</p>
    <p><Link className="underline" to={`/holdings?accountId=${encodeURIComponent(accountId)}`}>{zh ? '查看本次模拟账户' : 'Review this paper account'}</Link> · {accountId}</p>
    <p>{configuration.initialRun === 'immediate' ? (zh ? '启动时先研究一轮' : 'First research at startup') : (zh ? '首轮等待下一个有效收盘研究窗口' : 'First research at the next valid after-close window')}</p>
    <p>{zh ? `主市场 ${configuration.market} · 每个交易日收盘后 ${configuration.cadence.delayMinutes} 分钟研究。` : `${configuration.market} · Research ${configuration.cadence.delayMinutes} minutes after each trading close.`}</p>
    <RunBudgetLimits budget={configuration.budget} zh={zh} />
    <p>{zh ? '仅使用已授权资料和工具，遵守账户风险规则。支持的策略会自动应用到此模拟账户；成交须符合开市时段、行情与风控条件，不保证每轮都会交易。' : 'Use authorized data and tools and the account risk rules. Supported strategies apply automatically to this paper account; fills require valid market sessions, quotes and risk checks. A research cycle may produce no trade.'}</p>
  </div>;
}
