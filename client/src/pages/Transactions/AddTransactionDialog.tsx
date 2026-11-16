/**
 * AddTransactionDialog.tsx — 新建交易记录对话框。
 *
 * 职责边界：
 *  - 支持四类交易：Buy / Sell / Deposit / Withdrawal。存取款是纯现金流
 *    （不需要代码与价格，shares 字段承载金额）；
 *  - 买入遇服务端"现金不足"错误时进入二次恢复流程：弹窗里可
 *    "自动补足差额并重试"（一次服务端调用完成入金+买入），或
 *    "手动入金"（把主表单切为预填差额的 Deposit）。
 * 上下游：
 *  - 上游：TransactionsPage（open / onCreated / 各 default* 预填项）；
 *  - 下游：@/api 的 createTransaction / createTransactionWithAutoDeposit、
 *    @/components/ui/ticker-search 的股票搜索下拉、@/components/ui 各控件。
 * 关键约定：
 *  - 表单数字字段（shares / price / fees）保存为 string，组装 payload 时才 parseFloat
 *    转 number；现金流记录约定 shares=金额、price=1、ticker=空串；
 *  - 服务端"现金不足"错误是约定格式的中文文案（"现金不足：…余额 X …需要 Y"），
 *    parseCashShortfall 靠正则从消息里解析币种 / 余额 / 需求 / 差额——改文案需同步改解析；
 *  - 对话框每次打开（open 变 true）都重置表单与恢复流程状态。
 */
import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { TxType, Currency, StockSearchResult } from '@shared/api.interface';
import { createTransaction, createTransactionWithAutoDeposit } from '@/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import TickerSearch from '@/components/ui/ticker-search';

/** {@link AddTransactionDialog} 的入参。 */
interface AddTransactionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  defaultTicker?: string;
  defaultCurrency?: Currency;
  defaultTxType?: TxType;
}

/**
 * 渲染新建交易对话框：受控表单 + 现金不足恢复流程。
 * @param props - 见 {@link AddTransactionDialogProps}。
 */
