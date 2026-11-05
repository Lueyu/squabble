/**
 * @file pages/Holdings/HoldingDetailDialog.tsx
 * @description Detail / edit dialog for a single holding.
 *
 * Two view modes:
 *  - Read-only: tabbed layout with a "详情" tab (price, P/L, cost, group, notes)
 *    and an "AI 推理" tab (rating, confidence, target price, bull/bear summaries).
 *  - Editing: a grid form that PATCHes the changed fields on save.
 *
 * Also hosts a delete confirmation and a quick group-move selector.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useSimpleExperience } from '@/hooks/use-simple-experience';
import { questionPath } from '@/utils/simple-experience';
import { toast } from 'sonner';
import { Pencil, Trash2, FolderOpen, X, Check, Sparkles, TrendingUp, TrendingDown, ShieldAlert, ExternalLink } from 'lucide-react';
import type { Holding, Group, AgentRating, AgentConfidence } from '@shared/api.interface';
import { updateHolding, deleteHolding } from '@/api';
import {
  formatPrice,
  formatShares,
  formatCurrency,
  formatPercent,
  formatDate,
  plClass,
  ratingColor,
  actionColor,
  cn,
} from '@/utils/format';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Card, CardContent } from '@/components/ui/card';
import RatingBadge from '@/components/MultiAgent/RatingBadge';
import ConfidenceBadge from '@/components/MultiAgent/ConfidenceBadge';
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

/** AI rating info shown on the "AI 推理" tab. */
interface AiRatingInfo {
  rating: AgentRating;
  confidence: AgentConfidence;
  targetPrice: string | null;
  action: string;
  runId: string;
  bullSummary: string | null;
  bearSummary: string | null;
}

/** Props for {@link HoldingDetailDialog}. */
interface HoldingDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  holding: Holding | null;
  groups: Group[];
  onUpdated: () => void;
  onDeleted: () => void;
  aiRating?: AiRatingInfo | null;
  onViewFullAnalysis?: (runId: string) => void;
}

/** Derived market value, cost, P/L and return % from a raw holding. */
function computeDerived(h: Holding) {
  const shares = parseFloat(h.shares || '0');
  const buyPrice = parseFloat(h.buyPrice || '0');
  const currentPrice = parseFloat(h.currentPrice || '0');
  const marketValue = shares * currentPrice;
  const cost = shares * buyPrice;
  const pl = marketValue - cost;
  const returnPct = cost > 0 ? (pl / cost) * 100 : 0;
  return { marketValue, cost, pl, returnPct };
}

/**
 * Render the holding detail dialog. Returns null when no holding is selected.
 */
