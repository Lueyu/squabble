/**
 * DetailDialog.tsx — 自选股条目的详情 / 编辑对话框。
 *
 * 职责边界：
 *  - 只读视图：信号 / 评级 / 行业徽标、加入日期与三个价格的统计块、
 *    "低于目标买价"的机会提示条、分析备注，以及删除 / 编辑按钮；
 *  - 编辑视图：切换为共用受控表单 WatchForm，保存走 PATCH；
 *  - 删除走二次确认：主对话框内点删除 → 弹独立确认对话框 → 确认后才真正删。
 * 上下游：
 *  - 上游：WatchlistPage（open / item / onUpdated / onDeleted）；
 *  - 下游：./WatchForm（共用表单 + WatchFormData 类型）、@/api 的 updateWatchItem / deleteWatchItem、
 *    sonner 的 toast、@/utils/format 的 formatPrice / formatPercent / formatDate / signalColor /
 *    ratingColor / cn / toDate、@/components/ui 的 Dialog 系 / Button / Badge。
 * 关键约定：
 *  - WatchItem 的 entryPrice / currentPrice / targetBuy 均为"字符串数值"或 null；
 *    表单内一律保持 string，提交时经 parseNumber 转 number（空 / NaN → undefined 表示不改）；
 *  - PATCH payload 用 undefined 表达"该字段不改"，用 trim 后空串→undefined 表达清空文本字段；
 *  - belowTargetPct 仅在现价严格低于目标买价时返回正百分比，否则 null（不显示机会提示）。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { WatchItem, Signal } from '@shared/api.interface';
import { updateWatchItem, deleteWatchItem } from '@/api';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  formatPrice,
  formatPercent,
  formatDate,
  signalColor,
  ratingColor,
  cn,
  toDate,
} from '@/utils/format';
import WatchForm, { type WatchFormData } from './WatchForm';

/** {@link DetailDialog} 的入参。 */
interface DetailDialogProps {
  /** 对话框开关（受控）。 */
  open: boolean;
  /** 开关变更回调（父组件持有 open state）。 */
  onOpenChange: (open: boolean) => void;
  /** 当前查看的自选股条目；null 时渲染空壳。 */
  item: WatchItem | null;
  /** 更新成功后的回调（父组件刷新列表）。 */
  onUpdated: () => void;
  /** 删除成功后的回调。 */
  onDeleted: () => void;
}

/** 信号下拉的可选值（与库中存储的中文原文一致）。 */
const SIGNAL_OPTIONS: Signal[] = ['强烈买入', '买入', '观望', '回避'];
/** 评级下拉的可选值（英文原文）。 */
const RATING_OPTIONS = ['Strong Buy', 'Buy', 'Hold', 'Sell', 'Strong Sell'];

/** 信号值（中文或英文原文）→ i18n 文案；映射表未收录的原样返回。 */
function localizedSignal(signal: string, t: (key: string) => string): string {
  const keys: Record<string, string> = {
    强烈买入: 'analysis.strongBuy',
    'Strong Buy': 'analysis.strongBuy',
    买入: 'analysis.buy',
    Buy: 'analysis.buy',
    观望: 'analysis.watch',
    Watch: 'analysis.watch',
    回避: 'analysis.avoid',
    Avoid: 'analysis.avoid',
  };
  return keys[signal] ? t(keys[signal]) : signal;
}

/**
 * 把 WatchItem 转成受控表单形状。
 * 日期归一化为 ISO `YYYY-MM-DD`（date input 需要的格式）；null 字段转空串。
 */
function toFormData(item: WatchItem | null): WatchFormData {
  // 无条目：返回空白表单，dateAdded 默认今天。
  if (!item) {
    return {
      ticker: '',
      company: '',
      sector: '',
      dateAdded: new Date().toISOString().split('T')[0],
      entryPrice: '',
      currentPrice: '',
      targetBuy: '',
      rating: '',
      signal: '',
      analysis: '',
    };
  }
  // 有条目：null → ''，日期转 YYYY-MM-DD。
  return {
    ticker: item.ticker,
    company: item.company ?? '',
    sector: item.sector ?? '',
    dateAdded: item.dateAdded ? (toDate(item.dateAdded)?.toISOString().split('T')[0] ?? '') : '',
    entryPrice: item.entryPrice ?? '',
    currentPrice: item.currentPrice ?? '',
    targetBuy: item.targetBuy ?? '',
    rating: item.rating ?? '',
    signal: item.signal ?? '',
    analysis: item.analysis ?? '',
  };
}

