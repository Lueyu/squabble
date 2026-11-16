/**
 * @file components/MarketStatusBadges.tsx
 * @description Per-market phase badges (US/HK/CN) rendered on quote-bearing pages.
 *
 * Visual encoding:
 *  - trading = green, pre = blue, post = orange, closed = muted gray.
 *  - Markets with no holdings/watch items are dimmed and labeled "未持仓".
 *  - A red "!" + dot marks markets whose last quote fetch failed (stale data).
 *  - The "最后更新 HH:mm:ss" line shows the last successful quote refresh.
 */
import { Badge } from '@/components/ui/badge';
import { formatTime, cn } from '@/utils/format';
import { useTranslation } from 'react-i18next';
import type { Market } from '@shared/api.interface';
import type { MarketPhase } from '@/hooks/use-market-quotes';

/** Markets the app tracks, in display order. */
const MARKETS: Market[] = ['US', 'HK', 'CN'];

/** Phase colors stay semantic; labels come from the active locale. */
const PHASE_CLASSES: Record<MarketPhase, string> = {
  trading: 'bg-success/15 text-success border-transparent',
  pre: 'bg-blue-500/15 text-blue-600 border-transparent',
  post: 'bg-orange-500/15 text-orange-600 border-transparent',
  closed: 'bg-muted text-muted-foreground border-transparent',
};

/** Props for {@link MarketStatusBadges}. */
export interface MarketStatusBadgesProps {
  /** Current trading phase per market, as streamed by useMarketQuotes. */
  marketStatus: Record<Market, MarketPhase>;
  /** Whether the most recent quote fetch failed per market (stale-data flag). */
  marketErrors: Record<Market, boolean>;
  /** Timestamp of the last successful quote refresh; null before first fetch. */
  lastUpdated: Date | null;
  /** Markets that have no holdings/watch items — show dimmed "未持仓" state */
  inactiveMarkets?: Market[];
  /** Layout variant — badges inline with time or stacked */
  layout?: 'inline' | 'stack';
}

/**
 * Render one badge per market showing its current session phase.
 * @param props - See {@link MarketStatusBadgesProps}.
 */
export function MarketStatusBadges({
  marketStatus,
  marketErrors,
  lastUpdated,
  inactiveMarkets = [],
  layout = 'inline',
}: MarketStatusBadgesProps) {
  const { t } = useTranslation();
  const inactiveSet = new Set(inactiveMarkets);
  const marketLabels: Record<Market, string> = {
    US: t('common.usMarket'),
    HK: t('common.hkMarket'),
    CN: t('common.cnMarket'),
  };
  const phaseLabels: Record<MarketPhase, string> = {
    trading: t('layout.trading'),
    pre: t('ui.market.preMarket'),
    post: t('ui.market.afterHours'),
    closed: t('layout.closed'),
  };

  const badges = MARKETS.map((market) => {
    const isInactive = inactiveSet.has(market);
    const hasError = marketErrors[market] === true;
    const phase = marketStatus[market];
    const badgeClass = isInactive
      ? 'bg-muted/50 text-muted-foreground/50 border-transparent'
      : PHASE_CLASSES[phase];

    const label = isInactive ? t('ui.market.notHeld') : phaseLabels[phase];

    return (
      <div key={market} className="relative inline-flex items-center">
        <Badge variant="outline" className={cn('h-5 px-2 text-[11px] font-medium', badgeClass)}>
          {marketLabels[market]} · {label}
          {hasError && !isInactive && <span className="ml-1 text-destructive font-bold">!</span>}
        </Badge>
        {hasError && !isInactive && (
          <span
            className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-destructive"
            aria-label={t('ui.market.quoteDelayed')}
          />
        )}
      </div>
    );
  });

  if (layout === 'stack') {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">{badges}</div>
        {lastUpdated && (
          <span className="text-xs text-muted-foreground">
            {t('dash.lastUpdate', { time: formatTime(lastUpdated) })}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {badges}
      {lastUpdated && (
        <>
          <span className="mx-0.5 text-muted-foreground">·</span>
          <span className="text-xs text-muted-foreground">
            {t('dash.lastUpdate', { time: formatTime(lastUpdated) })}
          </span>
        </>
      )}
    </div>
  );
}
