import { useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowRight, Bell, Bot, CirclePause, ClipboardCheck, FlaskConical,
  Loader2, Pencil, Play, Plus, RefreshCw, ShieldCheck, Users,
} from 'lucide-react';

import {
  activateBuilderProfile,
  fetchBuilderProfiles,
  fetchBuilderProposals,
  fillBuilderProposal,
  pauseBuilderProfile,
  runBuilderProfile,
  skipBuilderProposal,
  type BuilderProfile,
  type BuilderProposal,
  type BuilderRunResult,
} from '@/api/builder';
import type { RecordBuilderFillDto } from '@shared/api.interface';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import BuilderWizard from './BuilderWizard';
import StrategyRuntimeCard from './StrategyRuntimeCard';
import { errorMessage } from './errorMessage';
import { DEFAULT_CADENCE } from '@/utils/council-state';

function localDateTimeNow(): string {
  const now: Date = new Date();
  const local: Date = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

interface FillForm {
  executedAt: string;
  quantity: string;
  price: string;
  fees: string;
  notes: string;
}

const EMPTY_FILL: FillForm = {
  executedAt: localDateTimeNow(),
  quantity: '',
  price: '',
  fees: '0',
  notes: '',
};

export default function AgentBuilderPage() {
  const { t, i18n } = useTranslation();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editing, setEditing] = useState<BuilderProfile | null>(null);
  const [selected, setSelected] = useState<BuilderProposal | null>(null);
  const [fill, setFill] = useState<FillForm>(EMPTY_FILL);
  const [fillError, setFillError] = useState<string | null>(null);

  const profilesQuery = useQuery<BuilderProfile[]>({
    queryKey: ['builder', 'profiles'],
    queryFn: fetchBuilderProfiles,
  });
  const proposalsQuery = useQuery<BuilderProposal[]>({
    queryKey: ['builder', 'proposals'],
    queryFn: fetchBuilderProposals,
    refetchInterval: 60_000,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['builder'] });

  const activateMutation = useMutation<BuilderProfile, Error, string>({
    mutationFn: activateBuilderProfile,
    onSuccess: () => {
      void refresh();
      toast.success(t('ui.builder.activated'));
    },
    onError: (error: Error) => toast.error(errorMessage(error, t('ui.builder.activateFailed'))),
    retry: false,
  });
  const pauseMutation = useMutation<BuilderProfile, Error, string>({
    mutationFn: pauseBuilderProfile,
    onSuccess: () => {
      void refresh();
      toast.success(t('ui.builder.paused'));
    },
    onError: (error: Error) => toast.error(errorMessage(error, t('ui.builder.actionFailed'))),
    retry: false,
  });
  const runMutation = useMutation<BuilderRunResult, Error, string>({
    mutationFn: runBuilderProfile,
    onSuccess: (result: BuilderRunResult) => {
      void refresh();
      if (result.automation) { toast.success(t('strategy.checked')); return; }
      const summary: string = t('ui.builder.runSummary', {
        scanned: result.scanned,
        placed: result.placed,
        rejected: result.rejected,
      });
      if (result.placed === 0) {
        toast.info(summary, { description: t('ui.builder.noSignalsHint') });
      } else {
        toast.success(summary);
      }
    },
    onError: (error: Error) => toast.error(errorMessage(error, t('ui.builder.runFailed'))),
    retry: false,
  });
  const skipMutation = useMutation<BuilderProposal, Error, string>({
    mutationFn: skipBuilderProposal,
    onSuccess: () => {
      void refresh();
      toast.success(t('ui.builder.skipped'));
    },
    onError: (error: Error) => toast.error(errorMessage(error, t('ui.builder.actionFailed'))),
    retry: false,
  });
  const fillMutation = useMutation<BuilderProposal, Error,
    { id: string; fill: RecordBuilderFillDto }>({
    mutationFn: ({ id, fill: request }) => fillBuilderProposal(id, request),
    onSuccess: () => {
      setSelected(null);
      void refresh();
      toast.success(t('ui.builder.fillRecorded'));
    },
    onError: (error: Error) => toast.error(errorMessage(error, t('ui.builder.actionFailed'))),
    retry: false,
  });

  const profiles: BuilderProfile[] = profilesQuery.data ?? [];
  const proposals: BuilderProposal[] = proposalsQuery.data ?? [];
  const active: BuilderProfile | undefined = profiles.find(
    (profile: BuilderProfile) => profile.status === 'active',
  );
  const pending: BuilderProposal[] = proposals.filter(
    (proposal: BuilderProposal) => proposal.status === 'pending',
  );
  const history: BuilderProposal[] = proposals.filter(
    (proposal: BuilderProposal) => proposal.status !== 'pending',
  );
  const busy = activateMutation.isPending || pauseMutation.isPending || runMutation.isPending;
  const locale: string = i18n.language === 'en' ? 'en-US' : 'zh-CN';

  const formatDate = (value: string): string => {
    const date: Date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale);
  };

  const openNew = () => {
    setParams({}, { replace: true });
    setEditing(null);
    setWizardOpen(true);
  };
  const openEdit = (profile: BuilderProfile) => {
    setParams({}, { replace: true });
    setEditing(profile);
    setWizardOpen(true);
  };
  const openFill = (proposal: BuilderProposal) => {
    setSelected(proposal);
    setFill({ ...EMPTY_FILL, executedAt: localDateTimeNow(), quantity: proposal.quantity,
      price: proposal.referencePrice });
    setFillError(null);
  };
  const submitFill = () => {
    if (!selected) return;
    const quantity: number = Number(fill.quantity);
    const price: number = Number(fill.price);
    const fees: number = Number(fill.fees);
    const date: Date = new Date(fill.executedAt);
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price)
      || price <= 0 || !Number.isFinite(fees) || fees < 0
      || Number.isNaN(date.getTime()) || date.getTime() > Date.now() + 300_000) {
      setFillError(t('ui.builder.fillInvalid'));
      return;
    }
    setFillError(null);
    fillMutation.mutate({ id: selected.id, fill: {
      executedAt: date.toISOString(),
      quantity,
      price,
      fees,
      notes: fill.notes.trim(),
    } });
  };

  if (params.get('tab') === 'budget') return <Navigate to="/settings#research-budget" replace />;
  return (
    <div className="mx-auto max-w-6xl space-y-8 pb-12">
      <section className="relative overflow-hidden rounded-2xl border border-primary/20 bg-card p-6 md:p-8">
        <div className="absolute -right-12 -top-20 size-56 rounded-full bg-primary/5 blur-3xl" />
        <div className="relative flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-primary">
              <Bot className="size-4" /> {t('ui.builder.eyebrow')}
            </p>
            <h1 className="mt-3 font-serif text-3xl font-semibold tracking-tight md:text-4xl">
              {t('ui.builder.title')}
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground md:text-base">
              {t('ui.builder.intro')}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button asChild variant="outline"><Link to="/council"><Users />{t('council.open')}</Link></Button>
          {!wizardOpen && (
            <Button type="button" onClick={openNew} className="shrink-0">
              <Plus /> {t('ui.builder.createAgent')}
            </Button>
          )}
          </div>
        </div>
        <div className="relative mt-6 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border border-border bg-background px-3 py-1.5">
            {t('ui.builder.guardrailPill')}
          </span>
          <span className="rounded-full border border-border bg-background px-3 py-1.5">
            {t('ui.builder.paperPill')}
          </span>
          <span className="rounded-full border border-border bg-background px-3 py-1.5">
            {t('ui.builder.manualPill')}
          </span>
        </div>
      </section>

      {wizardOpen && (
        <BuilderWizard key={editing?.id ?? 'new'} editing={editing}
          onSaved={() => void refresh()} onClose={() => setWizardOpen(false)} />
      )}

      <section className="space-y-4" aria-labelledby="builder-profiles-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="builder-profiles-title" className="font-serif text-2xl font-semibold">
              {t('ui.builder.yourAgents')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('ui.builder.oneActiveHint')}</p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>
            <RefreshCw /> {t('ui.builder.refresh')}
          </Button>
        </div>
        {profilesQuery.isLoading && <p className="text-sm text-muted-foreground">{t('ui.builder.loading')}</p>}
        {profilesQuery.isError && <p role="alert" className="text-sm text-destructive">
          {errorMessage(profilesQuery.error, t('ui.builder.loadFailed'))}
        </p>}
        {!profilesQuery.isLoading && !profilesQuery.isError && profiles.length === 0 && (
          <Card><CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <ShieldCheck className="size-8 text-muted-foreground" />
            <p className="font-medium">{t('ui.builder.noAgents')}</p>
            <p className="text-sm text-muted-foreground">{t('ui.builder.noAgentsHint')}</p>
            <Button type="button" variant="outline" onClick={openNew}>
              <Plus /> {t('ui.builder.createAgent')}
            </Button>
          </CardContent></Card>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          {profiles.map((profile: BuilderProfile) => (
            <Card key={profile.id} className={profile.status === 'active' ? 'border-primary/50' : ''}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="truncate text-lg">{profile.config.name}</CardTitle>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t(`ui.builder.template.${profile.config.template}.title`)} · v{profile.version}
                    </p>
                  </div>
                  <Badge variant={profile.status === 'active' ? 'default' : 'secondary'}>
                    {t(`ui.builder.status.${profile.status}`)}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <Badge variant="outline">{t(profile.config.automation?.enabled ? 'strategy.paperLabel' : 'strategy.modeLegacy')}</Badge>
                <StrategyRuntimeCard profile={profile} />
                <div className="grid grid-cols-2 gap-3 rounded-lg bg-muted/40 p-3 text-xs">
                  <div><span className="text-muted-foreground">{t(profile.config.automation?.enabled ? 'strategy.monitorSeconds' : 'ui.builder.minimumRating')}</span>
                    <p className="mt-1 font-semibold">{profile.config.automation?.enabled ? profile.config.automation.monitorSeconds
                      : t(profile.config.minimumRating === 'Buy' ? 'ui.builder.ratingBuy' : 'ui.builder.ratingStrongBuy')}</p></div>
                  <div><span className="text-muted-foreground">{t('ui.builder.maxOrderPct')}</span>
                    <p className="mt-1 font-semibold">{profile.config.maxOrderPct}%</p></div>
                  <div><span className="text-muted-foreground">{t('ui.builder.maxOrdersPerDay')}</span>
                    <p className="mt-1 font-semibold">{profile.config.maxOrdersPerDay}</p></div>
                  <div className="min-w-0"><span className="text-muted-foreground">{t('ui.builder.tickers')}</span>
                    <p className="mt-1 truncate font-semibold">{profile.config.tickers.length
                      ? profile.config.tickers.join(', ') : t('ui.builder.allTracked')}</p></div>
                </div>
                <div className="rounded-lg border border-border p-3 text-xs leading-5 text-muted-foreground">
                  <p>{t(profile.config.automation?.enabled ? 'strategy.cadenceSummary' : 'council.cadence.summary', {
                    days: profile.config.cadence?.reviewEveryTradingDays ?? DEFAULT_CADENCE.reviewEveryTradingDays,
                    orders: profile.config.cadence?.maxOrdersPerWeek ?? DEFAULT_CADENCE.maxOrdersPerWeek,
                  })}</p>
                  <p className="mt-1">{t(profile.config.council?.enabled ? 'council.team.enabledHint' : 'council.team.rulesOnly')}</p>
                </div>
                {!profile.config.automation?.enabled && (profile.config.priceRules?.length ?? 0) > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      {t('ui.builder.priceRuleSummary')}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {profile.config.priceRules?.slice(0, 4).map((rule) => (
                        <Badge key={rule.ticker} variant="outline" className="font-normal">
                          {rule.ticker}
                          {rule.buyAtOrBelow !== undefined && ` · ≤${rule.buyAtOrBelow}`}
                          {rule.sellAtOrAbove !== undefined && ` · ≥${rule.sellAtOrAbove}`}
                        </Badge>
                      ))}
                      {(profile.config.priceRules?.length ?? 0) > 4 && (
                        <Badge variant="secondary">
                          {t('ui.builder.moreRules', {
                            count: (profile.config.priceRules?.length ?? 0) - 4,
                          })}
                        </Badge>
                      )}
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button asChild size="sm" variant="outline">
                    <Link to={`/council?profileId=${encodeURIComponent(profile.id)}`}><Users />{t('council.nav')}</Link>
                  </Button>
                  <Button type="button" size="sm" variant="outline"
                    disabled={profile.status === 'active'} onClick={() => openEdit(profile)}>
                    <Pencil /> {t('ui.builder.edit')}
                  </Button>
                  {profile.status === 'active' ? (
                    <>
                      <Button type="button" size="sm" variant="outline" disabled={busy}
                        onClick={() => pauseMutation.mutate(profile.id)}>
                        <CirclePause /> {t('ui.builder.pause')}
                      </Button>
                      <Button type="button" size="sm" disabled={busy}
                        onClick={() => runMutation.mutate(profile.id)}>
                        {runMutation.isPending ? <Loader2 className="animate-spin" /> : <Play />}
                        {t('ui.builder.runNow')}
                      </Button>
                    </>
                  ) : (
                    <Button type="button" size="sm" disabled={busy}
                      onClick={() => activateMutation.mutate(profile.id)}>
                      <Play /> {t('ui.builder.activate')}
                    </Button>
                  )}
                </div>
                {profile.status !== 'active' && active && (
                  <p className="text-xs text-muted-foreground">
                    {t('ui.builder.switchActiveHint', { name: active.config.name })}
                  </p>
                )}
                {profile.status === 'active' && (
                  <p className="text-xs text-muted-foreground">{t('ui.builder.pauseToEdit')}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="builder-inbox-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="builder-inbox-title" className="flex items-center gap-2 font-serif text-2xl font-semibold">
              <ClipboardCheck className="size-6 text-primary" /> {t('ui.builder.inbox')}
              {pending.length > 0 && <Badge>{pending.length}</Badge>}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('ui.builder.inboxHint')}</p>
          </div>
          <Link to="/paper" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
            <FlaskConical className="size-4" /> {t('ui.builder.openPaper')} <ArrowRight className="size-4" />
          </Link>
        </div>
        {proposalsQuery.isLoading && <p className="text-sm text-muted-foreground">{t('ui.builder.loading')}</p>}
        {proposalsQuery.isError && <p role="alert" className="text-sm text-destructive">
          {errorMessage(proposalsQuery.error, t('ui.builder.loadFailed'))}
        </p>}
        {!proposalsQuery.isLoading && !proposalsQuery.isError && pending.length === 0 && (
          <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">
            {t(profilesQuery.data?.some(profile => profile.config.automation?.enabled) ? 'strategy.emptyInbox' : 'ui.builder.emptyInbox')}
          </CardContent></Card>
        )}
        <div className="space-y-3">
          {pending.map((proposal: BuilderProposal) => (
            <ProposalCard key={proposal.id} proposal={proposal} profiles={profiles}
              formatDate={formatDate} onFill={() => openFill(proposal)}
              onSkip={() => skipMutation.mutate(proposal.id)}
              busy={skipMutation.isPending || fillMutation.isPending} />
          ))}
        </div>
        {history.length > 0 && (
          <div className="space-y-2 pt-2">
            <h3 className="text-sm font-semibold">{t('ui.builder.recentHistory')}</h3>
            {history.slice(0, 10).map((proposal: BuilderProposal) => (
              <div key={proposal.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm">
                <span className="font-medium">{proposal.ticker} · {t(`ui.builder.side.${proposal.side}`)}</span>
                <span className="text-muted-foreground">{formatDate(proposal.createdAt)}</span>
                <Badge variant="secondary">{t(`ui.builder.proposalStatus.${proposal.status}`)}</Badge>
              </div>
            ))}
          </div>
        )}
      </section>

      <Dialog open={selected !== null} onOpenChange={(open: boolean) => {
        if (!open) setSelected(null);
      }}>
        {selected && <DialogContent showCloseButton={false} className="max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="font-serif text-xl">
                {t('ui.builder.recordFillTitle')}
              </DialogTitle>
              <DialogDescription>
                {t('ui.builder.recordFillDescription', { ticker: selected.ticker })}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <p className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
                {t('ui.builder.fillSeparationNotice')}
              </p>
              <div className="space-y-2">
                <Label htmlFor="builder-fill-date">{t('ui.builder.executedAt')}</Label>
                <Input id="builder-fill-date" type="datetime-local" value={fill.executedAt}
                  onChange={(event) => setFill({ ...fill, executedAt: event.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2"><Label htmlFor="builder-fill-quantity">{t('ui.builder.quantity')}</Label>
                  <Input id="builder-fill-quantity" type="number" min="0.000001" step="any"
                    value={fill.quantity}
                    onChange={(event) => setFill({ ...fill, quantity: event.target.value })} /></div>
                <div className="space-y-2"><Label htmlFor="builder-fill-price">{t('ui.builder.price')}</Label>
                  <Input id="builder-fill-price" type="number" min="0.000001" step="any"
                    value={fill.price}
                    onChange={(event) => setFill({ ...fill, price: event.target.value })} /></div>
              </div>
              <div className="space-y-2"><Label htmlFor="builder-fill-fees">{t('ui.builder.fees')}</Label>
                <Input id="builder-fill-fees" type="number" min="0" step="any" value={fill.fees}
                  onChange={(event) => setFill({ ...fill, fees: event.target.value })} /></div>
              <div className="space-y-2"><Label htmlFor="builder-fill-notes">{t('ui.builder.notes')}</Label>
                <Textarea id="builder-fill-notes" value={fill.notes} maxLength={1000}
                  onChange={(event) => setFill({ ...fill, notes: event.target.value })} /></div>
              {fillError && <p role="alert" className="text-sm text-destructive">{fillError}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => setSelected(null)}>
                  {t('ui.builder.cancel')}
                </Button>
                <Button type="button" disabled={fillMutation.isPending} onClick={submitFill}>
                  {fillMutation.isPending && <Loader2 className="animate-spin" />}
                  {t('ui.builder.recordFill')}
                </Button>
              </div>
            </div>
          </DialogContent>}
      </Dialog>
    </div>
  );
}

interface ProposalCardProps {
  proposal: BuilderProposal;
  profiles: BuilderProfile[];
  formatDate: (value: string) => string;
  onFill: () => void;
  onSkip: () => void;
  busy: boolean;
}

function ProposalCard({ proposal, profiles, formatDate, onFill, onSkip, busy }: ProposalCardProps) {
  const { t } = useTranslation();
  const profile: BuilderProfile | undefined = profiles.find(
    (item: BuilderProfile) => item.id === proposal.profileId,
  );
  const expired: boolean = new Date(proposal.expiresAt).getTime() < Date.now();
  return (
    <Card>
      <CardContent className="space-y-4 pt-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={proposal.side === 'buy' ? 'default' : 'secondary'}>
                {t(`ui.builder.side.${proposal.side}`)}
              </Badge>
              <span className="text-lg font-semibold">{proposal.ticker}</span>
              <span className="text-xs text-muted-foreground">{proposal.market} · {proposal.currency}</span>
            </div>
            <p className="mt-2 break-words text-xs text-muted-foreground">
              {profile?.config.name ?? t('ui.builder.unknownAgent')} · v{proposal.profileVersion}
              {' · '}{formatDate(proposal.createdAt)}
            </p>
          </div>
          {expired && <Badge variant="destructive">{t('ui.builder.expired')}</Badge>}
        </div>
        <p className="break-words text-sm leading-6">{proposal.reason}</p>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <span>{t('ui.builder.suggestedQuantity')}: <strong className="text-foreground">{proposal.quantity}</strong></span>
          <span>{t('ui.builder.referencePrice')}: <strong className="text-foreground">{proposal.referencePrice} {proposal.currency}</strong></span>
          <span>{t('ui.builder.expires')}: {formatDate(proposal.expiresAt)}</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            {proposal.paperOrderId ? <FlaskConical className="size-3.5" /> : <Bell className="size-3.5" />}
            {proposal.paperOrderId
              ? t('ui.builder.paperLinked') : t('ui.builder.proposalOnly')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={busy}
              onClick={onSkip}>{t('ui.builder.skip')}</Button>
            <Button type="button" size="sm" disabled={busy || expired}
              onClick={onFill}>{t('ui.builder.recordRealFill')}</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
