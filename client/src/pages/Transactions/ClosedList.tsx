/**
 * ClosedList.tsx — 已平仓头寸的移动端卡片列表（md 以下断点可见）。
 *
 * 职责边界：
 *  - 只负责把已平仓记录渲染成卡片：代码、公司名、已实现盈亏（按正负着色）、
 *    收益率、开 / 平仓日期、买卖价、股数与备注；
 *  - 处理三种前置态：加载骨架屏、错误文案、空态（空态内提供"新增平仓记录"入口）；
 *  - 不发请求、不持状态，数据与 onAdd 回调全部来自父组件 TransactionsPage。
 * 上下游：
 *  - 上游：TransactionsPage（mobile 视图分支；桌面表格由同页另一组件承担）；
 *  - 下游：@/utils/format 的格式化工具（formatPrice / formatShares / formatCurrency /
 *    formatPercent / formatDate / plClass / cn）、@/components/ui 的 Card / Button / Skeleton / Empty。
 * 关键约定：
 *  - ClosedPosition 的金额与股数字段（buyPrice / sellPrice / shares / realizedPl / returnPct）
 *    均为"字符串数值"（服务端序列化约定），展示必须走 format* 工具，禁止直接做算术；
 *  - 字段可能为 null（未知），format* 工具内部兜底为 '—'。
 */
import { TrendingDown, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ClosedPosition } from '@shared/api.interface';
import {
  formatPrice,
  formatShares,
  formatCurrency,
  formatPercent,
  formatDate,
  plClass,
  cn,
} from '@/utils/format';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

/** {@link ClosedList} 的入参。 */
interface ClosedListProps {
  /** 加载中标记：为 true 时渲染骨架屏。 */
  loading: boolean;
  /** 加载错误文案：非 null 时渲染错误态（其余数据忽略）。 */
  error: string | null;
  /** 已平仓头寸列表（金额 / 股数字段为字符串数值）。 */
  closed: ClosedPosition[];
  /** 空态里"新增平仓记录"按钮的点击回调（父组件打开 AddClosedDialog）。 */
  onAdd: () => void;
}

/**
 * 渲染移动端已平仓头寸卡片列表（含加载 / 错误 / 空态）。
 * @param props - 见 {@link ClosedListProps}。
 */
export default function ClosedList({ loading, error, closed, onAdd }: ClosedListProps) {
  const { t } = useTranslation();

  // 加载中：渲染 3 张骨架卡片占位，保持与真实卡片近似的布局。
  if (loading) {
    return (
      <div className="md:hidden space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="p-4 space-y-3">
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-8 w-32" />
              <div className="grid grid-cols-2 gap-3">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  // 错误态：整块显示错误文案（文案由父组件生成）。
  if (error) {
    return <div className="p-8 text-center text-destructive text-sm md:hidden">{error}</div>;
  }

  // 空态：没有任何平仓记录时，给一句提示 + 新增入口。
  if (closed.length === 0) {
    return (
      <div className="md:hidden">
        <Empty>
          <EmptyMedia variant="icon">
            <TrendingDown />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>{t('ui.tx.emptyClosed')}</EmptyTitle>
            <EmptyDescription>{t('ui.tx.emptyClosedHint')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={onAdd}>
              <Plus className="size-4" />
              {t('ui.tx.addClosed')}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  // 正常态：逐条渲染平仓卡片。左上代码 / 公司名，右上盈亏与收益率（按正负着色）。
  return (
    <div className="md:hidden space-y-3">
      {closed.map((c) => (
        <Card key={c.id}>
          <CardContent className="p-4">
            {/* 头部：代码 + 公司名（左），已实现盈亏 + 收益率（右，正绿负红）。 */}
            <div className="flex items-start justify-between">
              <div>
                <div className="font-mono-nums font-bold text-primary text-lg">{c.ticker}</div>
                <div className="text-sm text-muted-foreground truncate max-w-[200px]">
                  {c.company ?? '—'}
                </div>
              </div>
              <div className="text-right">
                {/* realizedPl / returnPct 为字符串数值，经 formatCurrency / formatPercent 转展示。 */}
                <div className={cn('font-mono-nums text-lg font-semibold', plClass(c.realizedPl))}>
                  {formatCurrency(c.realizedPl)}
                </div>
                <div className={cn('font-mono-nums text-sm', plClass(c.returnPct))}>
                  {formatPercent(c.returnPct)}
                </div>
              </div>
            </div>

            {/* 明细网格：日期与价格股数两列排布。 */}
            <div className="grid grid-cols-2 gap-2 mt-3 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">{t('tx.openDate')}</div>
                <div className="font-mono-nums">{formatDate(c.openDate)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">{t('tx.closeDate')}</div>
                <div className="font-mono-nums">{formatDate(c.closeDate)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">{t('tx.buyPrice')}</div>
                <div className="font-mono-nums">{formatPrice(c.buyPrice)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">{t('tx.sellPrice')}</div>
                <div className="font-mono-nums">{formatPrice(c.sellPrice)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">{t('tx.shares')}</div>
                <div className="font-mono-nums">{formatShares(c.shares)}</div>
              </div>
            </div>

            {/* 备注：有才渲染，顶部加分隔线。 */}
            {c.notes && (
              <div className="mt-3 pt-3 border-t text-xs text-muted-foreground">{c.notes}</div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
