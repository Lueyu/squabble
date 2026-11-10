import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { fetchDailyWorkspace } from '@/api/workspace';
import { fetchResearchDocument } from '@/api/research-documents';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import ResearchMarkdown from '@/components/ResearchMarkdown';
import CouncilMemberAvatar from '@/pages/Council/CouncilMemberAvatar';
import { readableResearchSections } from '@shared/research-reading';
import type { DailyAccountFacts } from '@shared/daily-workspace.interface';
import ReportHistory from './ReportHistory';
import OverallDailyResearch from './OverallDailyResearch';
import '../Workspace/workspace-v4.css';

const money = (value: number | null | undefined, language: string) =>
  value == null
    ? '—'
    : new Intl.NumberFormat(language, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2,
      }).format(value);
const statusLabel = (status: string, zh: boolean) =>
  zh
    ? ((
        {
          running: '运行中',
          paused: '已暂停',
          archived: '已归档',
          pending: '待处理',
          pending_approval: '待确认',
          failed: '失败',
          rejected: '未通过',
          cancelled: '已取消',
          filled: '已成交',
          buy: '买入',
          sell: '卖出',
        } as Record<string, string>
      )[status] ?? status)
    : status;
const number = (value: number | null) =>
  value == null ? '—' : value.toLocaleString();
