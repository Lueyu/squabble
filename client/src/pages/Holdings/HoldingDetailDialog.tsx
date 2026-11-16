/**
 * HoldingDetailDialog.tsx — 单个持仓的详情 / 编辑对话框。
 *
 * 职责边界：
 *  - 两种视图模式：只读态用双 Tab 布局（"详情"Tab 展示价格 / 盈亏 / 成本 / 分组 / 备注，
 *    "AI 推理"Tab 展示评级 / 置信度 / 目标价 / 多空观点摘要）；
 *    编辑态是两列网格表单，保存时 PATCH 只提交有差异的字段；
 *  - 同时承载删除确认（AlertDialog）与"移动分组"快捷下拉。
 * 上下游：
 *  - 上游：HoldingsPage（open / holding / groups / onUpdated / onDeleted / aiRating）；
 *  - 下游：@/api 的 updateHolding / deleteHolding，@/utils/format 格式化函数，
 *    @/components/MultiAgent 的 RatingBadge / ConfidenceBadge，@/components/ui 各控件。
 * 关键约定：
 *  - Holding 的 shares / buyPrice / currentPrice / targetPrice 是"字符串数值"；
 *    编辑表单全程保存 string，提交时才 parseFloat 转 number；
 *  - PATCH 语义：字段值为空串时提交 undefined = 通知后端"清空该字段"；
 *    未出现在 payload 里的字段后端保持不变；
 *  - 无选中持仓（holding 为 null）时整个对话框渲染 null——所有 hooks 都在早退之前调用，
 *    hook 调用顺序不受影响。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Pencil,
  Trash2,
  FolderOpen,
  X,
  Check,
  Sparkles,
  TrendingUp,
  TrendingDown,
  ShieldAlert,
  ExternalLink,
} from 'lucide-react';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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

/** "AI 推理"Tab 上展示的 AI 评级信息。 */
interface AiRatingInfo {
  rating: AgentRating;
  confidence: AgentConfidence;
  targetPrice: string | null;
  action: string;
  runId: string;
  bullSummary: string | null;
  bearSummary: string | null;
}

/** {@link HoldingDetailDialog} 的入参。 */
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

