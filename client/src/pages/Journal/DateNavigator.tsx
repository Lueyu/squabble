/**
 * DateNavigator.tsx — 交易日志页的日期导航条（前后翻日 + 日期选择 + 当日快照统计条）。
 *
 * 职责边界：
 *  - 上排：前一天 / 后一天按钮、可点击的当前日期（弹出原生日期选择浮层）；
 *  - 下排：所选日期的快照四格统计（每日盈亏、当日收益率、账户净值、现金），
 *    盈亏两格按正负着色（plClass）；
 *  - 不持业务状态：日期切换通过 onPrev / onNext / onDateChange 回调抛给父组件，
 *    快照数据与加载态也由父组件下发。
 * 上下游：
 *  - 上游：JournalPage（currentDate / snapshot / loading / 三个回调）；
 *  - 下游：@/components/ui 的 Card / Button / Skeleton / Input、
 *    @/utils/format 的 formatCurrency / formatPercent / formatDate / plClass / cn、
 *    react-i18next（文案）。
 * 关键约定：
 *  - Snapshot 的 dailyPl / dailyPct / accountValue / cash 均为"字符串数值"
 *    （服务端序列化约定），展示必须走 format* 工具，禁止直接做算术；
 *  - 日期输入浮层里的 input 草稿为本地 state，初始值只在首次渲染取 currentDate；
 *    之后父组件切换日期不会回填该输入框（现状如此，非缺陷修复范围）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronLeft,
  ChevronRight,
  Calendar,
  TrendingUp,
  TrendingDown,
  Wallet,
  DollarSign,
} from 'lucide-react';
import type { Snapshot } from '@shared/api.interface';
import { formatCurrency, formatPercent, formatDate, plClass, cn } from '@/utils/format';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';

/** 把 Date 格式化为 `YYYY-MM-DD`，供原生 date input 使用。 */
function formatDateInput(d: Date): string {
  // 年、月、日分别取出，月 / 日补零到两位。
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** {@link DateNavigator} 的入参。 */
interface DateNavigatorProps {
  /** 当前选中的日志日期（由父组件持有）。 */
  currentDate: Date;
  /** 该日期对应的账户快照；无快照为 undefined（渲染占位文案）。 */
  snapshot: Snapshot | undefined;
  /** 加载中标记：为 true 时统计条渲染骨架。 */
  loading: boolean;
  /** 切到前一天的回调（父组件改 currentDate）。 */
  onPrev: () => void;
  /** 切到后一天的回调。 */
  onNext: () => void;
  /** 日期选择浮层确认后的回调（父组件加载对应日期数据）。 */
  onDateChange: (date: Date) => void;
}

/**
 * 渲染日期导航条：前后翻日按钮 + 日期选择浮层 + 当日快照统计条。
 * @param props - 见 {@link DateNavigatorProps}。
 */
export function DateNavigator({
  currentDate,
  snapshot,
  loading,
  onPrev,
  onNext,
  onDateChange,
}: DateNavigatorProps) {
  const { t } = useTranslation();
  // 日期选择浮层开关。
  const [open, setOpen] = useState(false);
  // 日期输入草稿：初始值取 currentDate（仅首次渲染生效，见文件头约定）。
  const [input, setInput] = useState(formatDateInput(currentDate));

  // 提交所选日期：解析合法才回调 onDateChange 并收起浮层；非法输入静默忽略。
  const handleSubmit = () => {
    const d = new Date(input);
    if (!isNaN(d.getTime())) {
      onDateChange(d);
      setOpen(false);
    }
  };

  // 渲染区：单卡片两行 —— 上排导航按钮，下排快照统计。
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          {/* 上排：前一天 → 日期按钮（点击开浮层）→ 后一天。 */}
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={onPrev} className="h-9 w-9">
              <ChevronLeft size={16} />
            </Button>
            <div className="relative">
              {/* 日期按钮：点击切换浮层开合。 */}
              <button
                onClick={() => setOpen((v) => !v)}
                className="flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm hover:border-ring"
              >
                <Calendar size={14} className="text-primary" />
                <span className="font-mono tabular-nums font-medium">
                  {formatDate(currentDate)}
                </span>
              </button>
              {/* 日期选择浮层：仅 open 时渲染；原生 date input + 确认按钮。 */}
              {open && (
                <div className="absolute left-0 top-full z-10 mt-1 flex gap-2 rounded-md border bg-background p-2 shadow-md">
                  <Input
                    type="date"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    className="w-auto"
                  />
                  <Button size="sm" onClick={handleSubmit}>
                    {t('ui.journal.confirmDate')}
                  </Button>
                </div>
              )}
            </div>
            <Button variant="outline" size="icon" onClick={onNext} className="h-9 w-9">
              <ChevronRight size={16} />
            </Button>
          </div>

          {/* 下排：四格统计。加载骨架 / 有快照 / 无快照三种分支。 */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {loading ? (
              // 加载中：4 个骨架块占位。
              Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-28" />)
            ) : snapshot ? (
              // 有快照：渲染四格。盈亏两格的图标与数值都按正负着色。
              <>
                <div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <TrendingUp size={12} className={plClass(snapshot.dailyPl)} />
                    {t('journal.dailyPl')}
                  </div>
                  <div
                    className={cn(
                      'font-mono text-lg font-semibold tabular-nums',
                      plClass(snapshot.dailyPl),
                    )}
                  >
                    {/* dailyPl 为字符串数值，经 formatCurrency 转展示。 */}
                    {formatCurrency(snapshot.dailyPl)}
                  </div>
                </div>
                <div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <TrendingDown size={12} className={plClass(snapshot.dailyPct)} />
                    {t('ui.journal.dailyReturn')}
                  </div>
                  <div
                    className={cn(
                      'font-mono text-lg font-semibold tabular-nums',
                      plClass(snapshot.dailyPct),
                    )}
                  >
                    {/* dailyPct 为百分比字符串数值，经 formatPercent 转展示。 */}
                    {formatPercent(snapshot.dailyPct)}
                  </div>
                </div>
                <div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Wallet size={12} className="text-primary" />
                    {t('ui.journal.accountValue')}
                  </div>
                  <div className="font-mono text-lg font-semibold tabular-nums text-foreground">
                    {formatCurrency(snapshot.accountValue)}
                  </div>
                </div>
                <div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <DollarSign size={12} className="text-primary" />
                    {t('ui.journal.cash')}
                  </div>
                  <div className="font-mono text-lg font-semibold tabular-nums text-foreground">
                    {formatCurrency(snapshot.cash)}
                  </div>
                </div>
              </>
            ) : (
              // 无快照：该日期没有记录，占位一行提示。
              <div className="col-span-4 py-2 text-center text-sm text-muted-foreground">
                {t('ui.journal.noSnapshotForDate')}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
