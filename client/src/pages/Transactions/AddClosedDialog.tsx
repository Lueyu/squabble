/**
 * AddClosedDialog.tsx — 新增"已平仓头寸"对话框。
 *
 * 职责边界：
 *  - 收集平仓记录：仅代码必填；已实现盈亏与收益率可以手填，
 *    也可以在股数 / 买价 / 卖价齐全时自动推导；
 *  - 输入过程中实时展示推导盈亏的预览卡片（estimatedPl）；
 *  - 提交成功后重置表单、关对话框、回调 onCreated 通知父组件刷新。
 * 上下游：
 *  - 上游：TransactionsPage（open / onOpenChange / onCreated）；
 *  - 下游：@/api 的 createClosed（写库请求）、sonner 的 toast（提示）、
 *    @/utils/format 的 formatCurrency / formatPercent / plClass / cn、@/components/ui 表单控件。
 * 关键约定：
 *  - 表单 state 里的数字字段一律保存为 string（受控输入的原始值）；
 *    组装 payload 时才 parseFloat 转 number 再发给服务端——字符串数值与 number 的转换只发生在这一处；
 *  - 已实现盈亏推导公式：shares × (sellPrice − buyPrice)；收益率推导：(sellPrice − buyPrice) / buyPrice × 100；
 *    用户手填值优先，推导值仅在对应输入留空且三要素齐全时使用。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { createClosed } from '@/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { formatCurrency, formatPercent, plClass, cn } from '@/utils/format';

/** {@link AddClosedDialog} 的入参。 */
interface AddClosedDialogProps {
  /** 对话框开关（受控）。 */
  open: boolean;
  /** 开关变更回调（父组件持有 open state）。 */
  onOpenChange: (open: boolean) => void;
  /** 创建成功后的回调（父组件刷新列表）。 */
  onCreated: () => void;
}

/**
 * 渲染新增平仓记录对话框（带实时盈亏预览）。
 * @param props - 见 {@link AddClosedDialogProps}。
 */
