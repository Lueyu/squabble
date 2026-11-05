/**
 * @file pages/Paper/PaperPage.tsx
 * @description Route `/paper`: the AI paper-trading terminal.
 *
 * Sections:
 *  - KPI cards (equity, cash, today's P&L, total P&L, today's orders)
 *  - Watchbot card: on/off toggle, scan-now button, circuit-breaker status,
 *    guardrail settings dialog, account reset
 *  - Equity curve (ECharts)
 *  - Paper positions with live-ish market values and unrealized P&L
 *  - Order feed with status badges (filled / rejected by risk gate) and
 *    per-order bot reasons
 *  - Activity timeline (bot scans, fills, guardrail triggers)
 *  - Notification channel manager (webhook / bark / serverchan / smtp /
 *    telegram) with test-send
 *  - Manual order dialog (market orders, same solvency checks as the bot)
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Bot,
  BotOff,
  PlayCircle,
  Wallet,
  TrendingUp,
  TrendingDown,
  Activity,
  Settings2,
  RotateCcw,
  BellRing,
  Plus,
  Trash2,
  FlaskConical,
  ShieldAlert,
  Loader2,
  CheckCircle2,
  XCircle,
  Copy,
} from 'lucide-react';
import ReactECharts from 'echarts-for-react';
import { SimulationExperimentsPanel } from './SimulationExperimentsPanel';
import { StrategyWorkbench } from './StrategyWorkbench';
import { useChartTheme } from '@/hooks/use-chart-theme';

import {
  fetchPaperOverview,
  placePaperOrder,
  runPaperBot,
  togglePaperBot,
  updatePaperGuardrails,
  resetPaperAccount,
  mirrorRealPortfolio,
  fetchNotificationChannels,
  createNotificationChannel,
  deleteNotificationChannel,
  setNotificationChannelEnabled,
  testNotificationChannel,
  fetchAgentSessions,
  createAgentSession,
  updateAgentSession,
  revokeAgentSession,
  approvePaperOrder,
  rejectPaperOrder,
} from '@/api';
import type {
  CreatePaperOrderDto,
  NotificationChannelType,
  PaperOverview,
  AgentSession,
} from '@shared/api.interface';
import { cn } from '@/utils/format';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from 'react-i18next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** Money formatter for USD figures. */
const usd = (v: string | null | undefined) =>
  v == null
    ? '—'
    : !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Signed percent formatter. */
const pct = (v: string | null | undefined) =>
  v == null ? '—' : `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`;

/** Badge styles per order status. */
const orderStatusStyles: Record<string, string> = {
  filled: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  rejected_risk: 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30',
  cancelled: 'bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/30',
  pending: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  failed: 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30',
};
const orderStatusLabel: Record<string, string> = {
  filled: 'paper.filled',
  rejected_risk: 'paper.rejectedByRisk',
  cancelled: 'paper.cancelled',
  pending: 'paper.pendingApproval',
  failed: 'paper.failed',
};
const eventLabel: Record<string, string> = {
  bot_started: 'ui.paper.watchingOn',
  bot_stopped: 'ui.paper.watchingOff',
  bot_scan: 'paper.scanNow',
  order_placed: 'paper.placeOrder',
  order_filled: 'paper.filled',
  order_rejected: 'paper.rejectedByRisk',
  circuit_breaker: 'ui.paper.dailyLossBreaker',
  manual_action: 'ui.paper.manualOrder',
  account_reset: 'ui.paper.confirmResetTitle',
};

