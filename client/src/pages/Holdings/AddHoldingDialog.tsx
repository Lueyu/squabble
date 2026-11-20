/**
 * AddHoldingDialog.tsx — 新增持仓对话框。
 *
 * 职责边界：
 *  - 受控表单收集持仓信息：仅代码与股数必填；数字字段提交时 parseFloat 转 number，
 *    可选字符串字段为空时不进 payload（交给后端取默认值）；
 *  - 代码输入时前端预演市场归属（detectMarket），徽标实时显示市场 / 币种 / 规范化代码；
 *  - 支持就地新建分组：创建成功后追加进本地 extraGroups 并自动选中，
 *    同时回调 onGroupsChanged 通知父组件重新拉取分组列表。
 * 上下游：
 *  - 上游：HoldingsPage（open / groups / onCreated / onGroupsChanged）；
 *  - 下游：@/api 的 createHolding / createGroup、sonner 的 toast、@/components/ui 表单控件。
 * 关键约定：
 *  - 表单数字字段（buyPrice / shares / currentPrice / targetPrice）一律保存为 string，
 *    组装 payload 时才 parseFloat 转 number——字符串数值与 number 的转换只发生在提交处；
 *  - detectMarket 是后端 quoteService.detectMarket 的前端预演副本，两边规则必须同步维护；
 *  - 新建分组的回调 onGroupsChanged 是可选的（缺省时父组件不刷新，本地 extraGroups 兜底展示）。
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { Group, Market, Currency } from '@shared/api.interface';
import { createHolding, createGroup } from '@/api';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Plus } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** {@link AddHoldingDialog} 的入参。 */
interface AddHoldingDialogProps {
  /** 对话框开关（受控）。 */
  open: boolean;
  /** 开关变更回调（父组件持有 open state）。 */
  onOpenChange: (open: boolean) => void;
  /** 分组列表（来自父组件）。 */
  groups: Group[];
  /** 创建成功后的回调（父组件刷新持仓列表）。 */
  onCreated: () => void;
  /** 新建分组后通知父组件重新拉取 groups。 */
  onGroupsChanged?: () => void;
}

/** 与后端 quoteService.detectMarket 保持一致的前端预演。 */
function detectMarket(symbol: string): {
  market: Market;
  currency: Currency;
  displaySymbol: string;
} {
  // 统一转大写再去空白。
  const upper = symbol.toUpperCase().trim();
  // 规则一：带后缀的直接归类——.HK 港股，.SH / .SZ / .BJ 均 A 股。
  if (upper.endsWith('.HK')) {
    return { market: 'HK', currency: 'HKD', displaySymbol: upper };
  }
  if (upper.endsWith('.SH')) {
    return { market: 'CN', currency: 'CNY', displaySymbol: upper };
  }
  if (upper.endsWith('.SZ')) {
    return { market: 'CN', currency: 'CNY', displaySymbol: upper };
  }
  if (upper.endsWith('.BJ')) {
    return { market: 'CN', currency: 'CNY', displaySymbol: upper };
  }
  // 规则二：纯数字代码按位数与首位推断，并补上规范后缀。
  if (/^\d+$/.test(upper)) {
    // 5 位数字 → 港股（前导 0 去掉后补 .HK）。
    if (upper.length === 5) {
      const displayCode = upper.startsWith('0') ? upper.slice(1) : upper;
      return {
        market: 'HK',
        currency: 'HKD',
        displaySymbol: `${displayCode}.HK`,
      };
    }
    // 6 位数字 → A 股：6 开头沪市、0/3 开头深市、8/4 开头北交所。
    if (upper.length === 6) {
      if (upper.startsWith('6')) {
        return { market: 'CN', currency: 'CNY', displaySymbol: `${upper}.SH` };
      }
      if (upper.startsWith('0') || upper.startsWith('3')) {
        return { market: 'CN', currency: 'CNY', displaySymbol: `${upper}.SZ` };
      }
      if (upper.startsWith('8') || upper.startsWith('4')) {
        return { market: 'CN', currency: 'CNY', displaySymbol: `${upper}.BJ` };
      }
    }
  }
  // 规则三：其余默认美股 / USD。
  return { market: 'US', currency: 'USD', displaySymbol: upper };
}

/**
 * 渲染新增持仓对话框。
 * @param props - 见 {@link AddHoldingDialogProps}。
 */
