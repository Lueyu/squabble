/**
 * TransactionList.tsx — 交易记录的移动端卡片列表（md 以下断点可见）。
 *
 * 职责边界：
 *  - 只负责把交易记录渲染成卡片：代码、买入 / 卖出徽标、日期、带符号金额、
 *    股数 / 价格 / 费用三列明细、可选备注，以及每张卡的删除按钮；
 *  - 桌面端表格不在这里，内联在 TransactionsPage 中；
 *  - 不发请求、不持状态：数据与 onAdd / onDelete 回调全部来自父组件。
 * 上下游：
 *  - 上游：TransactionsPage（mobile 视图分支）；
 *  - 下游：@/utils/format 的 formatPrice / formatShares / formatCurrencyWithCurrency /
 *    formatDate / plClass / cn、@/components/ui 的 Card / Button / Badge / Table 系 / Skeleton / Empty。
 * 关键约定：
 *  - Transaction 的 shares / price / fees 均为"字符串数值"（服务端序列化约定），
 *    现金流向符号约定：买入金额 = shares*price + fees（含费），卖出金额 = shares*price - fees（扣费）；
 *    计算前必须 parseFloat 转 number，fee 为空时按 '0' 兜底；
 *  - tx.currency 缺省时按 'USD' 展示。
 */
import { Receipt, Plus } from 'lucide-react';
import type { Transaction } from '@shared/api.interface';
import {
  formatPrice,
  formatShares,
  formatCurrencyWithCurrency,
  formatDate,
  plClass,
  cn,
} from '@/utils/format';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** {@link TransactionList} 的入参。 */
interface TransactionListProps {
  /** 加载中标记：为 true 时渲染骨架屏。 */
  loading: boolean;
  /** 加载错误文案：非 null 时渲染错误态（其余数据忽略）。 */
  error: string | null;
  /** 交易记录列表（金额字段为字符串数值）。 */
  transactions: Transaction[];
  /** 空态里"新增交易"按钮的点击回调（父组件打开 AddTransactionDialog）。 */
  onAdd: () => void;
  /** 删除按钮回调（父组件负责确认与请求）。 */
  onDelete: (id: string) => void;
}

/**
 * 渲染移动端交易记录卡片列表（含加载 / 错误 / 空态）。
 * @param props - 见 {@link TransactionListProps}。
 */
export default function TransactionList({
  loading,
  error,
  transactions,
  onAdd,
  onDelete,
}: TransactionListProps) {
  const { t } = useTranslation();

  // 加载中：3 根骨架条占位。
  if (loading) {
    return (
      <Card className="md:hidden">
        <CardContent className="p-4 space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  // 错误态：整块显示错误文案（文案由父组件生成）。
  if (error) {
    return <div className="p-8 text-center text-destructive text-sm md:hidden">{error}</div>;
  }

  // 空态：没有任何交易记录时，给一句提示 + 新增入口。
  if (transactions.length === 0) {
    return (
      <div className="md:hidden">
        <Empty>
          <EmptyMedia variant="icon">
            <Receipt />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>{t('ui.tx.emptyTx')}</EmptyTitle>
            <EmptyDescription>{t('ui.tx.emptyTxHint')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={onAdd}>
              <Plus className="size-4" />
              {t('tx.addTx')}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  // 正常态：逐条渲染交易卡片。
  return (
    <div className="md:hidden space-y-3">
      {transactions.map((tx) => {
        // 单笔现金金额：shares * price，买入加费用（含费）、卖出减费用（扣费）。
        // shares / price / fees 是字符串数值，必须 parseFloat 转 number；fees 为空按 '0'。
        const amount =
          parseFloat(tx.shares) * parseFloat(tx.price) +
          (tx.txType === 'Buy' ? parseFloat(tx.fees || '0') : -parseFloat(tx.fees || '0'));
        return (
          <Card key={tx.id}>
            <CardContent className="p-4">
              {/* 头部：代码 + 买/卖徽标 + 日期（左），带符号金额 + 删除按钮（右）。 */}
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono-nums font-bold text-primary">{tx.ticker}</span>
                    {/* 徽标：买入用主色，卖出用弱化色。 */}
                    <Badge
                      className={cn(
                        tx.txType === 'Buy'
                          ? 'bg-primary/10 text-primary'
                          : 'bg-muted text-muted-foreground',
                        'text-[10px]',
                      )}
                      variant="outline"
                    >
                      {tx.txType === 'Buy' ? t('tx.buy') : t('tx.sell')}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5 font-mono-nums">
                    {formatDate(tx.txDate)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="font-mono-nums text-lg font-semibold text-foreground">
                    {/* 现金流方向：买入是支出（-），卖出是收入（+）。 */}
                    <span className="text-muted-foreground">{tx.txType === 'Buy' ? '-' : '+'}</span>
                    {formatCurrencyWithCurrency(amount, tx.currency || 'USD')}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => onDelete(tx.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>

              {/* 明细三列：股数 / 价格 / 费用。 */}
              <div className="grid grid-cols-3 gap-2 mt-3 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground">{t('tx.shares')}</div>
                  <div className="font-mono-nums">{formatShares(tx.shares)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">{t('tx.price')}</div>
                  <div className="font-mono-nums">{formatPrice(tx.price)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">{t('tx.fees')}</div>
                  <div className="font-mono-nums">
                    {formatCurrencyWithCurrency(tx.fees || '0', tx.currency || 'USD')}
                  </div>
                </div>
              </div>

              {/* 备注：有才渲染，顶部加分隔线。 */}
              {tx.notes && (
                <div className="mt-3 pt-3 border-t text-xs text-muted-foreground">{tx.notes}</div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