export default function AddClosedDialog({ open, onOpenChange, onCreated }: AddClosedDialogProps) {
  const { t } = useTranslation();
  // 提交中标记：防重复提交、按钮显示 saving 文案。
  const [saving, setSaving] = useState(false);
  // 表单受控状态：数字字段保存字符串，提交时才转 number。
  const [form, setForm] = useState({
    ticker: '',
    company: '',
    openDate: '',
    closeDate: '',
    buyPrice: '',
    sellPrice: '',
    shares: '',
    realizedPl: '',
    returnPct: '',
    notes: '',
  });

  // 派生计算区：字符串数值 → number（|| '0' 兜底空值），并推导盈亏与收益率。
  const shares = parseFloat(form.shares || '0');
  const buyPrice = parseFloat(form.buyPrice || '0');
  const sellPrice = parseFloat(form.sellPrice || '0');
  // 自动盈亏 = 股数 ×（卖价 − 买价）。
  const autoPl = shares * (sellPrice - buyPrice);
  // 自动收益率 =（卖价 − 买价）/ 买价 × 100；股数或买价非正时不推导（避免除零 / 负基数）。
  const autoReturn = shares > 0 && buyPrice > 0 ? ((sellPrice - buyPrice) / buyPrice) * 100 : 0;

  /** 创建成功后把表单重置为空白。 */
  const reset = () => {
    setForm({
      ticker: '',
      company: '',
      openDate: '',
      closeDate: '',
      buyPrice: '',
      sellPrice: '',
      shares: '',
      realizedPl: '',
      returnPct: '',
      notes: '',
    });
  };

  /**
   * 校验并提交：手填的盈亏 / 收益率优先，留空且三要素齐全时用推导值补上。
   */
  const handleSubmit = async () => {
    // 第一步：校验必填的代码字段。
    if (!form.ticker.trim()) {
      toast.error(t('ui.tx.enterCode'));
      return;
    }
    // 第二步：组装 payload——有值才带字段，数字字段 parseFloat 转 number。
    setSaving(true);
    try {
      const payload: Record<string, string | number | undefined> = {
        ticker: form.ticker.trim().toUpperCase(),
      };
      if (form.company) payload.company = form.company;
      if (form.openDate) payload.openDate = form.openDate;
      if (form.closeDate) payload.closeDate = form.closeDate;
      if (form.buyPrice) payload.buyPrice = parseFloat(form.buyPrice);
      if (form.sellPrice) payload.sellPrice = parseFloat(form.sellPrice);
      if (form.shares) payload.shares = parseFloat(form.shares);
      // 已实现盈亏：手填优先；留空且三要素齐全时用推导值 autoPl。
      if (form.realizedPl) payload.realizedPl = parseFloat(form.realizedPl);
      else if (shares && buyPrice && sellPrice) payload.realizedPl = autoPl;
      // 收益率：同上，优先手填，否则推导。
      if (form.returnPct) payload.returnPct = parseFloat(form.returnPct);
      else if (shares && buyPrice && sellPrice) payload.returnPct = autoReturn;
      if (form.notes) payload.notes = form.notes;

      // 第三步：请求写库；失败仅 toast 提示（错误详情不上抛）。
      await createClosed(payload);
      toast.success(t('tx.closedNote'));
      // 第四步：成功后重置表单、关闭对话框、通知父组件刷新。
      reset();
      onOpenChange(false);
      onCreated();
    } catch (err) {
      toast.error(t('ui.tx.failed'));
    } finally {
      setSaving(false);
    }
  };

  // 渲染区：两列表单网格 + 可选盈亏预览卡 + 底部按钮。
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-serif text-xl">{t('ui.tx.addClosedTitle')}</DialogTitle>
          <DialogDescription>{t('ui.tx.addClosedDesc')}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-4 py-2">
          {/* 代码：必填，输入即转大写。 */}
          <div className="space-y-1.5">
            <Label>
              {t('holdings.ticker')} <span className="text-destructive">*</span>
            </Label>
            <Input
              placeholder={t('ui.holdings.tickerExample')}
              value={form.ticker}
              onChange={(e) =>
                setForm({
                  ...form,
                  ticker: e.target.value.toUpperCase(),
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('ui.tx.companyName')}</Label>
            <Input
              value={form.company}
              onChange={(e) => setForm({ ...form, company: e.target.value })}
            />
          </div>
          {/* 开 / 平仓日期：原生 date input，值为 YYYY-MM-DD 字符串。 */}
          <div className="space-y-1.5">
            <Label>{t('tx.openDate')}</Label>
            <Input
              type="date"
              value={form.openDate}
              onChange={(e) => setForm({ ...form, openDate: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('tx.closeDate')}</Label>
            <Input
              type="date"
              value={form.closeDate}
              onChange={(e) => setForm({ ...form, closeDate: e.target.value })}
            />
          </div>
          {/* 价格与股数：number 输入框，值仍以字符串保存在 form 中。 */}
          <div className="space-y-1.5">
            <Label>{t('tx.buyPrice')}</Label>
            <Input
              type="number"
              step="0.01"
              value={form.buyPrice}
              onChange={(e) => setForm({ ...form, buyPrice: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('tx.sellPrice')}</Label>
            <Input
              type="number"
              step="0.01"
              value={form.sellPrice}
              onChange={(e) => setForm({ ...form, sellPrice: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('tx.shares')}</Label>
            <Input
              type="number"
              step="0.0001"
              value={form.shares}
              onChange={(e) => setForm({ ...form, shares: e.target.value })}
            />
          </div>
          {/* 已实现盈亏：手填优先；三要素齐全时 placeholder 提示可自动计算。 */}
          <div className="space-y-1.5">
            <Label>{t('ui.tx.realizedPl')}</Label>
            <Input
              type="number"
              step="0.01"
              value={form.realizedPl}
              onChange={(e) => setForm({ ...form, realizedPl: e.target.value })}
              placeholder={shares && buyPrice && sellPrice ? t('ui.tx.autoCalculate') : ''}
            />
          </div>
          {/* 收益率：占满两列，同上可自动计算。 */}
          <div className="space-y-1.5 col-span-2">
            <Label>{t('ui.tx.returnPct')} (%)</Label>
            <Input
              type="number"
              step="0.01"
              value={form.returnPct}
              onChange={(e) => setForm({ ...form, returnPct: e.target.value })}
              placeholder={shares && buyPrice && sellPrice ? t('ui.tx.autoCalculate') : ''}
            />
          </div>

          {/* 盈亏预览卡：仅当股数 / 买价 / 卖价全部为正时渲染，实时展示推导值。 */}
          {shares > 0 && buyPrice > 0 && sellPrice > 0 && (
            <div className="col-span-2 p-3 bg-muted/50 rounded-md text-sm flex items-center justify-between">
              <span className="text-muted-foreground">{t('ui.tx.estimatedPl')}</span>
              <div className="text-right">
                <div className={cn('font-mono-nums font-semibold', plClass(autoPl))}>
                  {formatCurrency(autoPl)}
                </div>
                <div className={cn('font-mono-nums text-xs', plClass(autoReturn))}>
                  {formatPercent(autoReturn)}
                </div>
              </div>
            </div>
          )}

          {/* 备注：占满两列。 */}
          <div className="space-y-1.5 col-span-2">
            <Label>{t('tx.notes')}</Label>
            <Textarea
              rows={3}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          {/* 提交按钮：saving 期间禁用并显示保存中文案。 */}
          <Button size="sm" onClick={handleSubmit} disabled={saving}>
            {saving ? t('ui.tx.saving') : t('ui.tx.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