export default function HoldingDetailDialog({
  open,
  onOpenChange,
  holding,
  groups,
  onUpdated,
  onDeleted,
  aiRating,
  onViewFullAnalysis,
}: HoldingDetailDialogProps) {
  const { t, i18n } = useTranslation();
  const { enabled: simple } = useSimpleExperience();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});

  /** Copy the holding's current fields into the edit form and enter edit mode. */
  const startEdit = () => {
    if (!holding) return;
    setForm({
      company: holding.company ?? '',
      sector: holding.sector ?? '',
      buyDate: holding.buyDate ?? '',
      buyPrice: holding.buyPrice ?? '',
      shares: holding.shares ?? '',
      currentPrice: holding.currentPrice ?? '',
      rating: holding.rating ?? '',
      action: holding.action ?? '',
      targetPrice: holding.targetPrice ?? '',
      analysis: holding.analysis ?? '',
      groupId: holding.groupId ?? '',
    });
    setEditing(true);
  };

  /** Exit edit mode and clear the form. */
  const closeEdit = () => {
    setEditing(false);
    setForm({});
  };

  /**
   * PATCH only the fields that differ from the holding's current values.
   * Numeric fields are parsed to numbers; empty strings are sent as undefined
   * so the backend treats them as "clear".
   */
  const handleSave = async () => {
    if (!holding) return;
    setSaving(true);
    try {
      const payload: Record<string, string | number | undefined> = {};
      if (form.company !== undefined) payload.company = form.company || undefined;
      if (form.sector !== undefined) payload.sector = form.sector || undefined;
      if (form.buyDate !== undefined) payload.buyDate = form.buyDate || undefined;
      if (form.buyPrice !== undefined)
        payload.buyPrice = form.buyPrice ? parseFloat(form.buyPrice) : undefined;
      if (form.shares !== undefined)
        payload.shares = form.shares ? parseFloat(form.shares) : undefined;
      if (form.currentPrice !== undefined)
        payload.currentPrice = form.currentPrice
          ? parseFloat(form.currentPrice)
          : undefined;
      if (form.rating !== undefined) payload.rating = form.rating || undefined;
      if (form.action !== undefined) payload.action = form.action || undefined;
      if (form.targetPrice !== undefined)
        payload.targetPrice = form.targetPrice
          ? parseFloat(form.targetPrice)
          : undefined;
      if (form.analysis !== undefined)
        payload.analysis = form.analysis || undefined;
      if (form.groupId !== undefined)
        payload.groupId = form.groupId || undefined;

      await updateHolding(holding.id, payload);
      toast.success(t('holdings.editSaved'));
      setEditing(false);
      onUpdated();
    } catch (err) {
      toast.error(t('rules.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  /** Confirm-and-delete the holding, then close and refresh the list. */
  const handleDelete = async () => {
    if (!holding) return;
    setSaving(true);
    try {
      await deleteHolding(holding.id);
      toast.success(t('holdings.deleted'));
      setConfirmDelete(false);
      onOpenChange(false);
      onDeleted();
    } catch (err) {
      toast.error(t('holdings.deleteFailed'));
    } finally {
      setSaving(false);
    }
  };

  /** Quick group-move handler used by the "移动分组" selector. */
  const handleGroupChange = async (value: string) => {
    if (!holding) return;
    try {
      await updateHolding(holding.id, { groupId: value || undefined });
      toast.success(t('holdings.editSaved'));
      onUpdated();
    } catch (err) {
      toast.error(t('ui.holdings.updateGroupFailed'));
    }
  };

  if (!holding) return null;

  const { marketValue, cost, pl, returnPct } = computeDerived(holding);
  const groupName =
    groups.find((g: Group) => g.id === holding.groupId)?.name ?? t('holdings.noGroup');
  const actionLabel = (value: string) => {
    const keys: Record<string, string> = {
      '加仓': 'analysis.add', Add: 'analysis.add',
      '买入': 'analysis.buy', Buy: 'analysis.buy',
      '持有': 'analysis.hold', Hold: 'analysis.hold',
      '减仓': 'analysis.reduce', Reduce: 'analysis.reduce',
      '卖出': 'analysis.sell', Sell: 'analysis.sell',
      '观望': 'analysis.watch', Watch: 'analysis.watch',
    };
    return keys[value] ? t(keys[value]) : value;
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-serif text-xl flex items-center gap-3">
              <span className="font-mono-nums text-primary">
                {holding.ticker}
              </span>
              <span className="text-base font-normal text-muted-foreground">
                {holding.company}
              </span>
              {holding.rating && (
                <Badge
                  className={cn(ratingColor(holding.rating), 'ml-auto')}
                  variant="outline"
                >
                  {holding.rating}
                </Badge>
              )}
            </DialogTitle>
          </DialogHeader>

          {simple && !editing && <div className="flex flex-wrap gap-2"><Button size="sm" asChild><Link to={questionPath({ ticker: holding.ticker })}>{i18n.language.startsWith('zh') ? '问问大家' : 'Ask the team'}</Link></Button><Button size="sm" variant="outline" asChild><Link to={`/analysis?ticker=${encodeURIComponent(holding.ticker)}`}>{i18n.language.startsWith('zh') ? '当前分析' : 'Current analysis'}</Link></Button></div>}

          {editing ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-2">
              <div className="space-y-1.5">
                <Label>{t('holdings.company')}</Label>
                <Input
                  value={form.company}
                  onChange={(e) =>
                    setForm({ ...form, company: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('ui.holdings.sector')}</Label>
                <Input
                  value={form.sector}
                  onChange={(e) =>
                    setForm({ ...form, sector: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('holdings.buyDate')}</Label>
                <Input
                  type="date"
                  value={form.buyDate}
                  onChange={(e) =>
                    setForm({ ...form, buyDate: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('holdings.buyPrice')}</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={form.buyPrice}
                  onChange={(e) =>
                    setForm({ ...form, buyPrice: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('holdings.shares')}</Label>
                <Input
                  type="number"
                  step="0.0001"
                  value={form.shares}
                  onChange={(e) =>
                    setForm({ ...form, shares: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('ui.holdings.currentPrice')}</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={form.currentPrice}
                  onChange={(e) =>
                    setForm({ ...form, currentPrice: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('ui.holdings.rating')}</Label>
                <Select
                  value={form.rating}
                  onValueChange={(v) =>
                    setForm({ ...form, rating: v })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t('ui.holdings.chooseRating')} />
                  </SelectTrigger>
                  <SelectContent>
                    {[
                      'Strong Buy',
                      'Buy',
                      'Hold',
                      'Sell',
                      'Strong Sell',
                    ].map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t('ui.holdings.actions')}</Label>
                <Select
                  value={form.action}
                  onValueChange={(v) =>
                    setForm({ ...form, action: v })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t('ui.holdings.chooseAction')} />
                  </SelectTrigger>
                  <SelectContent>
                    {[
                      ['加仓', 'analysis.add'],
                      ['买入', 'analysis.buy'],
                      ['持有', 'analysis.hold'],
                      ['减仓', 'analysis.reduce'],
                      ['卖出', 'analysis.sell'],
                      ['观望', 'analysis.watch'],
                    ].map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {t(label)}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t('ui.holdings.targetPrice')}</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={form.targetPrice}
                  onChange={(e) =>
                    setForm({ ...form, targetPrice: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('ui.holdings.groupName')}</Label>
                <Select
                  value={form.groupId}
                  onValueChange={(v) =>
                    setForm({ ...form, groupId: v })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t('holdings.noGroup')} />
                  </SelectTrigger>
                  <SelectContent>
                    {groups.map((g: Group) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label>{t('ui.holdings.analysis')}</Label>
                <Textarea
                  rows={4}
                  value={form.analysis}
                  onChange={(e) =>
                    setForm({ ...form, analysis: e.target.value })
                  }
                />
              </div>
            </div>
           ) : (
             <Tabs defaultValue="detail" className="w-full">
               <TabsList className="w-full">
                 <TabsTrigger value="detail" className="flex-1">{t('holdings.detail')}</TabsTrigger>
                 <TabsTrigger value="ai" className="flex-1">
                   <Sparkles className="size-3.5" />
                   {t('ui.holdings.aiReasoning')}
                 </TabsTrigger>
               </TabsList>
               <TabsContent value="detail" className="pt-3 space-y-5">
                 <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <div className="text-xs text-muted-foreground mb-1">
                    {t('ui.holdings.currentPrice')}
                  </div>
                  <div className="font-mono-nums text-lg font-semibold">
                    {formatPrice(holding.currentPrice)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1">
                    {t('ui.holdings.returnPct')}
                  </div>
                  <div
                    className={cn(
                      'font-mono-nums text-lg font-semibold',
                      plClass(returnPct)
                    )}
                  >
                    {formatPercent(returnPct)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1">
                    {t('ui.holdings.pl')}
                  </div>
                  <div
                    className={cn(
                      'font-mono-nums text-lg font-semibold',
                      plClass(pl)
                    )}
                  >
                    {formatCurrency(pl)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1">
                    {t('ui.holdings.actions')}
                  </div>
                  <div>
                    {holding.action ? (
                      <Badge
                        className={cn(actionColor(holding.action))}
                        variant="outline"
                      >
                        {actionLabel(holding.action)}
                      </Badge>
                    ) : (
                      '—'
                    )}
                  </div>
                </div>
              </div>

              <Separator />

              <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('ui.holdings.sector')}</span>
                  <span>{holding.sector ?? '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('holdings.buyDate')}</span>
                  <span className="font-mono-nums">
                    {formatDate(holding.buyDate)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('holdings.buyPrice')}</span>
                  <span className="font-mono-nums">
                    {formatPrice(holding.buyPrice)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('holdings.shares')}</span>
                  <span className="font-mono-nums">
                    {formatShares(holding.shares)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('ui.holdings.marketValue')}</span>
                  <span className="font-mono-nums">
                    {formatCurrency(marketValue)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('ui.holdings.cost')}</span>
                  <span className="font-mono-nums">
                    {formatCurrency(cost)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('ui.holdings.targetPrice')}</span>
                  <span className="font-mono-nums">
                    {formatPrice(holding.targetPrice)}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">{t('ui.holdings.groupName')}</span>
                  <span className="flex items-center gap-1.5">
                    <FolderOpen className="size-3.5 text-primary" />
                    {groupName}
                  </span>
                </div>
              </div>

              <Separator />

              <div>
                <div className="text-xs text-muted-foreground mb-1.5">
                  {t('ui.holdings.analysis')}
                </div>
                <div className="text-sm whitespace-pre-wrap leading-relaxed text-foreground/90">
                  {holding.analysis ?? t('ui.holdings.noAnalysis')}
                </div>
              </div>

              <Separator />

                 <div className="flex items-center justify-between">
                   <div className="flex items-center gap-2">
                     <Label className="text-xs text-muted-foreground">
                       {t('ui.holdings.moveGroup')}
                     </Label>
                     <Select
                       value={holding.groupId ?? ''}
                       onValueChange={handleGroupChange}
                     >
                       <SelectTrigger className="w-40 h-8 text-xs" size="sm">
                         <SelectValue placeholder={t('holdings.noGroup')} />
                       </SelectTrigger>
                       <SelectContent>
                         {groups.map((g: Group) => (
                           <SelectItem key={g.id} value={g.id}>
                             {g.name}
                           </SelectItem>
                         ))}
                       </SelectContent>
                     </Select>
                   </div>
                 </div>
               </TabsContent>
               <TabsContent value="ai" className="pt-3 space-y-5">
                 {aiRating ? (
                   <>
                     <div className="flex flex-wrap items-center gap-3">
                       <RatingBadge rating={aiRating.rating} size="md" />
                       <ConfidenceBadge confidence={aiRating.confidence} size="md" />
                       {aiRating.targetPrice && (
                         <div className="flex items-center gap-1.5 text-sm">
                           <span className="text-muted-foreground">{t('ui.holdings.targetPrice')}</span>
                           <span className="font-mono-nums font-semibold">
                             {formatPrice(aiRating.targetPrice)}
                           </span>
                         </div>
                       )}
                       <Badge variant="outline" className={cn(actionColor(aiRating.action))}>
                         {aiRating.action}
                       </Badge>
                     </div>

                     <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                       <Card>
                         <CardContent className="p-4">
                           <div className="flex items-center gap-2 text-emerald-600 mb-2">
                             <TrendingUp className="size-4" />
                             <span className="font-medium text-sm">{t('ui.holdings.bullView')}</span>
                           </div>
                           <div className="text-sm text-foreground/80 leading-relaxed whitespace-pre-wrap">
                             {aiRating.bullSummary ?? t('holdings.noBullSummary')}
                           </div>
                         </CardContent>
                       </Card>
                       <Card>
                         <CardContent className="p-4">
                           <div className="flex items-center gap-2 text-rose-600 mb-2">
                             <TrendingDown className="size-4" />
                             <span className="font-medium text-sm">{t('ui.holdings.bearView')}</span>
                           </div>
                           <div className="text-sm text-foreground/80 leading-relaxed whitespace-pre-wrap">
                             {aiRating.bearSummary ?? t('holdings.bearSummary')}
                           </div>
                         </CardContent>
                       </Card>
                     </div>

                     <div className="flex items-center gap-2 pt-2 border-t">
                       <ShieldAlert className="size-4 text-muted-foreground" />
                       <span className="text-sm text-muted-foreground flex-1">
                         {t('ui.holdings.riskPassed')}
                       </span>
                     </div>

                     <Button
                       variant="outline"
                       size="sm"
                       className="w-full"
                       onClick={() => onViewFullAnalysis?.(aiRating.runId)}
                     >
                       <ExternalLink className="size-4" />
                       {t('ui.holdings.viewReasoning')}
                     </Button>
                   </>
                 ) : (
                   <div className="py-12 text-center space-y-3">
                     <div className="flex justify-center">
                       <Sparkles className="size-10 text-muted-foreground/40" />
                     </div>
                     <div className="text-sm font-medium text-foreground">
                       {t('ui.holdings.noAiAnalysis')}
                     </div>
                     <div className="text-xs text-muted-foreground">
                       {t('ui.holdings.runDeepAnalysis')}
                     </div>
                   </div>
                 )}
               </TabsContent>
             </Tabs>
           )}

          <DialogFooter className="flex-row gap-2 sm:gap-2">
            <Button
              variant="destructive"
              size="sm"
              className="mr-auto"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="size-4" />
              {t('common.delete')}
            </Button>
            {editing ? (
              <>
                <Button variant="outline" size="sm" onClick={closeEdit}>
                  <X className="size-4" />
                  {t('common.cancel')}
                </Button>
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  <Check className="size-4" />
                  {t('common.save')}
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={startEdit}>
                <Pencil className="size-4" />
                {t('common.edit')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('ui.holdings.deleteHoldingTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('ui.holdings.deleteHoldingDesc', { ticker: holding.ticker })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {saving ? t('holdings.deleting') : t('common.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