/** 由原始持仓推导市值 / 成本 / 盈亏 / 收益率（与 HoldingsPage.computeDerived 同一套公式）。 */
function computeDerived(h: Holding) {
  // 字符串数值字段 parseFloat 转 number（空串兜底 0）；成本为 0 时收益率记 0。
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
 * 渲染持仓详情对话框；无选中持仓时返回 null。
 * @param props - 见 {@link HoldingDetailDialogProps}。
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
  // ---- 状态声明区 ----
  const { t } = useTranslation();
  // 编辑模式开关 / 删除确认开关 / 提交中标记。
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  // 编辑表单草稿：全部字段为 string，进入编辑时从 holding 拷贝。
  const [form, setForm] = useState<Record<string, string>>({});

  // ---- 事件处理区 ----
  /** 把持仓当前字段拷进编辑表单并进入编辑模式。 */
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

  /** 退出编辑模式并清空表单草稿。 */
  const closeEdit = () => {
    setEditing(false);
    setForm({});
  };

  /**
   * 只 PATCH 与持仓当前值不同的字段：数字字段 parseFloat 转 number；
   * 空串提交为 undefined（后端按"清空"处理）。
   */
  const handleSave = async () => {
    if (!holding) return;
    setSaving(true);
    try {
      // 第一步：逐字段组装 payload——form 里有定义才进 payload，空串归一为 undefined。
      const payload: Record<string, string | number | undefined> = {};
      if (form.company !== undefined) payload.company = form.company || undefined;
      if (form.sector !== undefined) payload.sector = form.sector || undefined;
      if (form.buyDate !== undefined) payload.buyDate = form.buyDate || undefined;
      if (form.buyPrice !== undefined)
        payload.buyPrice = form.buyPrice ? parseFloat(form.buyPrice) : undefined;
      if (form.shares !== undefined)
        payload.shares = form.shares ? parseFloat(form.shares) : undefined;
      if (form.currentPrice !== undefined)
        payload.currentPrice = form.currentPrice ? parseFloat(form.currentPrice) : undefined;
      if (form.rating !== undefined) payload.rating = form.rating || undefined;
      if (form.action !== undefined) payload.action = form.action || undefined;
      if (form.targetPrice !== undefined)
        payload.targetPrice = form.targetPrice ? parseFloat(form.targetPrice) : undefined;
      if (form.analysis !== undefined) payload.analysis = form.analysis || undefined;
      if (form.groupId !== undefined) payload.groupId = form.groupId || undefined;

      // 第二步：请求保存；成功后退出编辑并通知父组件刷新。
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

  /** 确认删除持仓：成功后关对话框与确认框，并回调 onDeleted 刷新列表。 */
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

  /** "移动分组"快捷下拉的回调：空 value 提交 undefined（清空分组归属）。 */
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

  // ---- 派生计算区 ----
  // 无选中持仓时渲染 null（hooks 已全部在上方调用，顺序安全）。
  if (!holding) return null;

  const { marketValue, cost, pl, returnPct } = computeDerived(holding);
  const groupName =
    groups.find((g: Group) => g.id === holding.groupId)?.name ?? t('holdings.noGroup');
  // 操作建议文案映射：历史数据可能是中文或英文原文，映射到 i18n key；未命中原样展示。
  const actionLabel = (value: string) => {
    const keys: Record<string, string> = {
      加仓: 'analysis.add',
      Add: 'analysis.add',
      买入: 'analysis.buy',
      Buy: 'analysis.buy',
      持有: 'analysis.hold',
      Hold: 'analysis.hold',
      减仓: 'analysis.reduce',
      Reduce: 'analysis.reduce',
      卖出: 'analysis.sell',
      Sell: 'analysis.sell',
      观望: 'analysis.watch',
      Watch: 'analysis.watch',
    };
    return keys[value] ? t(keys[value]) : value;
  };

  // ---- 渲染区 ----
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            {/* 标题行：代码 + 公司名 + 人工评级徽标（有才显示）。 */}
            <DialogTitle className="font-serif text-xl flex items-center gap-3">
              <span className="font-mono-nums text-primary">{holding.ticker}</span>
              <span className="text-base font-normal text-muted-foreground">{holding.company}</span>
              {holding.rating && (
                <Badge className={cn(ratingColor(holding.rating), 'ml-auto')} variant="outline">
                  {holding.rating}
                </Badge>
              )}
            </DialogTitle>
          </DialogHeader>

          {/* 编辑态：两列网格表单；只读态：双 Tab 布局。 */}
          {editing ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-2">
              <div className="space-y-1.5">
                <Label>{t('holdings.company')}</Label>
                <Input
                  value={form.company}
                  onChange={(e) => setForm({ ...form, company: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('ui.holdings.sector')}</Label>
                <Input
                  value={form.sector}
                  onChange={(e) => setForm({ ...form, sector: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('holdings.buyDate')}</Label>
                <Input
                  type="date"
                  value={form.buyDate}
                  onChange={(e) => setForm({ ...form, buyDate: e.target.value })}
                />
              </div>
              {/* 价格与股数：number 输入框，草稿仍是 string，提交时才解析。 */}
              <div className="space-y-1.5">
                <Label>{t('holdings.buyPrice')}</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={form.buyPrice}
                  onChange={(e) => setForm({ ...form, buyPrice: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('holdings.shares')}</Label>
                <Input
                  type="number"
                  step="0.0001"
                  value={form.shares}
                  onChange={(e) => setForm({ ...form, shares: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('ui.holdings.currentPrice')}</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={form.currentPrice}
                  onChange={(e) => setForm({ ...form, currentPrice: e.target.value })}
                />
              </div>
              {/* 评级下拉：value 与展示均为英文原文。 */}
              <div className="space-y-1.5">
                <Label>{t('ui.holdings.rating')}</Label>
                <Select value={form.rating} onValueChange={(v) => setForm({ ...form, rating: v })}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t('ui.holdings.chooseRating')} />
                  </SelectTrigger>
                  <SelectContent>
                    {['Strong Buy', 'Buy', 'Hold', 'Sell', 'Strong Sell'].map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {/* 操作建议下拉：value 存中文原文，展示走 i18n。 */}
              <div className="space-y-1.5">
                <Label>{t('ui.holdings.actions')}</Label>
                <Select value={form.action} onValueChange={(v) => setForm({ ...form, action: v })}>
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
                  onChange={(e) => setForm({ ...form, targetPrice: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('ui.holdings.groupName')}</Label>
                <Select
                  value={form.groupId}
                  onValueChange={(v) => setForm({ ...form, groupId: v })}
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
              {/* 分析备注：占满两列。 */}
              <div className="space-y-1.5 md:col-span-2">
                <Label>{t('ui.holdings.analysis')}</Label>
                <Textarea
                  rows={4}
                  value={form.analysis}
                  onChange={(e) => setForm({ ...form, analysis: e.target.value })}
                />
              </div>
            </div>
          ) : (
            <Tabs defaultValue="detail" className="w-full">
              <TabsList className="w-full">
                <TabsTrigger value="detail" className="flex-1">
                  {t('holdings.detail')}
                </TabsTrigger>
                <TabsTrigger value="ai" className="flex-1">
                  <Sparkles className="size-3.5" />
                  {t('ui.holdings.aiReasoning')}
                </TabsTrigger>
              </TabsList>
              {/* "详情"Tab：核心指标网格 → 明细字段网格 → 分析备注 → 移动分组。 */}
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
                    <div className={cn('font-mono-nums text-lg font-semibold', plClass(returnPct))}>
                      {formatPercent(returnPct)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">{t('ui.holdings.pl')}</div>
                    <div className={cn('font-mono-nums text-lg font-semibold', plClass(pl))}>
                      {formatCurrency(pl)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">
                      {t('ui.holdings.actions')}
                    </div>
                    <div>
                      {holding.action ? (
                        <Badge className={cn(actionColor(holding.action))} variant="outline">
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
                    <span className="font-mono-nums">{formatDate(holding.buyDate)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('holdings.buyPrice')}</span>
                    <span className="font-mono-nums">{formatPrice(holding.buyPrice)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('holdings.shares')}</span>
                    <span className="font-mono-nums">{formatShares(holding.shares)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('ui.holdings.marketValue')}</span>
                    <span className="font-mono-nums">{formatCurrency(marketValue)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('ui.holdings.cost')}</span>
                    <span className="font-mono-nums">{formatCurrency(cost)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('ui.holdings.targetPrice')}</span>
                    <span className="font-mono-nums">{formatPrice(holding.targetPrice)}</span>
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
                    {/* 移动分组：变更即 PATCH 保存（handleGroupChange），无需进编辑模式。 */}
                    <Select value={holding.groupId ?? ''} onValueChange={handleGroupChange}>
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
              {/* "AI 推理"Tab：有评级展示摘要卡片，无则空态引导。 */}
              <TabsContent value="ai" className="pt-3 space-y-5">
                {aiRating ? (
                  <>
                    <div className="flex flex-wrap items-center gap-3">
                      <RatingBadge rating={aiRating.rating} size="md" />
                      <ConfidenceBadge confidence={aiRating.confidence} size="md" />
                      {/* AI 给出的目标价（有才显示）。 */}
                      {aiRating.targetPrice && (
                        <div className="flex items-center gap-1.5 text-sm">
                          <span className="text-muted-foreground">
                            {t('ui.holdings.targetPrice')}
                          </span>
                          <span className="font-mono-nums font-semibold">
                            {formatPrice(aiRating.targetPrice)}
                          </span>
                        </div>
                      )}
                      <Badge variant="outline" className={cn(actionColor(aiRating.action))}>
                        {aiRating.action}
                      </Badge>
                    </div>

                    {/* 多空观点双卡片：多（绿）/ 空（红），空摘要回退占位文案。 */}
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

                    {/* 查看完整推理：跳转 AI 运行详情弹窗（父组件处理）。 */}
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
                  // 空态：该持仓还没有 AI 分析结果。
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

          {/* 底部操作条：删除（左）、编辑态的取消/保存 或 只读态的编辑按钮。 */}
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

      {/* 删除确认弹窗：展示待删代码，确认后执行 handleDelete。 */}
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