export default function DailyReportPage() {
  const { i18n } = useTranslation(),
    zh = i18n.language.startsWith('zh');
  const [params, setParams] = useSearchParams();
  const date = params.get('date') || undefined;
  const [layer, setLayer] = useState<'personal' | string | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['daily-workspace', date],
    queryFn: () => fetchDailyWorkspace(date),
  });
  const view = query.data;
  const selected = view?.accounts.find((account) => account.id === layer);
  const report = view?.reports.initial;
  const fills = view?.accounts.reduce(
    (sum, account) => sum + account.trades.length,
    0,
  );
  const skipped = view?.accounts.reduce(
    (sum, account) => sum + account.notExecuted.length,
    0,
  );
  return (
    <section className="workspace-v4">
      <header className="workspace-v4-header">
        <div>
          <h1>{zh ? '今天的投资总结' : 'Your investment day'}</h1>
          <p className="muted">
            {view?.date} ·{' '}
            {zh
              ? '总体日报 · 个人账本与各模拟仓分开呈现'
              : 'Daily overview · Real and simulation accounts remain separate'}
          </p>
        </div>
        <label className="text-sm">
          {zh ? '查看日期' : 'Date'}
          <Input
            type="date"
            value={date ?? view?.date ?? ''}
            onChange={(event) =>
              setParams(event.target.value ? { date: event.target.value } : {})
            }
          />
        </label>
      </header>
      {query.isPending && (
        <p role="status">
          {zh ? '正在核对已记录的事实…' : 'Reading saved facts…'}
        </p>
      )}
      {query.isError && (
        <div role="alert" className="workspace-v4-card">
          <p>
            {zh
              ? '日报暂时无法读取。已保存报告仍可从下方历史查看。'
              : 'Daily facts are unavailable. Saved reports remain in history below.'}
          </p>
          <Button onClick={() => void query.refetch()}>
            {zh ? '重试' : 'Retry'}
          </Button>
        </div>
      )}
      {view && (
        <>
          <section className="workspace-v4-card workspace-v4-banner">
            <div className="workspace-v4-identity">
              <CouncilMemberAvatar
                avatar="moderator"
                role="manager"
                className="size-12"
              />
              <h3>{zh ? '先看今天发生了什么' : 'What happened today'}</h3>
            </div>
            <p>
              {zh
                ? `个人账本当日净收益 ${money(view.personal.returnBasis.pnlUsd, i18n.language)}；${view.accounts.length} 个独立模拟仓记录了 ${fills} 笔实际成交。${skipped} 笔当日创建的委托当前未执行。`
                : `Real ledger daily profit: ${money(view.personal.returnBasis.pnlUsd, i18n.language)}. ${view.accounts.length} independent simulations recorded ${fills} fills; ${skipped} orders created that day are now unexecuted.`}
            </p>
            <p className="muted">
              {zh
                ? '缺失数字以 — 显示。事实来自当前已保存账本，历史研究按当时版本保留。'
                : 'Missing values stay unknown. Facts read the saved ledger; research retains its original version.'}
            </p>
          </section>
          <dl className="workspace-v4-stats">
            {[
              [
                zh ? '实仓日期快照' : 'Real saved equity',
                money(
                  view.personal.returnBasis.endSnapshot?.accountValue,
                  i18n.language,
                ),
              ],
              [
                zh ? '实仓当日净收益' : 'Real daily profit',
                money(view.personal.returnBasis.pnlUsd, i18n.language),
              ],
              [zh ? '模拟实际成交' : 'Simulation fills', fills],
              [zh ? '未执行委托' : 'Unexecuted orders', skipped],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <OverallDailyResearch
            key={view.date}
            date={view.date}
            onEvidence={setReportId}
          />
          <section className="space-y-4">
            <h2>{zh ? '股友分别做了什么' : 'Each stock friend’s day'}</h2>
            <div className="workspace-v4-grid workspace-v4-grid-three">
              {view.accounts.map((account) => (
                <article className="workspace-v4-card" key={account.id}>
                  <div className="workspace-v4-identity">
                    <CouncilMemberAvatar
                      avatar={account.companionId ?? undefined}
                      role={account.companionId ? 'researcher' : 'user'}
                      className="size-12"
                    />
                    <div>
                      <h3>{account.name}</h3>
                      <p className="muted">
                        {zh
                          ? '模拟账户 · 当前状态'
                          : 'Simulation · Current status'}
                        : {statusLabel(account.status, zh)}
                      </p>
                    </div>
                  </div>
                  <p>
                    {zh ? '当日已记录收益' : 'Saved daily profit'}{' '}
                    {money(account.dailyPnlUsd, i18n.language)}
                    <br />
                    {zh ? '成交' : 'Fills'} {account.trades.length} ·{' '}
                    {zh ? '未执行委托' : 'Unexecuted orders'}{' '}
                    {account.notExecuted.length}
                  </p>
                  {!!account.gaps.length && (
                    <p className="text-sm text-amber-700 dark:text-amber-300">
                      {zh
                        ? '估值或成交资料有缺口，展开核对。'
                        : 'Valuation or fill data has gaps. Open to inspect.'}
                    </p>
                  )}
                  <Button
                    variant="outline"
                    onClick={() => setLayer(account.id)}
                  >
                    {zh ? '看交易日报' : 'Read trading daily'}
                  </Button>
                </article>
              ))}
            </div>
            {!view.accounts.length && (
              <p className="muted">
                {zh
                  ? '该日期尚无模拟账户。'
                  : 'No simulation accounts existed on this date.'}
              </p>
            )}
          </section>
          <section className="workspace-v4-card">
            <h2>
              {zh
                ? '对我的真实持仓意味着什么'
                : 'What it means for my real portfolio'}
            </h2>
            {report?.summary ? (
              <ResearchMarkdown>{report.summary}</ResearchMarkdown>
            ) : (
              <p>
                {zh
                  ? '这一天尚无可读取的持仓研究。先查看账本事实，或到研究页明确发起分析。'
                  : 'No readable portfolio research is saved for this day. Inspect ledger facts or explicitly start research.'}
              </p>
            )}
            <div className="workspace-v4-actions">
              <Button variant="outline" onClick={() => setLayer('personal')}>
                {zh ? '查看账本与流水事实' : 'Inspect ledger facts'}
              </Button>
              {report?.documentId && (
                <Button
                  variant="outline"
                  onClick={() => setReportId(report.documentId)}
                >
                  {zh ? '展开研究与依据' : 'Read research and evidence'}
                </Button>
              )}
              <Button variant="ghost" asChild>
                <Link to="/analysis">
                  {zh ? '持仓研究' : 'Portfolio research'}
                </Link>
              </Button>
            </div>
          </section>
          <section className="workspace-v4-grid">
            <article className="workspace-v4-card">
              <h2>
                {zh ? '保留讨论中的变化与分歧' : 'Discussion and differences'}
              </h2>
              {view.reports.latestDiscussion ? (
                <>
                  <ResearchMarkdown>
                    {view.reports.latestDiscussion.summary ??
                      view.reports.latestDiscussion.content}
                  </ResearchMarkdown>
                  <Button
                    variant="outline"
                    onClick={() =>
                      setReportId(
                        view.reports.latestDiscussion?.documentId ?? null,
                      )
                    }
                  >
                    {zh ? '查看这轮讨论' : 'Inspect discussion'}
                  </Button>
                </>
              ) : (
                <p className="muted">
                  {zh
                    ? '这一天没有另行发布的讨论报告。'
                    : 'No separate discussion report was published that day.'}
                </p>
              )}
            </article>
            <article className="workspace-v4-card">
              <h2>{zh ? '下一步观察什么' : 'What to watch next'}</h2>
              {report?.nextChecks?.length ? (
                <ul className="list-disc pl-5 space-y-2">
                  {report.nextChecks.map((check) => (
                    <li key={check}>{check}</li>
                  ))}
                </ul>
              ) : (
                <p className="muted">
                  {zh
                    ? '尚无已保存的后续观察结论；可先核对缺失的估值和资料。'
                    : 'No saved next checks. Review missing valuations and source material first.'}
                </p>
              )}
              <Button variant="outline" asChild>
                <Link to="/journal">
                  {zh ? '打开复盘笔记' : 'Open journal'}
                </Link>
              </Button>
            </article>
          </section>
          <section className="workspace-v4-card">
            <h2>{zh ? '这份日报的口径' : 'How to read this daily'}</h2>
            <p className="muted">
              {zh
                ? `账本读取于 ${new Date(view.readAt).toLocaleString(i18n.language)}，按 Asia/Shanghai 归日。模拟成交来自实际成交记录；未执行为当日创建委托的当前状态，未包含没有产生委托的观察。各仓估值为各自保存截点，未将实仓与模拟资金相加。`
                : `Ledger read at ${new Date(view.readAt).toLocaleString(i18n.language)}, grouped by Asia/Shanghai. Fills use the fill ledger. Unexecuted orders use the current status of orders created that day; observations without an order are excluded. Account valuations retain their own timestamps.`}
            </p>
          </section>
        </>
      )}
      <ReportHistory key={date ?? 'all'} date={date} />
      <Dialog
        open={Boolean(layer)}
        onOpenChange={(open) => {
          if (!open) setLayer(null);
        }}
      >
        <DialogContent className="workspace-v4-dialog sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {selected?.name ?? (zh ? '个人账本事实' : 'Real ledger facts')}
            </DialogTitle>
            <DialogDescription>
              {zh
                ? '关闭后继续阅读原日报。数字来自保存记录。'
                : 'Close to continue reading. Figures come from saved records.'}
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <AccountDaily account={selected} language={i18n.language} />
          )}
          {layer === 'personal' && view && (
            <div className="space-y-4">
              <p>
                {zh
                  ? '个人收益口径：期末权益 − 期初权益 − 外部净入金，费用已包含在账本内。'
                  : 'Real return basis: ending equity − opening equity − external net flows. Recorded fees are included.'}
              </p>
              <div className="workspace-v4-table">
                <table>
                  <thead>
                    <tr>
                      {[
                        '日期 / Date',
                        '标的 / Symbol',
                        '类型 / Type',
                        '数量 / Quantity',
                        '费用 / Fees',
                      ].map((title) => (
                        <th key={title}>{title}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {view.personal.transactions.map((row) => (
                      <tr key={row.id}>
                        <td>{row.date}</td>
                        <td>{row.ticker}</td>
                        <td>{row.type}</td>
                        <td>{number(row.shares)}</td>
                        <td>
                          {number(row.fees)} {row.currency}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!view.personal.transactions.length && (
                <p>
                  {zh
                    ? '当日没有已记录流水。'
                    : 'No ledger transactions recorded that day.'}
                </p>
              )}
              <ul className="list-disc pl-5 text-sm text-muted-foreground">
                {view.personal.gaps.map((gap) => (
                  <li key={gap}>{gap}</li>
                ))}
              </ul>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(reportId)}
        onOpenChange={(open) => {
          if (!open) setReportId(null);
        }}
      >
        <DialogContent className="workspace-v4-dialog sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {zh ? '当时的研究与依据' : 'Research and evidence at the time'}
            </DialogTitle>
            <DialogDescription>
              {zh
                ? '读取固定版本；关闭后回到原日报。'
                : 'An exact saved version. Close to return to your daily.'}
            </DialogDescription>
          </DialogHeader>
          {reportId && <SavedEvidence versionId={reportId} />}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function AccountDaily({
  account,
  language,
}: {
  account: DailyAccountFacts;
  language: string;
}) {
  const zh = language.startsWith('zh');
  return (
    <div className="space-y-5">
      <p>
        {zh ? '前日保存权益' : 'Previous saved equity'}{' '}
        {money(account.openingEquityUsd, language)}
        <br />
        {zh ? '当日保存权益' : 'Saved equity'}{' '}
        {money(account.equityUsd, language)} · {zh ? '现金' : 'Cash'}{' '}
        {money(account.cashUsd, language)}
        <br />
        {zh ? '估值截至' : 'Valued at'}{' '}
        {account.valuationAsOf
          ? new Date(account.valuationAsOf).toLocaleString(language)
          : '—'}
      </p>
      <h3 className="font-semibold">
        {zh ? '实际成交与费用' : 'Actual fills and fees'}
      </h3>
      <div className="workspace-v4-table">
        <table>
          <thead>
            <tr>
              {(zh
                ? ['成交时间', '标的', '方向', '数量', '价格', '费用']
                : ['Executed', 'Symbol', 'Side', 'Quantity', 'Price', 'Fee']
              ).map((title) => (
                <th key={title}>{title}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {account.trades.map((trade) => (
              <tr key={trade.id}>
                <td>
                  {new Date(trade.executedAt).toLocaleTimeString(language, {
                    timeZone: 'Asia/Shanghai',
                  })}
                </td>
                <td>{trade.ticker}</td>
                <td>{statusLabel(trade.side, zh)}</td>
                <td>{number(trade.quantity)}</td>
                <td>
                  {number(trade.price)} {trade.currency ?? '—'}
                </td>
                <td>
                  {number(trade.fee)} {trade.feeCurrency}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!account.trades.length && (
        <p>
          {zh ? '当日没有实际模拟成交。' : 'No simulation fills on this day.'}
        </p>
      )}
      {account.notExecuted.map((order) => (
        <div className="rounded-lg border p-3" key={order.id}>
          <strong>
            {order.ticker} · {statusLabel(order.status, zh)}
          </strong>
          <p>{order.reason ?? (zh ? '原因未记录' : 'Reason not recorded')}</p>
        </div>
      ))}
      {!!account.gaps.length && (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          {account.gaps
            .map(
              (gap) =>
                ({
                  DAILY_BASELINE_MISSING: zh
                    ? '缺少精确前日估值，日收益未知。'
                    : 'Exact prior-day valuation is missing; daily profit is unknown.',
                  DAILY_RECONCILIATION_REQUIRED: zh
                    ? '保存收益与相邻权益尚未对齐，日收益待核对。'
                    : 'Saved profit does not reconcile to neighboring equity; review is required.',
                  VALUATION_TIME_UNKNOWN: zh
                    ? '缺少可信估值时间，日收益未知。'
                    : 'Valuation time is unknown; daily profit is unknown.',
                  VALUATION_DAY_DIFFERS: zh
                    ? `账户估值按 ${account.valuationTimezone} 归日，与日报日界不同，未混用日收益。`
                    : `Valuations use ${account.valuationTimezone}; their daily return cannot be mixed with this report day.`,
                  FILL_AFTER_VALUATION: zh
                    ? '估值后还有成交，日收益需要更新估值。'
                    : 'A fill followed valuation; daily profit needs a newer valuation.',
                  TRADE_FIELDS_UNKNOWN: zh
                    ? '部分费用或币种未知。'
                    : 'Some fees or currencies are unknown.',
                })[gap] ?? gap,
            )
            .join(' ')}
        </p>
      )}
      <Button variant="outline" asChild>
        <Link to={`/paper/${account.id}`}>
          {zh ? '打开股友账户' : 'Open account'}
        </Link>
      </Button>
    </div>
  );
}
function SavedEvidence({ versionId }: { versionId: string }) {
  const query = useQuery({
    queryKey: ['research-document', versionId],
    queryFn: () => fetchResearchDocument(versionId),
  });
  const { i18n } = useTranslation(),
    zh = i18n.language.startsWith('zh');
  if (query.isPending)
    return <p role="status">{zh ? '正在读取…' : 'Loading…'}</p>;
  if (!query.data)
    return (
      <Button variant="outline" onClick={() => void query.refetch()}>
        {zh ? '原报告不可用，重试' : 'Original report unavailable. Retry'}
      </Button>
    );
  const version = query.data.version;
  return (
    <div className="space-y-4">
      <h3 className="font-semibold">{version.title}</h3>
      <p className="text-xs text-muted-foreground">
        {version.dataAsOf ?? version.createdAt} · v{version.version} ·{' '}
        {version.status}
      </p>
      <ResearchMarkdown>
        {readableResearchSections(version.sections) ||
          (zh
            ? '该版本没有可读正文。'
            : 'No readable content in this version.')}
      </ResearchMarkdown>
      <details>
        <summary>{zh ? '固定资料与来源' : 'Frozen input and sources'}</summary>
        <pre className="mt-3 overflow-auto whitespace-pre-wrap break-all text-xs">
          {JSON.stringify(version.snapshot, null, 2)}
        </pre>
      </details>
    </div>
  );
}
