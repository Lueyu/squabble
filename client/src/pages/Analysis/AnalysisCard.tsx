/**
 * AnalysisCard.tsx — 单张每日分析卡（个股级或组合级）。
 *
 * 职责边界：
 *  - 个股卡展示目标价、操作建议、结论、催化剂与风险；默认折叠，底部有展开/收起按钮；
 *  - 存在关联深度报告时，催化剂/风险截断到 3 条，并显示"查看深度报告"入口
 *    （跳转 DeepReportPage）；
 *  - 组合卡（ticker === 'PORTFOLIO'）恒展开，渲染成特殊的"策略复盘"横幅样式；
 *  - 纯展示组件：不发请求，数据由父组件传入。
 * 上下游：
 *  - 上游：AnalysisPage（传统视图的卡片网格与组合卡）；
 *  - 下游：parseNumberedList / ratingTextColor / actionShortLabel / actionTextColor /
 *    localizedActionLabel / localizedRating（本文件内辅助）、
 *    @/utils/format（formatPriceWithCurrency、ratingColor、actionColor、cn）、
 *    inferMarket（@/hooks/use-market-quotes）、react-router（deep-report 跳转）。
 * 关键约定：
 *  - 目标价货币按市场推断：HK→HKD、CN→CNY、其余→USD；
 *  - 操作建议短标签的规则匹配均为正则白名单，勿改动字面量。
 */