/** 字符串 → number；空串 / NaN 返回 undefined（payload 里表示"不改该字段"）。 */
function parseNumber(v: string): number | undefined {
  const n = parseFloat(v);
  return isNaN(n) ? undefined : n;
}

/**
 * 计算现价低于目标买价的幅度（正百分比）。
 * 现价 ≥ 目标、或任一输入缺失 / 非法时返回 null。
 */
function belowTargetPct(current: string | null, target: string | null): number | null {
  const c = parseFloat(current ?? '');
  const t = parseFloat(target ?? '');
  if (isNaN(c) || isNaN(t) || t <= 0) return null;
  if (c >= t) return null;
  return ((t - c) / t) * 100;
}

/**
 * 渲染自选股详情对话框（只读 / 编辑两种模式）。
 * @param props - 见 {@link DetailDialogProps}。
 */
function DetailDialog({ open, onOpenChange, item, onUpdated, onDeleted }: DetailDialogProps) {
  // ---- 状态声明区 ----
  const { t } = useTranslation();
  // 只读 / 编辑模式开关（仅对话框内部使用）。
  const [editMode, setEditMode] = useState(false);
  // 编辑表单草稿。
  const [formData, setFormData] = useState<WatchFormData>(toFormData(item));
  // 提交中标记（更新与删除共用，防重复提交）。
  const [submitting, setSubmitting] = useState(false);
  // 删除二次确认对话框开关。
  const [confirmDelete, setConfirmDelete] = useState(false);

  // ---- 数据同步区 ----
  // 对话框每次打开或切换条目时：重置表单、退出编辑态、收起删除确认。
  useEffect(() => {
    if (!open) return;
    setFormData(toFormData(item));
    setEditMode(false);
    setConfirmDelete(false);
  }, [open, item?.id]);

  // 打开时同样做状态重置（与上方 effect 互为兜底）。
  const handleOpenChange = (o: boolean) => {
    if (o) {
      setFormData(toFormData(item));
      setEditMode(false);
      setConfirmDelete(false);
    }
    onOpenChange(o);
  };

  // ---- 事件处理区 ----
  /** 保存编辑：PATCH 变更字段，成功后退出编辑态并通知父组件刷新。 */
  const handleUpdate = async () => {
    if (!item) return;
    setSubmitting(true);
    try {
      // 文本字段 trim 后为空 → undefined（不改）；数字字段经 parseNumber（空 / NaN → 不改）。
      await updateWatchItem(item.id, {
        company: formData.company.trim() || undefined,
        sector: formData.sector.trim() || undefined,
        entryPrice: parseNumber(formData.entryPrice),
        currentPrice: parseNumber(formData.currentPrice),
        targetBuy: parseNumber(formData.targetBuy),
        rating: formData.rating || undefined,
        signal: formData.signal || undefined,
        analysis: formData.analysis.trim() || undefined,
      });
      toast.success(t('watchlist.saved'));
      setEditMode(false);
      onUpdated();
      onOpenChange(false);
    } catch (err: unknown) {
      // 失败：toast 主文案 + 错误详情（无 Error 对象时用通用文案）。
      const msg = err instanceof Error ? err.message : t('ui.watchlist.saveFailed');
      toast.error(t('ui.watchlist.saveFailed'), { description: msg });
    } finally {
      setSubmitting(false);
    }
  };

  /** 删除（二次确认后才会走到这里）：成功后关对话框并通知父组件刷新。 */
  const handleDelete = async () => {
    if (!item) return;
    setSubmitting(true);
    try {
      await deleteWatchItem(item.id);
      toast.success(t('ui.watchlist.signalRemoved'));
      setConfirmDelete(false);
      onDeleted();
      onOpenChange(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('watchlist.deleteFailed');
      toast.error(t('watchlist.deleteFailed'), { description: msg });
    } finally {
      setSubmitting(false);
    }
  };

  // ---- 派生计算区 ----
  // 现价低于目标买价的幅度（null = 不显示机会提示）。注意：计算基于 item 原值而非编辑草稿。
  const belowPct = belowTargetPct(item?.currentPrice ?? null, item?.targetBuy ?? null);

  // ---- 渲染区 ----
  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3 font-serif text-xl">
              <span className="font-mono-nums text-2xl">{item?.ticker}</span>
              <span className="text-base font-normal text-muted-foreground">
                {item?.company ?? '—'}
              </span>
            </DialogTitle>
          </DialogHeader>

          {/* 只读模式：徽标行 → 统计块 → 机会提示 → 分析备注 → 删除 / 编辑按钮。 */}
          {!editMode ? (
            <div className="space-y-4">
              {/* 徽标行：信号（按信号着色）、评级（按评级着色）、行业（中性色），有才渲染。 */}
              <div className="flex flex-wrap gap-2">
                {item?.signal && (
                  <Badge
                    variant="outline"
                    className={cn('border-transparent', signalColor(item.signal))}
                  >
                    {localizedSignal(item.signal, t)}
                  </Badge>
                )}
                {item?.rating && (
                  <Badge
                    variant="outline"
                    className={cn('border-transparent', ratingColor(item.rating))}
                  >
                    {item.rating}
                  </Badge>
                )}
                {item?.sector && <Badge variant="secondary">{item.sector}</Badge>}
              </div>

              {/* 关键信息统计块：加入日期 + 三个价格（字符串数值走 formatPrice）。 */}
              <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
                <Stat label={t('ui.watchlist.joinedDate')} value={formatDate(item?.dateAdded)} />
                <Stat
                  label={t('ui.watchlist.entryPrice')}
                  value={formatPrice(item?.entryPrice)}
                  mono
                />
                <Stat
                  label={t('watchlist.currentPrice')}
                  value={formatPrice(item?.currentPrice)}
                  mono
                />
                <Stat
                  label={t('watchlist.targetBuyPrice')}
                  value={formatPrice(item?.targetBuy)}
                  mono
                />
              </div>

              {/* 机会提示：仅当现价严格低于目标买价时渲染，展示低出幅度（去掉 formatPercent 的 + 号）。 */}
              {belowPct !== null && (
                <div className="rounded-md bg-success/10 px-3 py-2 text-sm text-success">
                  {t('ui.watchlist.opportunityMessage', {
                    percent: formatPercent(belowPct).replace('+', ''),
                  })}
                </div>
              )}

              {/* 分析备注：有内容才渲染，保留换行。 */}
              {item?.analysis && (
                <div className="space-y-2">
                  <h4 className="font-serif text-sm font-semibold text-foreground">
                    {t('ui.holdings.analysis')}
                  </h4>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                    {item.analysis}
                  </p>
                </div>
              )}

              <DialogFooter className="gap-2">
                {/* 删除：先弹二次确认，不在本对话框直接删。 */}
                <Button variant="destructive" onClick={() => setConfirmDelete(true)}>
                  <Trash2 className="h-4 w-4" />
                  {t('common.delete')}
                </Button>
                <Button variant="outline" onClick={() => setEditMode(true)}>
                  <Pencil className="h-4 w-4" />
                  {t('common.edit')}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            // 编辑模式：共用受控表单（隐藏代码输入）+ 取消 / 保存按钮。
            <>
              <WatchForm data={formData} onChange={setFormData} />
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setEditMode(false)}>
                  {t('common.cancel')}
                </Button>
                <Button onClick={handleUpdate} disabled={submitting}>
                  {submitting ? t('common.saving') : t('common.save')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 删除二次确认对话框：与主对话框平级，确认后才执行 handleDelete。 */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-serif">{t('watchlist.confirmRemove')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('ui.watchlist.confirmRemoveText', { ticker: item?.ticker })}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={submitting}>
              {submitting ? t('watchlist.deleting') : t('common.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** 只读详情里的小型"标签 + 值"统计块；mono 为 true 时值用等宽数字字体。 */
function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('text-base font-medium', mono ? 'font-mono-nums' : '')}>{value}</div>
    </div>
  );
}

export default DetailDialog;