export default function AddTransactionDialog({
  open,
  onOpenChange,
  onCreated,
  defaultTicker = '',
  defaultCurrency = 'USD',
  defaultTxType = 'Buy',
}: AddTransactionDialogProps) {
  // ---- 状态声明区 ----
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  // 股票代码校验失败标记（驱动 TickerSearch 的红框与提示）。
  const [tickerInvalid, setTickerInvalid] = useState(false);
  // 表单受控状态：数字字段保存 string，提交时才 parseFloat。
  const [form, setForm] = useState({
    txDate: new Date().toISOString().slice(0, 10),
    txType: 'Buy' as TxType,
    ticker: defaultTicker,
    shares: '',
    price: '',
    fees: '',
    notes: '',
    currency: defaultCurrency as Currency,
  });

  // 现金不足恢复流程：弹窗开关 / 解析出的差额信息 / 自动补足进行中标记。
  const [cashShortfallOpen, setCashShortfallOpen] = useState(false);
  const [shortfallInfo, setShortfallInfo] = useState<{
    currency: Currency;
    currentBalance: number;
    required: number;
    shortfall: number;
  } | null>(null);
  const [autoDepositing, setAutoDepositing] = useState(false);

  // 对话框打开时重置表单（交易日期取当天）并关掉恢复流程。
  useEffect(() => {
    if (open) {
      setForm({
        txDate: new Date().toISOString().slice(0, 10),
        txType: defaultTxType,
        ticker: defaultTicker,
        shares: '',
        price: '',
        fees: '',
        notes: '',
        currency: defaultCurrency,
      });
      setCashShortfallOpen(false);
      setShortfallInfo(null);
    }
  }, [open, defaultTicker, defaultCurrency, defaultTxType]);

  // ---- 派生计算区 ----
  // 是否为纯现金流（存/取款）：表单字段与校验规则都随之切换。
  const isCashFlow = form.txType === 'Deposit' || form.txType === 'Withdrawal';

  /** 买入/卖出的预估所需现金：股数 × 价格 + 手续费（现金流恒为 0）。 */
  const requiredAmount = useMemo(() => {
    if (isCashFlow) return 0;
    const shares = parseFloat(form.shares) || 0;
    const price = parseFloat(form.price) || 0;
    const fees = parseFloat(form.fees) || 0;
    return shares * price + fees;
  }, [form.shares, form.price, form.fees, isCashFlow]);

  // ---- 事件处理区 ----
  /** 从未知抛出值里提取可读错误消息：优先响应体的 message / error 字段。 */
  const extractErrMsg = (err: unknown): string => {
    const rawMsg = err instanceof Error ? err.message : t('ui.tx.failed');
    const respErr = (err as { response?: { data?: { message?: string; error?: string } } })
      ?.response?.data;
    return respErr?.message || respErr?.error || rawMsg;
  };

  /**
   * 解析服务端"现金不足"错误消息，提取币种 / 当前余额 / 所需金额 / 差额。
   * 消息不符合约定格式时返回 null。
   */
  const parseCashShortfall = (
    msg: string,
  ): {
    currency: Currency;
    currentBalance: number;
    required: number;
    shortfall: number;
  } | null => {
    // 依赖服务端固定文案格式："现金不足：…余额 X …需要 Y"（冒号中英文皆可）。
    const cashMatch = msg.match(/现金不足[：:].*余额\s*([\d.]+).*需要\s*([\d.]+)/);
    const currencyMatch = msg.match(/现金不足[：:]\s*([A-Z]{3})/);
    if (!cashMatch) return null;
    // 币种解析失败时回退用表单当前币种。
    const cur = (currencyMatch?.[1] || form.currency) as Currency;
    const balance = Number(cashMatch[1]);
    const needed = Number(cashMatch[2]);
    return {
      currency: cur,
      currentBalance: balance,
      required: needed,
      shortfall: Math.max(0, needed - balance),
    };
  };

  /** 组装 POST payload：现金流用 price=1、ticker 空串；fees / notes 有值才带。 */
  const buildPayload = (): Record<string, string | number> => {
    const payload: Record<string, string | number> = {
      txDate: form.txDate,
      txType: form.txType,
      ticker: isCashFlow ? '' : form.ticker.trim().toUpperCase(),
      shares: parseFloat(form.shares),
      price: isCashFlow ? 1 : parseFloat(form.price),
      currency: form.currency,
    };
    if (form.fees) payload.fees = parseFloat(form.fees);
    if (form.notes) payload.notes = form.notes;
    return payload;
  };

  /** 校验并提交；买入遇"现金不足"错误时打开恢复弹窗，其余错误直接 toast。 */
  const handleSubmit = async () => {
    // 第一步：逐项校验——日期必填；非现金流要求代码/股数/价格合法，现金流只要求金额为正。
    if (!form.txDate) {
      toast.error(t('ui.tx.chooseDate'));
      return;
    }
    if (!isCashFlow && !form.ticker.trim()) {
      setTickerInvalid(true);
      toast.error(t('ui.tx.chooseStock'));
      return;
    }
    if (!form.shares || parseFloat(form.shares) <= 0) {
      toast.error(isCashFlow ? t('ui.tx.validAmount') : t('ui.tx.validShares'));
      return;
    }
    if (!isCashFlow && (!form.price || parseFloat(form.price) <= 0)) {
      toast.error(t('ui.tx.validPrice'));
      return;
    }
    // 第二步：提交；成功后关对话框并回调 onCreated 刷新。
    setSaving(true);
    try {
      const payload = buildPayload();
      await createTransaction(payload);
      toast.success(isCashFlow ? t('ui.tx.cashRecorded') : t('ui.tx.tradeRecorded'));
      onOpenChange(false);
      onCreated();
    } catch (err: unknown) {
      // 第三步：失败时尝试解析"现金不足"——仅买入类型进入恢复弹窗。
      const msg = extractErrMsg(err);
      const shortfall = parseCashShortfall(msg);
      if (shortfall && form.txType === 'Buy') {
        setShortfallInfo(shortfall);
        setCashShortfallOpen(true);
      } else {
        toast.error(msg);
      }
    } finally {
      setSaving(false);
    }
  };

  /** 恢复路径一：自动补足差额并重试买入（服务端一次调用完成入金+买入）。 */
  const handleAutoDeposit = async () => {
    if (!shortfallInfo) return;
    setAutoDepositing(true);
    try {
      const payload = buildPayload();
      await createTransactionWithAutoDeposit(payload);
      toast.success(t('ui.tx.autoDepositSuccess'));
      setCashShortfallOpen(false);
      setShortfallInfo(null);
      onOpenChange(false);
      onCreated();
    } catch (err: unknown) {
      const msg = extractErrMsg(err);
      toast.error(msg);
    } finally {
      setAutoDepositing(false);
    }
  };

  /** 恢复路径二：把主表单切换为预填差额金额的 Deposit（保留原交易日期与币种）。 */
  const handleGoToDeposit = () => {
    if (!shortfallInfo) return;
    setForm({
      txDate: form.txDate,
      txType: 'Deposit',
      ticker: '',
      shares: shortfallInfo.shortfall.toFixed(2),
      price: '',
      fees: '',
      notes: '',
      currency: shortfallInfo.currency,
    });
    setCashShortfallOpen(false);
    setShortfallInfo(null);
  };

  /** 应用搜索下拉选中的股票：回填代码并同步其币种。 */
  const handleTickerSelect = (result: StockSearchResult) => {
    setTickerInvalid(false);
    setForm((prev) => ({
      ...prev,
      ticker: result.symbol.toUpperCase(),
      currency: result.currency,
    }));
  };

  // ---- 渲染区 ----
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            {/* 标题与描述随交易类型切换：现金流 vs 交易。 */}
            <DialogTitle className="font-serif text-xl">
              {isCashFlow ? t('ui.tx.cashFlowTitle') : t('ui.tx.tradeTitle')}
            </DialogTitle>
            <DialogDescription>
              {isCashFlow ? t('ui.tx.cashFlowDesc') : t('ui.tx.tradeDesc')}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-4 py-2">
            <div className="space-y-1.5">
              <Label>
                {t('ui.tx.date')} <span className="text-destructive">*</span>
              </Label>
              <Input
                type="date"
                value={form.txDate}
                onChange={(e) => setForm({ ...form, txDate: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>
                {t('ui.tx.type')} <span className="text-destructive">*</span>
              </Label>
              <Select
                value={form.txType}
                onValueChange={(v) => setForm({ ...form, txType: v as TxType })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Buy">{t('ui.tx.buy')}</SelectItem>
                  <SelectItem value="Sell">{t('ui.tx.sell')}</SelectItem>
                  <SelectItem value="Deposit">{t('ui.tx.deposit')}</SelectItem>
                  <SelectItem value="Withdrawal">{t('ui.tx.withdrawal')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>
                {t('ui.tx.currency')} <span className="text-destructive">*</span>
              </Label>
              <Select
                value={form.currency}
                onValueChange={(v) => setForm({ ...form, currency: v as Currency })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USD">{t('common.usd')}</SelectItem>
                  <SelectItem value="HKD">{t('common.hkd')}</SelectItem>
                  <SelectItem value="CNY">{t('common.cny')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {/* 股票代码：仅非现金流显示；选中搜索结果会联动币种。 */}
            {!isCashFlow && (
              <div className="space-y-1.5 col-span-2">
                <Label>
                  {t('ui.tx.stockLabel')} <span className="text-destructive">*</span>
                </Label>
                <TickerSearch
                  value={form.ticker}
                  onChange={(v) => {
                    setForm({ ...form, ticker: v.toUpperCase() });
                    setTickerInvalid(false);
                  }}
                  onSelect={handleTickerSelect}
                  placeholder={t('ui.tx.stockPlaceholder')}
                  invalid={tickerInvalid}
                />
                {tickerInvalid && (
                  <p className="text-xs text-destructive">{t('ui.tx.selectStockHint')}</p>
                )}
              </div>
            )}
            {/* 股数/金额输入：现金流时 label 为"金额"（shares 字段承载金额）。 */}
            <div className="space-y-1.5">
              <Label>
                {isCashFlow ? t('ui.tx.amountLabel') : t('ui.tx.shares')}{' '}
                <span className="text-destructive">*</span>
              </Label>
              <Input
                type="number"
                step="0.0001"
                value={form.shares}
                onChange={(e) => setForm({ ...form, shares: e.target.value })}
              />
            </div>
            {/* 价格：仅非现金流显示。 */}
            {!isCashFlow && (
              <div className="space-y-1.5">
                <Label>
                  {t('ui.tx.price')} <span className="text-destructive">*</span>
                </Label>
                <Input
                  type="number"
                  step="0.01"
                  value={form.price}
                  onChange={(e) => setForm({ ...form, price: e.target.value })}
                />
              </div>
            )}
            <div className="space-y-1.5 col-span-2">
              <Label>{t('ui.tx.fees')}</Label>
              <Input
                type="number"
                step="0.01"
                value={form.fees}
                onChange={(e) => setForm({ ...form, fees: e.target.value })}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label>{t('tx.notes')}</Label>
              <Textarea
                rows={3}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder={t('ui.tx.notePlaceholder')}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={saving}>
              {saving ? t('ui.tx.saving') : t('ui.tx.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 现金不足恢复弹窗：展示差额明细，提供"手动入金"与"自动补足并买入"两条路径。 */}
      <AlertDialog open={cashShortfallOpen} onOpenChange={setCashShortfallOpen}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif text-lg">
              {t('ui.tx.insufficientCash')}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm">
                <p>
                  {t('ui.tx.shortfallMessage', {
                    currency: shortfallInfo?.currency,
                    required: shortfallInfo?.required.toFixed(2),
                    balance: shortfallInfo?.currentBalance.toFixed(2),
                    shortfall: shortfallInfo?.shortfall.toFixed(2),
                  })}
                </p>
                {/* 金额明细：股数×价格 + 手续费 = 所需总额（直接由表单草稿算出）。 */}
                <div className="rounded-lg bg-muted/50 p-3 space-y-1 text-xs text-muted-foreground">
                  <div>
                    {t('ui.tx.tradeAmount')}: {form.shares} × {form.price} ={' '}
                    {(parseFloat(form.shares) * parseFloat(form.price)).toFixed(2)}
                  </div>
                  <div>
                    {t('ui.tx.fees')}: {form.fees || '0.00'}
                  </div>
                  <div className="font-semibold text-foreground pt-1">
                    {t('ui.tx.totalRequired')}: {requiredAmount.toFixed(2)}{' '}
                    {shortfallInfo?.currency}
                  </div>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col sm:flex-row gap-2">
            <AlertDialogCancel asChild>
              <Button variant="outline" size="sm">
                {t('common.cancel')}
              </Button>
            </AlertDialogCancel>
            {/* 路径一：切回主表单为预填差额的 Deposit。 */}
            <Button variant="outline" size="sm" onClick={handleGoToDeposit}>
              {t('ui.tx.manualDeposit')}
            </Button>
            {/* 路径二：一次服务端调用自动入金+买入。 */}
            <Button size="sm" onClick={handleAutoDeposit} disabled={autoDepositing}>
              {autoDepositing ? t('ui.tx.processing') : t('ui.tx.autoDepositBuy')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
