import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { agentRosterApi } from '@/api/agent-roster';
import { fetchModelConnections } from '@/api/model-connections';
import { previewAiInvestment } from '@/api/ai-investment';
import type { AiInvestmentPreview } from '@shared/investment-policy.interface';
import type { TradingMarket } from '@shared/trading-market.interface';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { friendlyError } from '@/utils/error-message';
import { GUIDED_TEAM_KEY, executeGuidedTeam, readGuidedTeam, refreshGuidedTeamReview, validateGuidedTeamStart, GuidedTeamReviewRequired, GuidedTeamValidationError, type GuidedTeamRecord } from './guided-team-create';

import { guidedSeedBlockers } from './guided-team-state';

export default function GuidedTeamCreate() {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh'); const navigate = useNavigate(); const query = useQueryClient();
  const roster = useQuery({ queryKey: ['agent-roster'], queryFn: agentRosterApi.list });
  const models = useQuery({ queryKey: ['settings', 'model-connections'], queryFn: fetchModelConnections });
  const [step, setStep] = useState(1); const [name, setName] = useState(zh ? '我的研究团队' : 'My research team');
  const [selected, setSelected] = useState<string[] | null>(null); const [preview, setPreview] = useState<AiInvestmentPreview | null>(null);
  const [daily, setDaily] = useState('2'); const [market, setMarket] = useState<TradingMarket>('CN');
  const [ack, setAck] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [phase, setPhase] = useState('');
  const record = useRef<GuidedTeamRecord | null>(readGuidedTeam()); const lock = useRef(false); const key = useRef(crypto.randomUUID());
  const seedIntent = useRef<string | null>(null);
  const agents = roster.data?.items?.filter(a => a.status === 'active') ?? [];
  const defaults = ['financials', 'bear', 'moderator'].flatMap(id => agents.find(a => a.currentVersion.config.templateId === id) ?? []);
  const chosen = selected === null ? (defaults.length ? defaults : agents.slice(0, 3)) : agents.filter(a => selected.includes(a.id));
  const frozen = Boolean(record.current);
  async function review() {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try {
      if (record.current) { setPreview(record.current.preview); setStep(3); return; }
      if (!chosen.length || chosen.length > 4) throw new Error(zh ? '请先选择1至4位股友；推荐3位，适合默认调用额度。' : 'Choose one to four agents; three fit the default call budget.');
      seedIntent.current ??= `${key.current}:seed:${crypto.randomUUID()}`;
      const value = await previewAiInvestment({ origin: 'holdings', requestKey: seedIntent.current }); seedIntent.current = null; setPreview(value); const suggested = value.markets[0]; if (suggested === 'US' || suggested === 'HK' || suggested === 'CN') setMarket(suggested); setStep(3); }
    catch (failure) { setError(friendlyError(failure, zh, { zh: '持仓快照尚未准备好，请核对持仓、现金和报价后继续。', en: 'The holdings snapshot is not ready. Check holdings, cash and quotes, then continue.' })); }
    finally { setBusy(false); lock.current = false; }
  }
  async function start() {
    if (lock.current || !ack) return; lock.current = true; setBusy(true); setError('');
    try {
      if (!record.current) {
        if (!preview) throw new Error('Preview required');
        const candidate: GuidedTeamRecord = { version: 1, key: key.current, name: name.trim(), agents: chosen, models: models.data ?? [], preview, market, dailyUsd: daily, language: zh ? 'zh-CN' : 'en' };
        validateGuidedTeamStart(candidate); record.current = candidate;
      }
      const id = await executeGuidedTeam(record.current, (value, next) => { record.current = value; sessionStorage.setItem(GUIDED_TEAM_KEY, JSON.stringify(value)); setPhase(next); });
      sessionStorage.removeItem(GUIDED_TEAM_KEY); await query.invalidateQueries({ queryKey: ['teams'] }); navigate(`/teams/${id}`);
    } catch (failure) {
      if (failure instanceof GuidedTeamReviewRequired) { setAck(false); setError(failure.stage === 'changed' ? (zh ? '团队或账户已被其他操作修改。为避免启动错误配置，请打开已创建的团队核对并继续。' : 'The team or account changed elsewhere. Open the existing team to review its configuration before continuing.') : (zh ? '预览已过期或条件已变化。已完成步骤保留，请先重新核对，再确认继续。' : 'A preview expired or its conditions changed. Completed steps are retained; refresh the review before confirming again.')); }
      else if (failure instanceof GuidedTeamValidationError) {
        const messages = { name: [ '请输入1至60字的团队名称。', 'Enter a team name of 1–60 characters.' ], budget: [ '请输入0.02至1000之间的每日美元预算。', 'Enter a daily USD budget between 0.02 and 1000.' ], members: [ '请选择1至4位不同股友；推荐3位。', 'Choose one to four different agents; three are recommended.' ], connection: [ '有股友尚未连接。请回到“我的股友”修复连接后继续。', 'An agent needs a connection. Open My agents to restore it before continuing.' ], holdings: [ '请先补齐持仓、现金总额和最新报价，再重新核对。', 'Complete holdings, cash totals and current quotes, then refresh the review.' ] };
        setError(messages[failure.code][zh ? 0 : 1]);
      } else setError(friendlyError(failure, zh, { zh: '启动尚未完成，已完成步骤已保存。点击“核对并继续”会使用原请求，不会重新建队。', en: 'Startup is incomplete. Completed steps are saved. Check and continue reuses the original requests.' })); }
    finally { setBusy(false); lock.current = false; }
  }
  async function refreshReview() {
    if (!record.current || lock.current) return;
    lock.current = true; setBusy(true); setAck(false); setError('');
    try {
      await refreshGuidedTeamReview(record.current, (value, next) => { record.current = value; sessionStorage.setItem(GUIDED_TEAM_KEY, JSON.stringify(value)); setPhase(next); });
      setPreview(record.current.preview); setStep(3);
    } catch (failure) { setError(friendlyError(failure, zh, { zh: '核对尚未完成，原进度保留。请重试读取，或打开已创建的团队处理变化。', en: 'Review is incomplete and progress is retained. Retry, or open the existing team to resolve changes.' })); }
    finally { setBusy(false); lock.current = false; }
  }
  const seedBlockers = guidedSeedBlockers(preview?.needsInput ?? []);
  const gapLabels: Record<string, string> = zh ? { CASH_UNKNOWN: '确认现金总额', QUOTE_MISSING: '补齐最新报价', FX_MISSING: '补齐汇率', INSTRUMENT_UNKNOWN: '核对证券身份', NEGATIVE_OR_INVALID: '修正无效持仓或金额', IMPORT_HOLDINGS_OR_CHOOSE_CASH: '先导入持仓' } : { CASH_UNKNOWN: 'Confirm cash totals', QUOTE_MISSING: 'Refresh quotes', FX_MISSING: 'Complete FX rates', INSTRUMENT_UNKNOWN: 'Verify securities', NEGATIVE_OR_INVALID: 'Correct invalid holdings or amounts', IMPORT_HOLDINGS_OR_CHOOSE_CASH: 'Import holdings first' };
  const dailyValid = Number.isFinite(Number(daily)) && Number(daily) >= 0.02 && Number(daily) <= 1000;
  const phases: Record<string, string> = zh ? { team: '创建团队', members: '关联已有股友', publish: '保存团队版本', account: '创建持仓副本', binding: '关联模拟账户', agreement: '核对运行规则', start: '启动自动运行', done: '已完成' } : { team: 'Creating team', members: 'Linking existing agents', publish: 'Saving version', account: 'Copying holdings', binding: 'Linking account', agreement: 'Checking run agreement', start: 'Starting automation', done: 'Done' };
  return <main className="max-w-3xl mx-auto p-4 sm:p-6 space-y-6"><header><Link className="text-sm underline text-muted-foreground" to="/teams">{zh ? '返回团队列表' : 'Back to teams'}</Link><h1 className="text-2xl font-semibold mt-3">{zh ? '创建自己的团队' : 'Create your team'}</h1><p className="text-muted-foreground mt-2">{zh ? '选择成员，复制持仓，确认一次后让团队自动工作。' : 'Choose agents, copy holdings, and confirm once to let the team work.'}</p></header>
    <ol className="flex flex-wrap gap-3 text-sm" aria-label={zh ? '创建进度' : 'Setup progress'}>{[zh ? '协作方式' : 'Approach', zh ? '已有股友' : 'Existing agents', zh ? '核对并启动' : 'Review and start'].map((label, i) => <li key={label} className={`rounded-full px-3 py-1 ${step === i + 1 ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>{i + 1} {label}</li>)}</ol>
    {record.current && !busy && <section className="rounded-xl border bg-muted/30 p-4 space-y-3"><p>{zh ? `已保存“${record.current.name}”的创建进度，可以继续核对原任务。` : `Saved progress for “${record.current.name}” is ready to resume.`}</p><Button onClick={() => { setAck(false); setStep(3); setPreview(record.current!.preview); setName(record.current!.name); setDaily(record.current!.dailyUsd); setMarket(record.current!.market); setSelected(record.current!.agents.map(a => a.id)); }}>{zh ? '恢复创建进度' : 'Restore progress'}</Button>{record.current.teamId && <Button variant="outline" asChild><Link to={`/teams/${record.current.teamId}`}>{zh ? '查看已创建的团队' : 'View existing team'}</Link></Button>}</section>}
    {step === 1 && <section className="rounded-xl border bg-card p-5 space-y-5"><div><h2 className="font-semibold">{zh ? '推荐：共同研究，反方核查，主持收束' : 'Recommended: research, challenge, and synthesis'}</h2><p className="text-sm text-muted-foreground mt-2">{zh ? '系统安排有限分工和复核，组织画布与依赖可在创建后高级编辑。' : 'The system provides bounded work and review. Edit the organization and dependencies later if needed.'}</p></div><div className="space-y-2"><Label htmlFor="guided-name">{zh ? '团队名称' : 'Team name'}</Label><Input id="guided-name" value={name} onChange={e => setName(e.target.value)} maxLength={60} disabled={frozen} /></div><Button disabled={!name.trim()} onClick={() => setStep(2)}>{zh ? '下一步：确认股友' : 'Next: choose agents'}</Button><Link className="block text-sm underline" to="/teams?advanced=1&create=1">{zh ? '高级：使用组织模板或自由编辑' : 'Advanced: organization templates or custom layout'}</Link></section>}
    {step === 2 && <section className="rounded-xl border bg-card p-5 space-y-4"><h2 className="font-semibold">{zh ? '从我的股友中选择成员' : 'Choose from your agents'}</h2><p className="text-sm text-muted-foreground">{zh ? '推荐3位，最多4位；默认额度包含每位的研究与复核。更大团队可稍后在高级编辑中调整。' : 'Three are recommended, up to four. The default budget covers work and review; use advanced editing for a larger team.'}</p>{roster.isPending && <p role="status">{zh ? '正在读取…' : 'Loading…'}</p>}{roster.isError && <p role="alert">{zh ? '名单暂时无法读取，请刷新。' : 'The roster could not be loaded. Please reload.'}</p>}<div className="space-y-3">{agents.map(agent => <label key={agent.id} className="flex gap-3 items-start rounded-lg border p-3"><Checkbox checked={chosen.some(a => a.id === agent.id)} disabled={frozen || (chosen.length >= 4 && !chosen.some(a => a.id === agent.id))} onCheckedChange={checked => { const current = chosen.map(a => a.id); setSelected(checked ? [...new Set([...current, agent.id])].slice(0, 4) : current.filter(id => id !== agent.id)); }} /><div><strong>{agent.name}</strong><p className="text-sm text-muted-foreground">{agent.specialty}</p></div></label>)}</div><Link className="text-sm underline" to="/friends">{zh ? '先添加或调整股友' : 'Add or edit agents first'}</Link><div className="flex gap-2"><Button variant="outline" onClick={() => setStep(1)}>{zh ? '上一步' : 'Back'}</Button><Button disabled={busy || !chosen.length || models.isPending} onClick={() => void review()}>{busy ? (zh ? '正在核对持仓…' : 'Reviewing holdings…') : (zh ? '下一步：核对启动规则' : 'Next: review startup')}</Button></div></section>}
    {step === 3 && preview && <section className="rounded-xl border bg-card p-5 space-y-4"><h2 className="font-semibold">{zh ? '最后核对一次，然后启动' : 'Review once, then start'}</h2><p className="text-sm">{zh ? '本次成员：' : 'Agents: '}{(record.current?.agents ?? chosen).map(agent => agent.name).join(' · ')}</p><div className="rounded-lg bg-muted/40 p-4 text-sm space-y-2"><p>{zh ? '模拟起点：' : 'Simulation starts with: '}{preview.seed.positions.length} {zh ? '项持仓' : 'positions'} · {zh ? '快照时间' : 'Snapshot'} {new Date(preview.seed.capturedAt).toLocaleString(i18n.language)}</p><p>{zh ? '现金总额：' : 'Cash total: '}{preview.seed.cash.map(c => `${c.total} ${c.currency}`).join(' · ') || (zh ? '尚未确认' : 'Unconfirmed')}</p><p>{zh ? '模拟开盘：以上持仓全部可卖，以上现金总额全部作为可用虚拟现金。' : 'At the simulated opening, all copied holdings are sellable and the reviewed cash totals are available virtual cash.'}</p><p>{zh ? '独立运行：实盘后续变化不会覆盖模拟账本。' : 'The simulation keeps its own ledger; later real-portfolio changes do not overwrite it.'}</p><p>{zh ? '工作范围：已授权资料与只读工具；遵守账户仓位规则，自动研究并进行模拟交易。启动前会校验权限。' : 'Scope: authorized data and read-only tools, account risk rules, autonomous research and paper trades. Permissions are checked before startup.'}</p><p>{zh ? '运行节奏：主市场每个交易日收盘后一小时研究，模拟执行遵守各标的交易时段。' : 'Research runs one hour after each main-market trading close; paper execution respects each instrument’s market.'}</p></div>
      {!record.current?.accountId && seedBlockers.length > 0 && <p role="alert" className="text-destructive text-sm">{zh ? '需要先补齐：' : 'Complete first: '}{[...new Set(seedBlockers.map(code => gapLabels[code.split(':')[0]] ?? (zh ? '核对资产资料' : 'Review asset details')))].join(zh ? '、' : ', ')} <Link className="underline" to="/holdings?accountId=real">{zh ? '去核对资产' : 'Review assets'}</Link></p>}
      <div className="space-y-2"><Label htmlFor="guided-market">{zh ? '主市场' : 'Main market'}</Label><select id="guided-market" className="border rounded-md p-2 w-full bg-background" value={market} onChange={e => setMarket(e.target.value as TradingMarket)} disabled={frozen}>{[['CN', zh ? '中国 A 股' : 'China A shares'], ['HK', zh ? '香港' : 'Hong Kong'], ['US', zh ? '美国' : 'United States']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      <div className="space-y-2"><Label htmlFor="guided-budget">{zh ? '每日研究预算（USD）' : 'Daily research budget (USD)'}</Label><Input id="guided-budget" value={daily} type="number" min="0.02" max="1000" step="0.1" onChange={e => setDaily(e.target.value)} disabled={frozen} /><p className="text-xs text-muted-foreground">{zh ? '每次最多使用每日额度的一半；月度上限为每日额度的20倍。同时限制单次8、每日16、每月320次调用。' : 'Each run reserves at most half the daily amount; the monthly cap is 20 daily amounts. Calls are capped at 8/run, 16/day and 320/month.'}</p></div>
      {(record.current?.agents ?? chosen).some(a => a.currentVersion.config.executor.executionMode !== 'model') && <p className="text-sm text-amber-700">{zh ? '本地/外部助手未提供完整费用。本系统只能准确限制调用次数，实际费用由服务商计费，不能保证上述金额是实际账单上限。' : 'Local/external fees are incomplete. Only call counts are reliably bounded here; the provider bills actual usage, so the amounts above cannot guarantee its bill.'}</p>}
      <label className="flex items-start gap-3 text-sm"><Checkbox checked={ack} onCheckedChange={value => setAck(value === true)} /><span>{zh ? '我已确认以上模拟起点、成员、资料范围和费用方式，允许在上述规则内自动研究与模拟交易；新判断将替换此模拟账户现有的执行组合，保留我的草稿。可随时暂停全部自动运行，包括保护单。' : 'I confirmed the simulated opening above, members, data scope and billing limits, and allow research and paper trading within these rules. New decisions replace this paper account’s execution combination while preserving my drafts. I can pause all automation, including protective orders.'}</span></label>
      <div className="flex gap-2">{!frozen && <Button variant="outline" disabled={busy} onClick={() => setStep(2)}>{zh ? '上一步' : 'Back'}</Button>}<Button disabled={!ack || busy || !dailyValid || Boolean(record.current?.reviewRequired) || (!record.current?.accountId && seedBlockers.length > 0)} onClick={() => void start()}>{busy ? (phases[phase] ?? (zh ? '正在核对…' : 'Checking…')) : frozen ? (zh ? '核对并继续' : 'Check and continue') : (zh ? '启动我的团队' : 'Start my team')}</Button></div></section>}
    {record.current?.reviewRequired && record.current.reviewRequired !== 'changed' && <section className="rounded-xl border p-4 space-y-3"><p className="text-sm">{zh ? '重新核对只准备新的预览，不会重复创建团队或模拟账户。请阅读更新后的内容，再勾选确认。' : 'Refreshing prepares a new review and does not duplicate your team or paper account. Read the updated review, then confirm again.'}</p><Button disabled={busy} onClick={() => void refreshReview()}>{busy ? (zh ? '正在重新核对…' : 'Refreshing review…') : (zh ? '重新核对并保留进度' : 'Refresh review and keep progress')}</Button></section>}
    {error && <div role="alert" className="rounded-xl border border-destructive/30 p-4 text-sm text-destructive">{error}</div>}
  </main>;
}