export default function AddHoldingDialog({
  open,
  onOpenChange,
  groups,
  onCreated,
  onGroupsChanged,
}: AddHoldingDialogProps) {
  // ---- 状态声明区 ----
  const { t } = useTranslation();
  // 提交中 / 新建分组中两个独立标记。
  const [saving, setSaving] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  // 新建分组的名称草稿。
  const [newGroupName, setNewGroupName] = useState('');
  // 本次会话内新建的分组（父组件刷新 groups 前先在本地兜底展示）。
  const [extraGroups, setExtraGroups] = useState<Group[]>([]);
  // 表单受控状态：数字字段保存字符串，提交时才转 number。
  const [form, setForm] = useState({
    ticker: '',
    company: '',
    sector: '',
    buyDate: '',
    buyPrice: '',
    shares: '',
    currentPrice: '',
    rating: '',
    action: '',
    targetPrice: '',
    analysis: '',
    groupId: '',
  });

  // ---- 派生计算区 ----
  // 下拉可选分组 = 父组件下发的 groups + 本地新建的 extraGroups。
  const allGroups = useMemo(() => [...groups, ...extraGroups], [groups, extraGroups]);

  // 市场预演结果：代码为空时 null（不显示徽标），否则按 detectMarket 推断。
  const marketPreview = useMemo(() => {
    if (!form.ticker.trim()) return null;
    return detectMarket(form.ticker);
  }, [form.ticker]);

  /** 创建成功后把表单与新建分组相关状态全部重置为空白。 */
  const reset = () => {
    setForm({
      ticker: '',
      company: '',
      sector: '',
      buyDate: '',
      buyPrice: '',
      shares: '',
      currentPrice: '',
      rating: '',
      action: '',
      targetPrice: '',
      analysis: '',
      groupId: '',
    });
    setNewGroupName('');
    setCreatingGroup(false);
    setExtraGroups([]);
  };

  // ---- 事件处理区 ----
  /** 就地新建分组：成功后本地追加、自动选中、清空草稿，并通知父组件刷新分组。 */
  const handleCreateGroup = async () => {
    // 第一步：校验分组名非空。
    const name = newGroupName.trim();
    if (!name) {
      toast.error(t('ui.holdings.enterGroupName'));
      return;
    }
    // 第二步：请求创建；成功后本地追加并自动选中。
    setCreatingGroup(true);
    try {
      const g = (await createGroup({ name })) as Group;
      setExtraGroups((prev) => [...prev, g]);
      setForm((f) => ({ ...f, groupId: g.id }));
      setNewGroupName('');
      setCreatingGroup(false);
      toast.success(t('ui.holdings.groupCreated', { name }));
      onGroupsChanged?.();
    } catch (err) {
      toast.error(t('ui.holdings.createGroupFailed'));
    } finally {
      setCreatingGroup(false);
    }
  };

  /**
   * 校验必填项并 POST 新持仓。成功后重置表单、关对话框、回调 onCreated 让父组件重新拉取。
   */
  const handleSubmit = async () => {
    // 第一步：校验必填——代码非空、股数为正数。
    if (!form.ticker.trim()) {
      toast.error(t('holdings.tickerInvalid'));
      return;
    }
    if (!form.shares || parseFloat(form.shares) <= 0) {
      toast.error(t('tx.sharesInvalid'));
      return;
    }
    // 第二步：组装 payload——必填字段直接带；可选字段有值才带（空 = 交后端默认值），
    // 数字字段 parseFloat 转 number。
    setSaving(true);
    try {
      const payload: Record<string, string | number | undefined> = {
        ticker: form.ticker.trim().toUpperCase(),
        shares: parseFloat(form.shares),
      };
      if (form.company) payload.company = form.company;
      if (form.sector) payload.sector = form.sector;
      if (form.buyDate) payload.buyDate = form.buyDate;
      if (form.buyPrice) payload.buyPrice = parseFloat(form.buyPrice);
      if (form.currentPrice) payload.currentPrice = parseFloat(form.currentPrice);
      if (form.rating) payload.rating = form.rating;
      if (form.action) payload.action = form.action;
      if (form.targetPrice) payload.targetPrice = parseFloat(form.targetPrice);
      if (form.analysis) payload.analysis = form.analysis;
      if (form.groupId) payload.groupId = form.groupId;

      // 第三步：请求创建；失败仅 toast 提示（错误详情不上抛）。
      await createHolding(payload);
      toast.success(t('holdings.addHolding'));
      // 第四步：成功后重置表单、关闭对话框、通知父组件刷新。
      reset();
      onOpenChange(false);
      onCreated();
    } catch (err) {
      toast.error(t('ui.holdings.addFailed'));
    } finally {
      setSaving(false);
    }
  };

  // ---- 渲染区：两列表单网格（目标价与备注占满两列）+ 底部按钮。 ----
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-serif text-xl">{t('holdings.addHolding')}</DialogTitle>
          <DialogDescription>{t('ui.holdings.addDescription')}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-2">
          {/* 代码：必填，输入即转大写；非空时旁边显示市场预演徽标。 */}
          <div className="space-y-1.5">
            <Label>
              {t('holdings.ticker')} <span className="text-destructive">*</span>
            </Label>
            <div className="flex items-center gap-2">
              <Input
                placeholder={t('ui.holdings.tickerExample')}
                value={form.ticker}
                onChange={(e) => setForm({ ...form, ticker: e.target.value.toUpperCase() })}
              />
              {/* 市场预演徽标：市场名 + 币种 + 规范化代码。 */}
              {marketPreview && (
                <Badge
                  variant="outline"
                  className="shrink-0 text-[10px] font-normal whitespace-nowrap"
                >
                  {t(
                    `common.${marketPreview.market === 'US' ? 'usMarket' : marketPreview.market === 'HK' ? 'hkMarket' : 'cnMarket'}`,
                  )}{' '}
                  {marketPreview.currency} · {marketPreview.displaySymbol}
                </Badge>
              )}
            </div>
          </div>
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
          {/* 分组：下拉选择 + "新建分组"按钮；creatingGroup 展开就地建组输入行。 */}
          <div className="space-y-1.5">
            <Label>{t('ui.holdings.groupName')}</Label>
            <div className="flex items-center gap-2">
              <Select value={form.groupId} onValueChange={(v) => setForm({ ...form, groupId: v })}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t('holdings.noGroup')} />
                </SelectTrigger>
                <SelectContent>
                  {allGroups.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* 切换就地建组输入行的展开 / 收起。 */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 h-9 gap-1"
                onClick={() => setCreatingGroup((v) => !v)}
              >
                <Plus className="size-3.5" />
                {t('ui.holdings.newGroup')}
              </Button>
            </div>
            {/* 就地建组输入行：仅 creatingGroup 时渲染；回车或点确认都会提交。 */}
            {creatingGroup && (
              <div className="flex items-center gap-2 pt-1">
                <Input
                  autoFocus
                  placeholder={t('ui.holdings.newGroupPlaceholder')}
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleCreateGroup();
                    }
                  }}
                  className="h-8"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={handleCreateGroup}
                  disabled={!newGroupName.trim()}
                  className="h-8"
                >
                  {t('common.confirm')}
                </Button>
              </div>
            )}
          </div>
          {/* 买入日期：原生 date input，值为 YYYY-MM-DD 字符串。 */}
          <div className="space-y-1.5">
            <Label>{t('holdings.buyDate')}</Label>
            <Input
              type="date"
              value={form.buyDate}
              onChange={(e) => setForm({ ...form, buyDate: e.target.value })}
            />
          </div>
          {/* 价格与股数：number 输入框，值仍以字符串保存在 form 中，提交时才解析。 */}
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
            <Label>
              {t('holdings.shares')} <span className="text-destructive">*</span>
            </Label>
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
          {/* 评级下拉：value 与展示值都是英文原文。 */}
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
          {/* 目标价：占满两列。 */}
          <div className="space-y-1.5 md:col-span-2">
            <Label>{t('ui.holdings.targetPrice')}</Label>
            <Input
              type="number"
              step="0.01"
              value={form.targetPrice}
              onChange={(e) => setForm({ ...form, targetPrice: e.target.value })}
            />
          </div>
          {/* 分析备注：占满两列。 */}
          <div className="space-y-1.5 md:col-span-2">
            <Label>{t('ui.holdings.analysis')}</Label>
            <Textarea
              rows={3}
              value={form.analysis}
              onChange={(e) => setForm({ ...form, analysis: e.target.value })}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          {/* 提交按钮：saving 期间禁用并显示保存中文案。 */}
          <Button size="sm" onClick={handleSubmit} disabled={saving}>
            {saving ? t('common.saving') : t('holdings.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