import { useState } from 'react';
import {
  Target,
  TrendingUp,
  AlertTriangle,
  Sparkles,
  ChevronRight,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { Analysis as AnalysisType } from '@shared/api.interface';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { formatPriceWithCurrency, ratingColor, actionColor, cn } from '@/utils/format';
import { inferMarket } from '@/hooks/use-market-quotes';
import { useTranslation } from 'react-i18next';

/**
 * 把分号 / 换行分隔的文本拆成干净的条目列表，去掉开头的 "1." / "1)" / "1、"
 * 编号前缀。空文本返回 null。
 */
export function parseNumberedList(text: string | null): string[] | null {
  if (!text || !text.trim()) return null;
  const parts = text
    .split(/[；;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/^\d+[)\.、\s]+/, '').trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : null;
}

/** 组合级分析卡的特殊 ticker 哨兵值。 */
const PORTFOLIO_TICKER = 'PORTFOLIO';

/** 评级字符串对应的文字颜色（绿/黄/红）。 */
function ratingTextColor(rating: string | null | undefined): string {
  if (!rating) return 'text-muted-foreground';
  switch (rating) {
    case 'Strong Buy':
    case 'Buy':
      return 'text-success';
    case 'Hold':
      return 'text-warning';
    case 'Sell':
    case 'Strong Sell':
      return 'text-destructive';
    default:
      return 'text-muted-foreground';
  }
}

/**
 * 把自由文本的操作建议压缩成短标签（买入/减仓/持有/观望/卖出）。
 * 处理否定前缀（如"不买入"），把较长短语归入最近的类别；
 * 都匹配不上时截取前 5 个字符。
 */
function actionShortLabel(action: string | null | undefined): string {
  if (!action) return '—';
  const text = String(action);
  const stripped = text.replace(
    /(不|勿|别|无需|无须|不再|停止|暂停|暂缓|暂不)\s*(加仓|买入|增仓|增持|增加仓位|增加|追|加|买)/g,
    '',
  );
  if (/清仓|清空|全部卖|全部出|离场|止损出局/.test(stripped)) return '卖出';
  if (/减仓|减持|降低仓位|减至|再减|卖出|卖掉|售出|减/.test(stripped)) return '减仓';
  if (/买入|买进|建仓|低吸|吸筹|分批加|分批买|加仓|增持|增仓|可以加|可加|首批/.test(stripped))
    return '买入';
  if (/观望|等待|等回|不追|再看|观察|暂不/.test(text)) return '观望';
  if (/持有|维持|继续持有|定投|拿好/.test(text)) return '持有';
  return text.length > 5 ? text.slice(0, 5) + '…' : text;
}

/** 短操作标签对应的文字颜色。 */
function actionTextColor(action: string | null | undefined): string {
  if (!action) return 'text-muted-foreground';
  const label = actionShortLabel(action);
  switch (label) {
    case '加仓':
    case '买入':
      return 'text-success';
    case '持有':
      return 'text-warning';
    case '减仓':
    case '卖出':
      return 'text-destructive';
    case '观望':
      return 'text-foreground';
    default:
      return 'text-muted-foreground';
  }
}

/** 把中文动作短标签映射到 i18n key 输出本地化文案；未收录的标签原样返回。 */
function localizedActionLabel(
  action: string | null | undefined,
  t: (key: string) => string,
): string {
  const label = actionShortLabel(action);
  const keys: Record<string, string> = {
    加仓: 'analysis.add',
    买入: 'analysis.buy',
    持有: 'analysis.hold',
    减仓: 'analysis.reduce',
    卖出: 'analysis.sell',
    观望: 'analysis.watch',
  };
  return keys[label] ? t(keys[label]) : label;
}

/** 评级英文原词 → i18n 本地化文案；无匹配时原样返回（空值返回空串）。 */
function localizedRating(value: string | null, t: (key: string) => string): string {
  const keys: Record<string, string> = {
    'Strong Buy': 'analysis.strongBuy',
    Buy: 'analysis.buy',
    Hold: 'analysis.hold',
    Sell: 'analysis.sell',
    'Strong Sell': 'analysis.strongSell',
  };
  return value && keys[value] ? t(keys[value]) : (value ?? '');
}

/** {@link AnalysisCard} 的入参。 */
interface AnalysisCardProps {
  /** 该卡的每日分析数据。 */
  analysis: AnalysisType;
  /** 公司名（可选，头部展示用）。 */
  companyName?: string | null;
  /** 关联深度报告的 run id；存在时显示"查看深度报告"入口。 */
  deepReportRunId?: string | null;
}

/**
 * 渲染一张分析卡。个股卡默认折叠；组合卡恒展开。
 */
function AnalysisCard({ analysis, companyName, deepReportRunId }: AnalysisCardProps) {
  // ===== 状态声明区 =====
  const { t } = useTranslation();
  const navigate = useNavigate();
  // 个股卡的展开态；组合卡不依赖它（isCollapsed 恒 false）。
  const [expanded, setExpanded] = useState(false);

  // ===== 派生计算区 =====
  // 催化剂 / 风险：按分号或换行拆成编号列表。
  const catalysts = parseNumberedList(analysis.catalysts);
  const risks = parseNumberedList(analysis.risks);
  const isPortfolio = analysis.ticker === PORTFOLIO_TICKER;
  const hasDeepReport = Boolean(deepReportRunId);
  // 目标价货币按市场推断：HK→HKD、CN→CNY、其余→USD。
  const market = isPortfolio ? 'US' : inferMarket(analysis.ticker);
  const targetCurrency = market === 'HK' ? 'HKD' : market === 'CN' ? 'CNY' : 'USD';

  // 有深度报告时把催化剂 / 风险截断到 3 条（完整版在 DeepReportPage 中查看）。
  const displayCatalysts = catalysts && hasDeepReport ? catalysts.slice(0, 3) : catalysts;
  const displayRisks = risks && hasDeepReport ? risks.slice(0, 3) : risks;

  // 折叠态：组合卡永不折叠。
  const isCollapsed = !isPortfolio && !expanded;

  /** 跳转到深度报告详情页。 */
  const handleDeepReportClick = () => {
    if (deepReportRunId) {
      navigate(`/analysis/deep-report/${deepReportRunId}`);
    }
  };

  return (
    // 卡片样式：组合卡加主色渐变底；关联深度报告时琥珀色描边。
    <Card
      className={cn(
        'flex flex-col relative overflow-hidden',
        isPortfolio && 'border-primary/40 bg-gradient-to-br from-primary/5 via-card to-card',
        deepReportRunId && 'border-amber-500/40',
      )}
    >
      {/* ===== 卡头：组合卡走策略复盘横幅，个股卡走 ticker + 评级徽标 ===== */}
      <CardHeader className="pb-3">
        {isPortfolio ? (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              <CardTitle className="font-serif text-lg text-primary">
                {t('ui.analysis.portfolioReview')}
              </CardTitle>
            </div>
            <CardDescription>{t('ui.analysis.portfolioDescription')}</CardDescription>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <CardTitle className="font-mono-nums text-lg font-semibold tracking-tight truncate">
                {analysis.ticker}
              </CardTitle>
              <CardDescription className="mt-0.5 flex items-center gap-1.5 text-sm truncate">
                {companyName && <span className="truncate">{companyName}</span>}
                {companyName && analysis.targetPrice && (
                  <span className="text-muted-foreground/40 shrink-0">·</span>
                )}
                {analysis.targetPrice && (
                  <span className="font-mono-nums text-xs shrink-0">
                    {t('ui.analysis.targetPrice')}{' '}
                    {formatPriceWithCurrency(analysis.targetPrice, targetCurrency)}
                  </span>
                )}
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-1.5 shrink-0">
              {analysis.rating && (
                <Badge
                  variant="outline"
                  className={cn(
                    'border-transparent text-[11px] font-medium rounded-md',
                    ratingColor(analysis.rating),
                  )}
                >
                  {localizedRating(analysis.rating, t)}
                </Badge>
              )}
              {deepReportRunId && (
                <button onClick={handleDeepReportClick} className="inline-flex">
                  <Badge
                    variant="outline"
                    title={t('ui.analysis.deepReportTooltip')}
                    className="gap-1 border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium text-[11px] rounded-md hover:bg-amber-500/20 transition-colors"
                  >
                    <Sparkles size={11} />
                    {t('ui.analysis.deepReport')}
                  </Badge>
                </button>
              )}
            </div>
          </div>
        )}
      </CardHeader>

      <Separator />

      {/* 核心数字行：目标价 + 操作建议短标签（仅个股卡显示） */}
      {!isPortfolio && (
        <div className="grid grid-cols-1 gap-2 px-5 py-4 sm:grid-cols-2">
          {/* 目标价 */}
          <div className="flex flex-col items-center justify-center rounded-md bg-muted/30 px-2 py-3">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {t('ui.analysis.targetPrice')}
            </span>
            <span className="mt-0.5 font-serif text-3xl font-bold text-foreground sm:text-2xl">
              {analysis.targetPrice
                ? formatPriceWithCurrency(analysis.targetPrice, targetCurrency)
                : '—'}
            </span>
          </div>
          {/* 操作建议（短标签，按语义着色） */}
          <div className="flex flex-col items-center justify-center rounded-md bg-muted/30 px-2 py-3">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {t('ui.analysis.actionAdvice')}
            </span>
            <span
              className={cn(
                'mt-0.5 font-serif text-2xl font-bold sm:text-xl',
                actionTextColor(analysis.action),
              )}
            >
              {analysis.action ? localizedActionLabel(analysis.action, t) : '—'}
            </span>
          </div>
        </div>
      )}

      {/* 组合卡的目标价一行式展示 */}
      {isPortfolio && analysis.targetPrice && (
        <div className="px-5 pt-4">
          <div className="flex items-center gap-2">
            <Target className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">{t('ui.analysis.targetPrice')}</span>
            <span className="font-mono-nums text-sm font-semibold text-foreground">
              {formatPriceWithCurrency(analysis.targetPrice, targetCurrency)}
            </span>
          </div>
        </div>
      )}

      <CardContent className={cn('flex-1 space-y-4 pt-4', isPortfolio && 'pt-4')}>
        {/* 操作建议全文（所有屏宽通栏显示，仅个股卡） */}
        {!isPortfolio && analysis.action && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Target className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
              {t('ui.analysis.actionAdvice')}
            </div>
            <p
              className={cn(
                'whitespace-pre-wrap break-words text-sm font-medium leading-relaxed',
                actionTextColor(analysis.action),
              )}
            >
              {analysis.action}
            </p>
          </div>
        )}

        {/* 分析结论区（组合卡标题为"策略观点"）；折叠时截成两行 */}
        {analysis.analysis && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Target className="h-3.5 w-3.5 text-primary" />
              {isPortfolio ? t('ui.analysis.strategyView') : t('ui.analysis.conclusion')}
            </div>
            <p
              className={cn(
                'whitespace-pre-wrap text-sm leading-relaxed text-foreground/80',
                isCollapsed && 'line-clamp-2',
              )}
            >
              {analysis.analysis}
            </p>
          </div>
        )}

        {/* 催化剂 + 风险区（什么时候走到这里：展开状态或组合卡，且至少有一项内容） */}
        {!isCollapsed &&
          (catalysts || risks || analysis.catalysts?.trim() || analysis.risks?.trim()) && (
            <>
              <Separator className="my-1" />
              <div className="grid gap-4 md:grid-cols-2">
                {/* 催化剂：有编号列表时按列表渲染；有深度报告且超过 3 条时提示剩余条数 */}
                {displayCatalysts ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                      <TrendingUp className="h-3.5 w-3.5 text-success" />
                      {t('ui.analysis.keyCatalysts')}
                    </div>
                    <ul className="space-y-1 text-sm">
                      {displayCatalysts.map((c, i) => (
                        <li key={i} className="flex gap-2 text-foreground/75">
                          <span className="font-mono-nums text-xs text-success shrink-0">
                            {i + 1}.
                          </span>
                          <span>{c}</span>
                        </li>
                      ))}
                      {hasDeepReport && catalysts && catalysts.length > 3 && (
                        <li className="text-xs text-muted-foreground">
                          {t('ui.analysis.moreCatalysts', { count: catalysts.length - 3 })}
                        </li>
                      )}
                    </ul>
                  </div>
                ) : analysis.catalysts?.trim() ? (
                  /* 什么时候走到这里：催化剂没有编号列表但原文非空——直接展示文本（有深度报告且超 150 字时截断） */
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                      <TrendingUp className="h-3.5 w-3.5 text-success" />
                      {t('ui.analysis.keyCatalysts')}
                    </div>
                    <p className="text-sm text-foreground/75">
                      {hasDeepReport && analysis.catalysts.length > 150
                        ? analysis.catalysts.slice(0, 150) + '...'
                        : analysis.catalysts}
                    </p>
                  </div>
                ) : null}

                {/* 风险：同样先按编号列表，再回退原文展示 */}
                {displayRisks ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                      <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                      {t('ui.analysis.riskNotes')}
                    </div>
                    <ul className="space-y-1 text-sm">
                      {displayRisks.map((r, i) => (
                        <li key={i} className="flex gap-2 text-foreground/75">
                          <span className="font-mono-nums text-xs text-destructive shrink-0">
                            {i + 1}.
                          </span>
                          <span>{r}</span>
                        </li>
                      ))}
                      {hasDeepReport && risks && risks.length > 3 && (
                        <li className="text-xs text-muted-foreground">
                          {t('ui.analysis.moreRisks', { count: risks.length - 3 })}
                        </li>
                      )}
                    </ul>
                  </div>
                ) : analysis.risks?.trim() ? (
                  /* 什么时候走到这里：风险没有编号列表但原文非空——直接展示文本（有深度报告且超 150 字时截断） */
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                      <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                      {t('ui.analysis.riskNotes')}
                    </div>
                    <p className="text-sm text-foreground/75">
                      {hasDeepReport && analysis.risks.length > 150
                        ? analysis.risks.slice(0, 150) + '...'
                        : analysis.risks}
                    </p>
                  </div>
                ) : null}
              </div>
            </>
          )}
      </CardContent>

      {/* 个股卡底部的展开 / 收起按钮（组合卡恒展开，无此按钮） */}
      {!isPortfolio && (
        <div className="px-3 pb-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-xs text-muted-foreground"
            onClick={() => setExpanded((v: boolean) => !v)}
          >
            {expanded ? (
              <ChevronUp className="mr-1 h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="mr-1 h-3.5 w-3.5" />
            )}
            {expanded ? t('ui.analysis.collapse') : t('analysis.expandDetail')}
          </Button>
        </div>
      )}

      {/* 深度报告底部链接（什么时候走到这里：传入了 deepReportRunId） */}
      {deepReportRunId && (
        <>
          <Separator />
          <div className="px-5 py-3">
            <button
              onClick={handleDeepReportClick}
              className="flex w-full items-center justify-between text-xs font-medium text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300 transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <Sparkles size={12} />
                {t('ui.analysis.viewDeepReport')}
              </span>
              <ChevronRight size={14} />
            </button>
          </div>
        </>
      )}
    </Card>
  );
}

export default AnalysisCard;
