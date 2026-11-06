/**
 * @file pages/Transactions/AddTransactionDialog.tsx
 * @description Create-a-transaction dialog.
 *
 * Supports Buy, Sell, Deposit, and Withdrawal types. Deposit/Withdrawal are
 * cash flows (no ticker/price; shares field holds the amount). When a Buy
 * fails with a server-side "insufficient cash" error, a secondary alert offers
 * to either auto-deposit the shortfall and retry, or switch the form to a
 * manual Deposit for the shortfall amount.
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

/** Props for {@link AddTransactionDialog}. */
interface AddTransactionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  defaultTicker?: string;
  defaultCurrency?: Currency;
  defaultTxType?: TxType;
}

/**
 * Render the add-transaction dialog with controlled form state and the
 * cash-shortfall recovery flow.
 */
export default function AddTransactionDialog({
  open,
  onOpenChange,
  onCreated,
  defaultTicker = '',
  defaultCurrency = 'USD',
  defaultTxType = 'Buy',
}: AddTransactionDialogProps) {
  const { t, i18n } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [tickerInvalid, setTickerInvalid] = useState(false);
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

  const [cashShortfallOpen, setCashShortfallOpen] = useState(false);
  const [shortfallInfo, setShortfallInfo] = useState<{
    currency: Currency;
    currentBalance: number;
    required: number;
    shortfall: number;
  } | null>(null);
  const [autoDepositing, setAutoDepositing] = useState(false);

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

  const isCashFlow = form.txType === 'Deposit' || form.txType === 'Withdrawal' || form.txType === 'Fee';

  /** Estimated cash required for a Buy/Sell: shares × price + fees. */
  const requiredAmount = useMemo(() => {
    if (isCashFlow) return 0;
    const shares = parseFloat(form.shares) || 0;
    const price = parseFloat(form.price) || 0;
    const fees = parseFloat(form.fees) || 0;
    return shares * price + fees;
  }, [form.shares, form.price, form.fees, isCashFlow]);

  /** Extract a human-readable error message from an unknown thrown value. */
  const extractErrMsg = (err: unknown): string => {
    const rawMsg = err instanceof Error ? err.message : t('ui.tx.failed');
    const respErr = (err as { response?: { data?: { message?: string; error?: string | { message?: string } } } })
      ?.response?.data;
    const message = (typeof respErr?.error === 'object' ? respErr.error.message : respErr?.error) || respErr?.message || rawMsg;
    const zh = i18n.language.startsWith('zh');
    if (['BEFORE_POSITION_BASELINE', 'BEFORE_CASH_BASELINE'].includes(message)) return zh ? '这笔记录早于已确认的资产起点，请先核对原持仓或现金，避免重复记账。' : 'This record predates the confirmed asset starting point. Reconcile the original positions or cash to avoid counting it twice.';
    if (message === 'CASH_REQUIRES_RECONCILIATION') return zh ? '这个币种有待核对的重复余额，请先在今日页确认现金。' : 'This currency has conflicting balances. Confirm its cash balance on Today first.';
    if (['CHECKPOINT_HISTORY_REQUIRES_RECONCILIATION', 'CASH_CHECKPOINT_HISTORY_REQUIRES_RECONCILIATION'].includes(message)) return zh ? '这笔记录已包含在确认的资产起点中，请先核对持仓或现金起点后再修改。' : 'This record is included in a confirmed asset starting balance. Reconcile the positions or cash starting balance before changing it.';
    if (message === 'POSITION_IDENTITY_REQUIRES_RECONCILIATION') return zh ? '同一证券存在多个代码写法，请先核对重复持仓和交易记录。' : 'This security has conflicting ticker aliases. Reconcile its duplicate holdings and transaction records first.';
    if (message === 'POSITION_CURRENCY_MISMATCH') return zh ? '成交币种与持仓或证券市场币种不一致，请核对后再入账。' : 'The execution currency differs from the position or security market currency. Verify it before saving.';
    return message;
  };

  /**
   * Parse a server "insufficient cash" error message to extract the currency,
   * current balance, required amount, and shortfall. Returns null when the
   * message does not match the expected format.
   */
  const parseCashShortfall = (msg: string): {
    currency: Currency;
    currentBalance: number;
    required: number;
    shortfall: number;
  } | null => {
    const cashMatch = msg.match(/现金不足[：:].*余额\s*([\d.]+).*需要\s*([\d.]+)/);
    const currencyMatch = msg.match(/现金不足[：:]\s*([A-Z]{3})/);
    if (!cashMatch) return null;
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

  /** Build the POST payload; cash flows use price=1 and empty ticker. */
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

  /** Validate and submit; on insufficient-cash error for a Buy, open the recovery dialog. */
  const handleSubmit = async () => {
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
    setSaving(true);
    try {
      const payload = buildPayload();
      await createTransaction(payload);
      toast.success(isCashFlow ? t('ui.tx.cashRecorded') : t('ui.tx.tradeRecorded'));
      onOpenChange(false);
      onCreated();
    } catch (err: unknown) {
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

  /** Auto-deposit the shortfall and retry the buy in one server call. */
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

  /** Switch the main form to a Deposit prefilled with the shortfall amount. */
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

  /** Apply a ticker from the search dropdown and adopt its currency. */
  const handleTickerSelect = (result: StockSearchResult) => {
    setTickerInvalid(false);
    setForm((prev) => ({
      ...prev,
      ticker: result.symbol.toUpperCase(),
      currency: result.currency,
    }));
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
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
                  <SelectItem value="Fee">{i18n.language.startsWith('zh') ? '费用' : 'Fee'}</SelectItem>
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
                  <p className="text-xs text-destructive">
                    {t('ui.tx.selectStockHint')}
                  </p>
                )}
              </div>
            )}
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
                <div className="rounded-lg bg-muted/50 p-3 space-y-1 text-xs text-muted-foreground">
                  <div>{t('ui.tx.tradeAmount')}: {form.shares} × {form.price} = {(parseFloat(form.shares) * parseFloat(form.price)).toFixed(2)}</div>
                  <div>{t('ui.tx.fees')}: {form.fees || '0.00'}</div>
                  <div className="font-semibold text-foreground pt-1">{t('ui.tx.totalRequired')}: {requiredAmount.toFixed(2)} {shortfallInfo?.currency}</div>
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
            <Button variant="outline" size="sm" onClick={handleGoToDeposit}>
              {t('ui.tx.manualDeposit')}
            </Button>
            <Button size="sm" onClick={handleAutoDeposit} disabled={autoDepositing}>
              {autoDepositing ? t('ui.tx.processing') : t('ui.tx.autoDepositBuy')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