function PaperPage() {
  const { t, i18n } = useTranslation();
  const en = i18n.language.startsWith('en');
  const [params] = useSearchParams();
  const linkedOrderId = params.get('orderId');
  const scrolledOrderId = useRef<string | null>(null);
  const queryClient = useQueryClient();
  const [orderOpen, setOrderOpen] = useState(false);
  const [guardrailsOpen, setGuardrailsOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  const overviewQuery = useQuery<PaperOverview>({
    queryKey: ['paper', 'overview'],
    queryFn: fetchPaperOverview,
    refetchInterval: 60_000,
  });
  const overview = overviewQuery.data;
  useEffect(() => {
    if (!linkedOrderId) scrolledOrderId.current = null;
    if (linkedOrderId && overview && scrolledOrderId.current !== linkedOrderId) {
      document.getElementById('paper-order-feed')?.scrollIntoView({ block: 'start' });
      scrolledOrderId.current = linkedOrderId;
    }
  }, [linkedOrderId, overview]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['paper'] });

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => togglePaperBot(enabled),
    onSuccess: (account) => {
      toast.success(account.botEnabled ? t('paper.botStarted') : t('paper.botStopped'));
      invalidate();
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t('ui.paper.orderActionFailed')),
  });

  const scanMutation = useMutation({
    mutationFn: runPaperBot,
    onSuccess: (result) => {
      if (result.placed === 0 && result.rejected === 0) {
        toast.info(t('paper.scanNoSignal', { scanned: result.scanned }));
      } else {
        toast.success(t('paper.scanComplete', { placed: result.placed, rejected: result.rejected }));
      }
      invalidate();
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t('ui.paper.scanningFailed')),
  });

  const resetMutation = useMutation({
    mutationFn: (initialCash?: number) => resetPaperAccount(initialCash),
    onSuccess: () => {
      toast.success(en ? 'New cash experiment created; prior history retained' : '已建立新现金实验，原历史保留');
      setResetOpen(false);
      invalidate();
    },
  });

  const mirrorMutation = useMutation({
    mutationFn: () => mirrorRealPortfolio(),
    onSuccess: (account) => {
      toast.success(t('paper.mirrorSuccess'));
      invalidate();
    },
    onError: (e: unknown) => {
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t('paper.mirrorFailed'));
    },
  });

  const busy = overviewQuery.isLoading;
  const botOn = overview?.account.botEnabled ?? false;

  return (
    <div className="min-w-0 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-serif text-2xl font-semibold">
            <FlaskConical size={22} className="text-primary" />
            {t('paper.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {en ? 'Monitor and simulate trades under published strategies and risk limits.' : '按已发布策略与风控条件监控和模拟交易。'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => mirrorMutation.mutate()}
            disabled={mirrorMutation.isPending}
          >
            <Copy size={16} className="mr-1" />
            {mirrorMutation.isPending ? t('paper.mirroring') : t('paper.mirrorReal')}
          </Button>
          <Button variant="outline" onClick={() => setOrderOpen(true)}>
            {t('ui.paper.manualOrder')}
          </Button>
          <Button
            variant={botOn ? 'destructive' : 'default'}
            onClick={() => toggleMutation.mutate(!botOn)}
            disabled={toggleMutation.isPending || busy}
          >
            {botOn ? <BotOff size={16} className="mr-1" /> : <Bot size={16} className="mr-1" />}
            {botOn ? t('paper.stopBot') : t('paper.startBot')}
          </Button>
        </div>
      </div>

      <SimulationExperimentsPanel accountId={overview?.account.id} autoPreview={params.get('seedReal') === '1'} />
      <StrategyWorkbench accountId={overview?.account.id} />

      {overview?.valuationGaps?.length ? <p className="rounded border border-amber-500/40 p-3 text-sm text-amber-700 dark:text-amber-400">{en ? 'Valuation incomplete: unavailable prices or FX. Returns are unknown and risk-increasing orders are blocked.' : '估值不完整：存在缺失行情或汇率。收益显示未知，新增风险订单会被拦截。'} {overview.valuationGaps.join(' · ')}</p> : null}
      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Card><CardContent className="min-w-0 p-3 sm:p-4">
          <div className="text-xs text-muted-foreground">{t('paper.equity')}</div>
          <div className="mt-1 whitespace-nowrap font-mono-nums text-base font-semibold sm:text-xl">${usd(overview?.equity)}</div>
        </CardContent></Card>
        <Card><CardContent className="min-w-0 p-3 sm:p-4">
          <div className="flex items-center gap-1 text-xs text-muted-foreground"><Wallet size={12} /> {t('paper.cash')}</div>
          <div className="mt-1 whitespace-nowrap font-mono-nums text-base font-semibold sm:text-xl">${usd(overview?.account.cashBalance)}</div>
        </CardContent></Card>
        <Card><CardContent className="min-w-0 p-3 sm:p-4">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            {Number(overview?.todayPl ?? 0) >= 0 ? <TrendingUp size={12} className="text-success" /> : <TrendingDown size={12} className="text-destructive" />}
            {t('paper.todayPl')}
          </div>
          <div className={cn('mt-1 whitespace-nowrap font-mono-nums text-base font-semibold sm:text-xl', Number(overview?.todayPl ?? 0) >= 0 ? 'text-success' : 'text-destructive')}>
            ${usd(overview?.todayPl)}
          </div>
        </CardContent></Card>
        <Card><CardContent className="min-w-0 p-3 sm:p-4">
          <div className="text-xs text-muted-foreground">{t('paper.totalPl')}</div>
          <div className={cn('mt-1 flex min-w-0 flex-col gap-0.5 font-mono-nums font-semibold', Number(overview?.totalPl ?? 0) >= 0 ? 'text-success' : 'text-destructive')}>
            <span className="whitespace-nowrap text-base sm:text-xl">${usd(overview?.totalPl)}</span>
            <span className="text-xs leading-4">{pct(overview?.totalPlPct)}</span>
          </div>
        </CardContent></Card>
        <Card><CardContent className="min-w-0 p-3 sm:p-4">
          <div className="text-xs text-muted-foreground">{t('ui.paper.botOrders')}</div>
          <div className="mt-1 font-mono-nums text-base font-semibold sm:text-xl">{overview?.todayOrderCount ?? 0}</div>
        </CardContent></Card>
      </div>

      {/* Bot control bar */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <Badge
            variant="outline"
            className={cn(
              'gap-1.5 py-1',
              botOn
                ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
                : 'bg-slate-500/10 text-muted-foreground border-border',
            )}
          >
            {botOn ? <Bot size={12} /> : <BotOff size={12} />}
            {botOn ? t('ui.paper.watchingOn') : t('ui.paper.watchingOff')}
          </Badge>
          {overview?.circuitBreakerActive && (
            <Badge variant="outline" className="gap-1.5 border-rose-500/40 bg-rose-500/15 py-1 text-rose-600 dark:text-rose-400">
              <ShieldAlert size={12} /> {t('paper.circuitBreaker')}
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            {t('paper.guardrails', { loss: overview?.account.guardrails.dailyLossLimitPct ?? 3, orderPct: overview?.account.guardrails.maxOrderPct ?? 5, daily: overview?.account.guardrails.maxOrdersPerDay ?? 10 })}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => scanMutation.mutate()} disabled={!botOn || scanMutation.isPending}>
              {scanMutation.isPending ? <Loader2 size={14} className="mr-1 animate-spin" /> : <PlayCircle size={14} className="mr-1" />}
              {t('paper.scanNow')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setGuardrailsOpen(true)}>
              <Settings2 size={14} className="mr-1" /> {t('paper.riskParams')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setResetOpen(true)}>
              <RotateCcw size={14} className="mr-1" /> {en ? 'New cash experiment' : '新建现金实验'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Equity curve */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">{t('paper.equityCurve')}</CardTitle></CardHeader>
        <CardContent className="p-2 pt-0">
          <PaperEquityChart data={overview?.curve ?? []} />
        </CardContent>
      </Card>

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Positions */}
        <Card className="min-w-0">
          <CardHeader className="pb-2"><CardTitle className="text-sm">{t('paper.positions', { count: overview?.positions.length ?? 0 })}</CardTitle></CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2 font-medium">{t('ui.paper.stock')}</th>
                    <th className="px-4 py-2 font-medium">{t('ui.paper.shares')}</th>
                    <th className="px-4 py-2 font-medium">{t('paper.costPrice')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('ui.paper.unrealizedPl')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(overview?.positions ?? []).map((p) => {
                    const pl = Number(p.unrealizedPl ?? 0);
                    const pctVal = Number(p.unrealizedPct ?? 0);
                    return (
                      <tr key={p.id} className="border-b last:border-0">
                        <td className="px-4 py-2.5">
                          <div className="font-medium">{p.ticker}</div>
                          <div className="text-xs text-muted-foreground">{p.company ?? ''}</div>
                        </td>
                        <td className="px-4 py-2.5 font-mono-nums">{Number(p.shares)}</td>
                        <td className="px-4 py-2.5 font-mono-nums text-xs">
                          {Number(p.avgCost).toFixed(2)} / {p.lastPrice ?? '—'}
                        </td>
                        <td className={cn('px-4 py-2.5 text-right font-mono-nums', pl >= 0 ? 'text-success' : 'text-destructive')}>
                          {pl >= 0 ? '+' : ''}${usd(p.unrealizedPl)}
                          <span className="ml-1 text-xs">({pctVal >= 0 ? '+' : ''}{pctVal.toFixed(2)}%)</span>
                        </td>
                      </tr>
                    );
                  })}
                  {(overview?.positions.length ?? 0) === 0 && (
                    <tr><td colSpan={4} className="px-4 py-8 text-center text-sm text-muted-foreground">
                      {t('ui.paper.positionsEmpty')}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* Events */}
        <Card className="min-w-0">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-1.5 text-sm"><Activity size={14} /> {t('paper.botActivity')}</CardTitle></CardHeader>
          <CardContent className="max-h-80 space-y-2 overflow-y-auto p-4">
            {(overview?.recentEvents ?? []).map((e) => (
              <div key={e.id} className="flex items-start gap-2 text-sm">
                <Badge
                  variant="outline"
                  className={cn(
                    'shrink-0 text-[10px]',
                    e.eventType === 'order_filled' && 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
                    e.eventType === 'circuit_breaker' && 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
                    (e.eventType === 'order_rejected') && 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
                  )}
                >
                  {eventLabel[e.eventType] ? t(eventLabel[e.eventType]) : e.eventType}
                </Badge>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-foreground/90">{summarizeEvent(e.eventType, e.detail, t)}</div>
                  <div className="text-[10px] text-muted-foreground">{new Date(e.createdAt).toLocaleString(undefined, { hour12: false })}</div>
                </div>
              </div>
            ))}
            {(overview?.recentEvents.length ?? 0) === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">{t('ui.paper.eventsEmpty')}</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Orders feed */}
      <Card id="paper-order-feed" className="scroll-mt-5">
        <CardHeader className="pb-2"><CardTitle className="text-sm">{t('paper.orderFlow')}</CardTitle></CardHeader>
        <CardContent className="p-0">
          {linkedOrderId && overview && <p className="break-all border-b border-border bg-primary/5 px-4 py-3 text-xs leading-6">
            {t(overview.recentOrders.some((order) => order.id === linkedOrderId)
              ? 'council.report.orderHighlighted' : 'council.report.olderOrder', { id: linkedOrderId })}
          </p>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">{t('paper.time')}</th>
                  <th className="px-4 py-2 font-medium">{t('ui.paper.stock')}</th>
                  <th className="px-4 py-2 font-medium">{t('paper.direction')}</th>
                  <th className="px-4 py-2 font-medium">{t('paper.quantity')}</th>
                  <th className="px-4 py-2 font-medium">{t('paper.filledPrice')}</th>
                  <th className="px-4 py-2 font-medium">{t('paper.status')}</th>
                  <th className="px-4 py-2 font-medium">{t('paper.source')}</th>
                  <th className="px-4 py-2 font-medium">{t('paper.reason')}</th>
                </tr>
              </thead>
              <tbody>
                {(overview?.recentOrders ?? []).map((o) => (
                  <tr key={o.id} className={cn('border-b last:border-0', o.id === linkedOrderId && 'bg-primary/10')}>
                    <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(o.createdAt).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                    </td>
                    <td className="px-4 py-2.5 font-medium">{o.ticker}</td>
                    <td className={cn('px-4 py-2.5 font-medium', o.side === 'buy' ? 'text-success' : 'text-destructive')}>
                      {o.side === 'buy' ? t('paper.buy') : t('paper.sell')}
                    </td>
                    <td className="px-4 py-2.5 font-mono-nums">{Number(o.quantity)}</td>
                    <td className="px-4 py-2.5 font-mono-nums">{o.filledPrice ?? '—'}</td>
                    <td className="px-4 py-2.5">
                      <Badge variant="outline" className={cn('text-[10px]', orderStatusStyles[o.status])}>
                        {orderStatusLabel[o.status] ? t(orderStatusLabel[o.status]) : o.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      {o.source === 'agent' ? t('paper.agentSrc') : t('paper.manualSrc')}
                    </td>
                    <td className="max-w-xs px-4 py-2.5 text-xs text-muted-foreground">
                      <div className="truncate" title={o.reason ?? ''}>{o.reason ?? '—'}</div>
                    </td>
                  </tr>
                ))}
                {(overview?.recentOrders.length ?? 0) === 0 && (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">{t('paper.noOrders')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Notification channels */}
      <NotificationChannelsCard />

      {/* AI agent sessions (MCP) */}
      <AgentSessionsCard />

      {/* Pending approvals */}
      {(overview?.recentOrders ?? []).some((o) => o.status === 'pending_approval') && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <Bot size={14} className="text-amber-500" /> {t('ui.paper.pendingApprovals')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 p-4">
            {(overview?.recentOrders ?? [])
              .filter((o) => o.status === 'pending_approval')
              .map((o) => (
                <div key={o.id} className="flex items-center gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">
                      {t('ui.paper.agentRequest', { agent: o.reason?.match(/(?:AI 代理|Agent)\s+([^\s]+)/i)?.[1] ?? 'AI', side: t(o.side === 'buy' ? 'paper.buy' : 'paper.sell'), ticker: `${o.ticker} × ${Number(o.quantity)}` })}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{o.reason}</div>
                  </div>
                  <Button
                    size="sm"
                    onClick={async () => {
                      try {
                        const result = await approvePaperOrder(o.id);
                        toast.success(t('ui.paper.approvalPassed', { ticker: o.ticker, price: result.filledPrice }));
                        invalidate();
                      } catch (error) {
                        toast.error((error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t('ui.paper.approvalFailed'));
                      }
                    }}
                  >
                    <CheckCircle2 size={14} className="mr-1" /> {t('ui.paper.approve')}
                  </Button>
                  <Button
                    size="sm" variant="destructive"
                    onClick={async () => {
                      try {
                        await rejectPaperOrder(o.id);
                        toast.info(t('ui.paper.orderRejected', { ticker: o.ticker }));
                        invalidate();
                      } catch (error) {
                        toast.error((error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t('ui.paper.orderActionFailed'));
                      }
                    }}
                  >
                    <XCircle size={14} className="mr-1" /> {t('ui.paper.reject')}
                  </Button>
                </div>
              ))}
          </CardContent>
        </Card>
      )}

      {/* Dialogs */}
      <ManualOrderDialog accountId={overview?.account.id} open={orderOpen} onOpenChange={setOrderOpen} onDone={invalidate} />
      <GuardrailsDialog open={guardrailsOpen} onOpenChange={setGuardrailsOpen} overview={overview} onDone={invalidate} />
      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{en ? 'Create a new cash experiment' : '创建新的现金实验'}</DialogTitle>
            <DialogDescription>
              {en ? 'Creates a separate account with $1,000,000. All prior ledgers and positions remain available in the experiment selector. Automation stops.' : '建立独立的100万美元现金账户。原账本及持仓全部保留，可在实验选择器中重新打开。自动化将停止。'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setResetOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={() => resetMutation.mutate(undefined)} disabled={resetMutation.isPending}>
              {resetMutation.isPending ? (en ? 'Creating…' : '创建中…') : (en ? 'Create experiment' : '创建实验')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Equity line chart for the paper account. */
function PaperEquityChart({ data }: { data: Array<{ date: string; equity: string; dailyPl: string }> }) {
  const { t } = useTranslation();
  const colors = useChartTheme();
  const option = useMemo(() => {
    if (data.length === 0) return {};
    return {
      backgroundColor: colors.surface,
      textStyle: { color: colors.foreground, fontFamily: colors.fontFamily },
      tooltip: {
        trigger: 'axis',
        confine: true,
        backgroundColor: colors.tooltipBackground,
        borderColor: colors.border,
        textStyle: { color: colors.tooltipForeground },
        axisPointer: { lineStyle: { color: colors.muted } },
      },
      grid: { top: 20, right: 20, bottom: 30, left: 70 },
      xAxis: {
        type: 'category',
        data: data.map((d) => d.date.slice(5)),
        axisLabel: { fontSize: 10, color: colors.muted },
        axisLine: { lineStyle: { color: colors.border } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLabel: {
          fontSize: 10,
          color: colors.muted,
          formatter: (v: number) => `$${(v / 1000).toFixed(0)}k`,
        },
        splitLine: { lineStyle: { color: colors.grid } },
      },
      series: [
        {
          name: t('ui.paper.equitySeries'),
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 5,
          data: data.map((d) => Number(d.equity)),
          lineStyle: { color: colors.line, width: 2 },
          itemStyle: { color: colors.line },
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: colors.areaStart },
                { offset: 1, color: colors.areaEnd },
              ],
            },
          },
        },
      ],
    };
  }, [data, t, colors]);
  if (data.length === 0) {
    return <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">{t('ui.paper.chartNoData')}</div>;
  }
  return <ReactECharts option={option} style={{ height: 260 }} notMerge />;
}

/** One-line Chinese summary for a timeline event. */
function summarizeEvent(type: string, detail: Record<string, unknown> | null, t: (key: string, options?: Record<string, unknown>) => string): string {
  const d = detail ?? {};
  if (type === 'order_filled') {
    const side = t(d.side === 'buy' ? 'paper.buy' : 'paper.sell');
    const pl = d.realizedPl != null ? t('ui.paper.realizedPl', { value: `${Number(d.realizedPl) >= 0 ? '+' : ''}${d.realizedPl}` }) : '';
    return t('ui.paper.filledEvent', { ticker: d.ticker, side, quantity: d.quantity, price: d.price, profit: pl });
  }
  if (type === 'order_rejected') {
    const side = t(d.side === 'buy' ? 'paper.buy' : 'paper.sell');
    return t('ui.paper.rejectedReason', { side, reason: d.reason ?? '' });
  }
  if (type === 'circuit_breaker') return t('ui.paper.circuitBreakerEvent', { reason: d.reason ?? t('ui.paper.circuitBreakerDefault') });
  if (type === 'bot_scan') {
    return t('ui.paper.scanSummary', { scanned: d.scanned, placed: d.placed, rejected: d.rejected });
  }
  if (type === 'bot_started') return t('ui.paper.botStartedEvent');
  if (type === 'bot_stopped') return t('ui.paper.botStoppedEvent');
  if (type === 'account_reset') return t('ui.paper.accountResetEvent', { cash: d.initialCash ?? '' });
  return JSON.stringify(d);
}

/** Manual market-order dialog. */
function ManualOrderDialog({ accountId, open, onOpenChange, onDone }: { accountId?: string; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [ticker, setTicker] = useState('');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [quantity, setQuantity] = useState('10');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const dto: CreatePaperOrderDto & { accountId?: string } = {
      accountId,
      ticker: ticker.trim(),
      side,
      quantity: Number(quantity),
      orderType: 'market',
    };
    try {
      setSubmitting(true);
      const order = await placePaperOrder(dto);
      if (order.status === 'filled') {
        toast.success(t('ui.paper.filledToast', { ticker: order.ticker, side: t(side === 'buy' ? 'paper.buy' : 'paper.sell'), price: order.filledPrice }));
      } else {
        toast.warning(t('ui.paper.orderBlocked', { reason: order.reason ?? t('ui.paper.riskGateFailed') }));
      }
      onOpenChange(false);
      setTicker('');
      onDone();
    } catch (error) {
      toast.error((error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? t('ui.paper.placingFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('ui.paper.marketOrderTitle')}</DialogTitle>
          <DialogDescription>{t('paper.marketOrderNote')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t('ui.paper.symbol')}</Label>
            <Input placeholder={t('paper.tickerPlaceholder')} value={ticker} onChange={(e) => setTicker(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>{t('ui.paper.side')}</Label>
            <Select value={side} onValueChange={(v) => setSide(v as 'buy' | 'sell')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="buy">{t('paper.buy')}</SelectItem>
                <SelectItem value="sell">{t('paper.sell')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{t('ui.paper.shares')}</Label>
            <Input type="number" min={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={submit} disabled={submitting || !ticker.trim()}>
            {submitting ? t('paper.placingOrder') : t('paper.placeOrder')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Guardrail thresholds dialog. */
function GuardrailsDialog({ open, onOpenChange, overview, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; overview: PaperOverview | undefined; onDone: () => void }) {
  const { t } = useTranslation();
  const g = overview?.account.guardrails;
  const [loss, setLoss] = useState(String(g?.dailyLossLimitPct ?? 3));
  const [orderPct, setOrderPct] = useState(String(g?.maxOrderPct ?? 5));
  const [daily, setDaily] = useState(String(g?.maxOrdersPerDay ?? 10));
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    try {
      setSubmitting(true);
      await updatePaperGuardrails({
        dailyLossLimitPct: Number(loss),
        maxOrderPct: Number(orderPct),
        maxOrdersPerDay: Number(daily),
      });
      toast.success(t('paper.paramsUpdated'));
      onOpenChange(false);
      onDone();
    } catch {
      toast.error(t('ui.paper.saveFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('ui.paper.guardrailSettings')}</DialogTitle>
          <DialogDescription>{t('ui.paper.guardrailDescription')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t('ui.paper.dailyLossBreakerLine')}</Label>
            <Input type="number" min={0.5} step={0.5} value={loss} onChange={(e) => setLoss(e.target.value)} />
            <p className="text-xs text-muted-foreground">{t('ui.paper.dailyLossBreakerHint')}</p>
          </div>
          <div className="space-y-2">
            <Label>{t('ui.paper.singleOrderLimit')}</Label>
            <Input type="number" min={0.5} step={0.5} value={orderPct} onChange={(e) => setOrderPct(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>{t('ui.paper.dailyOrderLimit')}</Label>
            <Input type="number" min={1} value={daily} onChange={(e) => setDaily(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={submit} disabled={submitting}>{submitting ? t('ui.paper.savePending') : t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Channel type metadata for the manager UI. */
const CHANNEL_META: Record<NotificationChannelType, { name: string; hint: string; fields: Array<{ key: string; label: string; placeholder: string }> }> = {
  webhook: {
    name: 'Webhook',
    hint: 'ui.paper.channelHints.webhook',
    fields: [{ key: 'url', label: 'Webhook URL', placeholder: 'https://example.com/hook' }],
  },
  bark: {
    name: 'Bark (iOS)',
    hint: 'ui.paper.channelHints.bark',
    fields: [
      { key: 'key', label: 'Bark Key', placeholder: 'ui.paper.fieldPlaceholders.deviceKey' },
      { key: 'server', label: 'ui.paper.fieldLabels.customServer', placeholder: 'https://api.day.app' },
    ],
  },
  serverchan: {
    name: 'ServerChan (WeChat)',
    hint: 'ui.paper.channelHints.serverchan',
    fields: [{ key: 'key', label: 'SendKey', placeholder: 'SCT...' }],
  },
  smtp: {
    name: 'Email (SMTP)',
    hint: 'ui.paper.channelHints.smtp',
    fields: [
      { key: 'host', label: 'ui.paper.fieldLabels.smtpServer', placeholder: 'smtp.example.com' },
      { key: 'port', label: 'ui.paper.fieldLabels.port', placeholder: '465' },
      { key: 'user', label: 'ui.paper.fieldLabels.username', placeholder: 'you@example.com' },
      { key: 'pass', label: 'ui.paper.fieldLabels.password', placeholder: '••••••' },
      { key: 'to', label: 'ui.paper.fieldLabels.recipientEmail', placeholder: 'you@example.com' },
    ],
  },
  telegram: {
    name: 'Telegram',
    hint: 'ui.paper.channelHints.telegram',
    fields: [
      { key: 'token', label: 'Bot Token', placeholder: '123456:ABC-...' },
      { key: 'chatId', label: 'ui.paper.fieldLabels.chatId', placeholder: 'ui.paper.fieldPlaceholders.chatId' },
    ],
  },
};

/** Notification channel manager card. */
function NotificationChannelsCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [channelType, setChannelType] = useState<NotificationChannelType>('webhook');
  const [label, setLabel] = useState('');
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const channelsQuery = useQuery({
    queryKey: ['notifications', 'channels'],
    queryFn: fetchNotificationChannels,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });

  const addChannel = async () => {
    const config: Record<string, string> = {};
    for (const f of CHANNEL_META[channelType].fields) {
      const v = (fieldValues[f.key] ?? '').trim();
      if (v) config[f.key] = v;
    }
    if (Object.keys(config).length === 0) {
      toast.warning(t('ui.paper.channelFieldRequired'));
      return;
    }
    try {
      setSubmitting(true);
      await createNotificationChannel({ channelType, label: label.trim() || undefined, config });
      toast.success(t('ui.paper.channelAdded'));
      setAddOpen(false);
      setFieldValues({});
      setLabel('');
      invalidate();
    } catch {
      toast.error(t('ui.paper.channelAddFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card id="notifications" className="scroll-mt-4">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <BellRing size={14} /> {t('ui.paper.notificationChannels')}
        </CardTitle>
        <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
          <Plus size={14} className="mr-1" /> {t('ui.paper.addChannel')}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2 p-4">
        <p className="text-xs text-muted-foreground">
          {t('ui.paper.channelsIntro')}
        </p>
        {(channelsQuery.data ?? []).map((ch) => (
          <div key={ch.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
            <Badge variant="outline" className="shrink-0 text-[10px]">{CHANNEL_META[ch.channelType]?.name ?? ch.channelType}</Badge>
            <span className="truncate text-foreground/90">{ch.label ?? Object.values(ch.config)[0] ?? ''}</span>
            <div className="ml-auto flex items-center gap-2">
              <Switch checked={ch.enabled} onCheckedChange={async (v) => { await setNotificationChannelEnabled(ch.id, v); invalidate(); }} />
              <Button
                variant="ghost" size="sm"
                onClick={async () => {
                  const r = await testNotificationChannel(ch.id);
                  if (r.ok) toast.success(t('ui.paper.testSent'));
                  else toast.error(t('ui.paper.testFailed', { reason: r.error ?? t('ui.paper.unknownError') }));
                }}
              >
                {t('ui.paper.testMessage')}
              </Button>
              <Button
                variant="ghost" size="sm"
                onClick={async () => { await deleteNotificationChannel(ch.id); invalidate(); }}
              >
                <Trash2 size={14} className="text-destructive" />
              </Button>
            </div>
          </div>
        ))}
        {(channelsQuery.data ?? []).length === 0 && (
          <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {t('ui.paper.notificationsEmpty')}
          </div>
        )}
      </CardContent>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('ui.paper.addNotificationChannel')}</DialogTitle>
            <DialogDescription>{t(CHANNEL_META[channelType].hint)}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t('ui.paper.channelType')}</Label>
              <Select value={channelType} onValueChange={(v) => { setChannelType(v as NotificationChannelType); setFieldValues({}); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(CHANNEL_META) as NotificationChannelType[]).map((k) => (
                    <SelectItem key={k} value={k}>{CHANNEL_META[k].name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('ui.paper.labelOptional')}</Label>
              <Input placeholder={t('ui.paper.labelPlaceholder')} value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>
            {CHANNEL_META[channelType].fields.map((f) => (
              <div key={f.key} className="space-y-2">
                <Label>{f.label.startsWith('ui.') ? t(f.label) : f.label}</Label>
                <Input
                  placeholder={f.placeholder.startsWith('ui.') ? t(f.placeholder) : f.placeholder}
                  value={fieldValues[f.key] ?? ''}
                  onChange={(e) => setFieldValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={addChannel} disabled={submitting}>{submitting ? t('ui.paper.creating') : t('ui.paper.addChannel')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** AI agent sessions management card (MCP connections). */
function AgentSessionsCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [dailyLimit, setDailyLimit] = useState('500');
  const [permission, setPermission] = useState<'read' | 'trade'>('trade');
  const [approvalMode, setApprovalMode] = useState<'auto' | 'require_approval'>('require_approval');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const sessionsQuery = useQuery({
    queryKey: ['mcp', 'sessions'],
    queryFn: fetchAgentSessions,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['mcp'] });

  const add = async () => {
    if (!name.trim()) {
      toast.warning(t('ui.paper.agentNameRequired'));
      return;
    }
    try {
      setSubmitting(true);
      const session = await createAgentSession({
        name: name.trim(),
        dailyLimitUsd: Number(dailyLimit) || 500,
        permission,
        approvalMode,
      });
      setNewToken(session.token ?? null);
      setAddOpen(false);
      setName('');
      invalidate();
    } catch {
      toast.error(t('ui.paper.agentCreateFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const sessions = sessionsQuery.data ?? [];
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <Bot size={14} /> {t('ui.paper.agentSessions')}
        </CardTitle>
        <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
          <Plus size={14} className="mr-1" /> {t('ui.paper.connectAgent')}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2 p-4">
        <p className="text-xs text-muted-foreground">
          {t('ui.paper.agentIntro')}
        </p>
        {newToken && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
            <div className="font-medium text-emerald-600 dark:text-emerald-400">✓ {t('ui.paper.agentCreated')}</div>
            <div className="mt-2 space-y-1 text-xs">
              <div><span className="text-muted-foreground">{t('ui.paper.mcpAddress')}</span><code className="break-all">{baseUrl}/mcp</code></div>
              <div><span className="text-muted-foreground">{t('ui.paper.token')}</span><code className="break-all">{newToken}</code></div>
            </div>
            <div className="mt-2 text-xs text-muted-foreground">
              {t('ui.paper.tokenOneTime')}
            </div>
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setNewToken(null)}>{t('ui.paper.agentTokenClose')}</Button>
          </div>
        )}
        {sessions.map((s) => (
          <div key={s.id} className={`flex items-center gap-3 rounded-md border px-3 py-2 text-sm ${s.status === 'revoked' ? 'border-border opacity-50' : 'border-border'}`}>
            <Badge variant="outline" className={`shrink-0 text-[10px] ${s.permission === 'trade' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-slate-500/15 text-muted-foreground'}`}>
              {s.permission === 'trade' ? t('ui.paper.tradePermission') : t('ui.paper.readOnlyPermission')}
            </Badge>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{s.name}</div>
              <div className="text-xs text-muted-foreground">
                {t('ui.paper.dailyLimit', { amount: Number(s.dailyLimitUsd).toLocaleString() })} · {s.approvalMode === 'require_approval' ? t('ui.paper.requiresApproval') : t('ui.paper.automatic')}
                {s.lastUsedAt && ` · ${t('ui.paper.lastUsed', { time: new Date(s.lastUsedAt).toLocaleString(undefined, { hour12: false }) })}`}
              </div>
            </div>
            {s.status === 'active' ? (
              <div className="flex items-center gap-2">
                <select
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                  value={s.approvalMode}
                  onChange={async (e) => {
                    await updateAgentSession(s.id, { approvalMode: e.target.value as 'auto' | 'require_approval' });
                    invalidate();
                  }}
                >
                  <option value="require_approval">{t('ui.paper.requiresApproval')}</option>
                  <option value="auto">{t('ui.paper.automaticFill')}</option>
                </select>
                <Button variant="ghost" size="sm" onClick={async () => { await revokeAgentSession(s.id); invalidate(); }}>
                  <Trash2 size={14} className="text-destructive" />
                </Button>
              </div>
            ) : (
              <Badge variant="outline" className="text-[10px] text-muted-foreground">{t('ui.paper.revoked')}</Badge>
            )}
          </div>
        ))}
        {sessions.length === 0 && !newToken && (
          <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {t('ui.paper.agentsEmpty')}
          </div>
        )}
      </CardContent>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('ui.paper.agentConnectTitle')}</DialogTitle>
            <DialogDescription>
              {t('ui.paper.agentConnectDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t('ui.paper.agentName')}</Label>
              <Input placeholder={t('ui.paper.agentNamePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>{t('ui.paper.dailySpendLimit')}</Label>
              <Input type="number" min={1} value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} />
              <p className="text-xs text-muted-foreground">{t('ui.paper.dailySpendLimitHint')}</p>
            </div>
            <div className="space-y-2">
              <Label>{t('ui.paper.permission')}</Label>
              <Select value={permission} onValueChange={(v) => setPermission(v as 'read' | 'trade')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="trade">{t('ui.paper.canTrade')}</SelectItem>
                  <SelectItem value="read">{t('ui.paper.canRead')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('ui.paper.approvalMode')}</Label>
              <Select value={approvalMode} onValueChange={(v) => setApprovalMode(v as 'auto' | 'require_approval')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="require_approval">{t('ui.paper.manualApproval')}</SelectItem>
                  <SelectItem value="auto">{t('ui.paper.autoFillGuarded')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={add} disabled={submitting}>{submitting ? t('ui.paper.creating') : t('ui.paper.connectAgent')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default PaperPage;
