/**
 * @file components/MarketStatusBadges.tsx
 * @description 各市场（US/HK/CN）交易阶段徽章，渲染在带行情数据的页面上。
 *
 * 视觉编码约定：
 *  - trading = 绿色，pre = 蓝色，post = 橙色，closed = 灰色弱化。
 *  - 无持仓/自选条目的市场降灰并标注"未持仓"。
 *  - 最近一次行情抓取失败（数据过期）的市场标红色 "!" 与红点。
 *  - "最后更新 HH:mm:ss" 行展示最近一次成功刷新行情的时间。
 */
import { Badge } from '@/components/ui/badge';
import { formatTime, cn } from '@/utils/format';
import { useTranslation } from 'react-i18next';
import type { Market } from '@shared/api.interface';
import type { MarketPhase } from '@/hooks/use-market-quotes';

/** 应用追踪的市场，按展示顺序排列。 */
const MARKETS: Market[] = ['US', 'HK', 'CN'];

/** 阶段配色保持语义稳定；文案来自当前 locale。 */
const PHASE_CLASSES: Record<MarketPhase, string> = {
  trading: 'bg-success/15 text-success border-transparent',
  pre: 'bg-blue-500/15 text-blue-600 border-transparent',
  post: 'bg-orange-500/15 text-orange-600 border-transparent',
  closed: 'bg-muted text-muted-foreground border-transparent',
};

/** {@link MarketStatusBadges} 的 props。 */
export interface MarketStatusBadgesProps {
  /** 各市场当前交易阶段，来自 useMarketQuotes 的流式数据。 */
  marketStatus: Record<Market, MarketPhase>;
  /** 各市场最近一次行情抓取是否失败（数据过期标记）。 */
  marketErrors: Record<Market, boolean>;
  /** 最近一次成功刷新行情的时间戳；首次抓取前为 null。 */
  lastUpdated: Date | null;
  /** 无持仓/自选条目的市场 —— 显示降灰的"未持仓"状态 */
  inactiveMarkets?: Market[];
  /** 布局变体 —— 徽章与时间同行（inline）或上下堆叠（stack） */
  layout?: 'inline' | 'stack';
}

/**
 * 每个市场渲染一枚当前交易阶段徽章。
 * @param props - 见 {@link MarketStatusBadgesProps}。
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
  // 市场名与阶段名的 i18n 文案映射。
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

  // 逐市场生成徽章：未持仓市场整体降灰；抓取失败且仍持仓的市场附加红色 "!" 与角标红点。
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

  // stack 布局：徽章一行，"最后更新"时间另起一行。
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

  // 默认 inline 布局：徽章与"最后更新"时间同行，用中点分隔。
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
