/**
 * StrategyRulesPage.tsx — 策略规则管理页：按分类分组的多智能体策略规则增删改、排序与恢复默认。
 *
 * 职责边界：
 *  - 规则按六类分组展示：仓位集中度 / 止盈止损 / 买入条件 / 现金管理 / 风险闸门 / 其他；
 *  - 每条规则带 hard/soft 类型与 warning/hard_block 严重级别两种徽标；
 *  - 支持弹窗新增/编辑/删除、逐条启用开关、阈值行内编辑（Enter 保存 / Escape 取消）、
 *    分类内拖拽排序，以及一键恢复系统默认规则集。
 * 上下游：
 *  - 上游（路由入口/谁引用）：app.tsx 路由 /settings/rules；SettingsPage 以 embedded 形式内嵌
 *    （embedded 隐藏页头；active=false 表示所在分区未激活，两个弹窗被强制关闭——面板保挂）。
 *  - 下游（调用哪些 hooks/api/组件）：@/api 的 getStrategyRules / createStrategyRule /
 *    updateStrategyRule / deleteStrategyRule / reorderStrategyRules / resetStrategyRules；
 *    @shared/api.interface 的 StrategyRule / RuleCategory / RuleSeverity / RuleType 等；
 *    Card/Switch/Badge/Input/Select/Dialog/AlertDialog/Textarea/Skeleton；logger；toast。
 * 关键约定：
 *  - 乐观更新 + 失败回滚：启停开关、拖拽排序、阈值行内编辑三处先改本地 state 再发请求，
 *    失败时回滚旧值；新增/删除/恢复默认成功后整体 loadRules() 重拉。
 *  - 拖拽仅允许同一分类内重排（跨分类 drop 拒绝并提示）；提交的 sort 按组内新顺序 0..n 编号。
 *  - 阈值展示：formatThreshold 识别 pct/%、days、usd 三类单位，其余单位原样追加；
 *    threshold 为 null/空/非数字时显示 — 且不可行内编辑。
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import {
  Plus,
  Pencil,
  Trash2,
  RotateCcw,
  GripVertical,
  AlertTriangle,
  Shield,
  Lightbulb,
  Check,
  X,
} from 'lucide-react';
import { logger } from '@/utils/logger';
import type {
  StrategyRule,
  RuleCategory,
  RuleSeverity,
  RuleType,
  CreateStrategyRuleDto,
  UpdateStrategyRuleDto,
} from '@shared/api.interface';
import {
  getStrategyRules,
  createStrategyRule,
  updateStrategyRule,
  deleteStrategyRule,
  reorderStrategyRules,
  resetStrategyRules,
} from '@/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

import { useTranslation } from 'react-i18next';

// ── 分类定义 ─────────────────────────────────
/** 规则分类的固定渲染顺序：分组展示与归类都按此表进行，未知分类归入 other。 */
const CATEGORY_ORDER: Array<{
  key: RuleCategory | 'other';
  labelKey: string;
  icon?: string;
}> = [
  { key: 'position_concentration', labelKey: 'rules.concentration' },
  { key: 'stop_loss_take_profit', labelKey: 'rules.stopLoss' },
  { key: 'buy_conditions', labelKey: 'rules.buyCond' },
  { key: 'cash_management', labelKey: 'rules.cashMgmt' },
  { key: 'risk_gate', labelKey: 'ui.rules.riskGate' },
  { key: 'other', labelKey: 'ui.rules.other' },
];

// 严重级别 → i18n key 映射（hard_block=硬阻断 / warning=仅提示）
const SEVERITY_LABEL_KEYS: Record<RuleSeverity, string> = {
  hard_block: 'rules.hardBlock',
  warning: 'rules.warning',
};

// 规则类型 → i18n key 映射（hard=硬规则 / soft=软规则）
const RULE_TYPE_LABEL_KEYS: Record<RuleType, string> = {
  hard: 'rules.hardRule',
  soft: 'rules.softRule',
};

// ── 辅助函数 ──────────────────────────────────────────────
/** 解析规则的分类桶：无 category 或不在 CATEGORY_ORDER 定义内的一律归 other。 */
function getCategoryKey(rule: StrategyRule): RuleCategory | 'other' {
  if (!rule.category) return 'other';
  const defined = CATEGORY_ORDER.slice(0, -1).some((c) => c.key === rule.category);
  return defined ? rule.category : 'other';
}

/** 把规则按固定分类顺序分桶，桶内再按各自 sort 值升序排列。 */
function groupRules(rules: StrategyRule[]): Record<string, StrategyRule[]> {
  const groups: Record<string, StrategyRule[]> = {};
  for (const cat of CATEGORY_ORDER) {
    groups[cat.key] = [];
  }
  for (const rule of rules) {
    const key = getCategoryKey(rule);
    groups[key].push(rule);
  }
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => a.sort - b.sort);
  }
  return groups;
}

/** 阈值人性化展示：识别 pct/%、days、usd 三类单位做后缀/翻译，其余单位原样追加；无效值显示 —。 */
function formatThreshold(
  threshold: string | number | null,
  unit: string | null,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (threshold === null || threshold === '') return '—';
  const num = typeof threshold === 'number' ? threshold : parseFloat(threshold);
  if (Number.isNaN(num)) return '—';
  const numStr = String(num);
  const u = (unit ?? '').trim().toLowerCase();
  if (u === 'pct' || u === '%') return `${numStr}%`;
  if (u === 'days' || u === 'day') return t('ui.rules.days', { count: num });
  if (u === 'usd') return `$${numStr}`;
  if (!u) return numStr;
  return `${numStr} ${unit}`;
}

// ── 主页面组件 ────────────────────────────────────────────
/**
 * 策略规则管理页。
 *
 * 状态分组：列表加载 / 新增编辑弹窗 / 删除确认 / 恢复默认确认 / 拖拽 / 阈值行内编辑。
 * 弹窗均受 active 控制（所在分区未激活时强制关闭）；拖拽中转 id 与分类用 ref 承载。
 */
function StrategyRulesPage({
  embedded = false,
  active = true,
}: { embedded?: boolean; active?: boolean } = {}) {
  // —— 状态声明区 ——
  const { t } = useTranslation();
  // 规则全量列表与加载/错误态
  const [rules, setRules] = useState<StrategyRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 新增 / 编辑弹窗：editingRule=null 表示新建；formData 为弹窗草稿；saving 为提交中
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<StrategyRule | null>(null);
  const [formData, setFormData] = useState<{
    ruleKey: string;
    ruleName: string;
    ruleType: RuleType;
    threshold: string;
    unit: string;
    description: string;
    category: RuleCategory | 'none';
    severity: RuleSeverity;
  }>({
    ruleKey: '',
    ruleName: '',
    ruleType: 'soft',
    threshold: '',
    unit: '',
    description: '',
    category: 'none',
    severity: 'warning',
  });
  const [saving, setSaving] = useState(false);

  // 删除确认：deleteTarget 为待删规则，deleting 为请求进行中
  const [deleteTarget, setDeleteTarget] = useState<StrategyRule | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 恢复默认确认
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  // 拖拽状态：被拖规则 id 与其分类用 ref 承载（避免拖拽事件闭包过期）；dragOverId 仅作高亮
  const dragIdRef = useRef<string | null>(null);
  const dragCatRef = useRef<RuleCategory | 'other' | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);

  // 阈值行内编辑：editingThresholdId 定位正在编辑的行，thresholdValue 为输入草稿
  const [editingThresholdId, setEditingThresholdId] = useState<string | null>(null);
  const [thresholdValue, setThresholdValue] = useState('');

  // ── 数据加载 ────────────────────────────────────────────
  /** 拉取全部策略规则写入 state；失败写 error 并 toast。 */
  const loadRules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = (await getStrategyRules()) as StrategyRule[];
      setRules(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.failed');
      setError(message);
      logger.error('加载策略规则失败', err);
      toast.error(t('rules.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // 首次挂载拉取列表（loadRules 因 t 变化重建时重新拉取）
  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  // —— 派生计算区 ——
  // 规则按分类分桶（渲染直接按 CATEGORY_ORDER 取桶）
  const grouped = useMemo(() => groupRules(rules), [rules]);

  // 硬/软规则计数（顶部说明卡展示）
  const hardCount = rules.filter((r) => r.ruleType === 'hard').length;
  const softCount = rules.filter((r) => r.ruleType === 'soft').length;

  // ── 启停开关 ────────────────────────────────────
  /** 乐观翻转规则的 enabled；API 失败时回滚旧值并 toast 错误。 */
  const handleToggle = useCallback(
    async (rule: StrategyRule, nextEnabled: boolean) => {
      // 步骤 1：记住旧值并立即翻转本地 state
      const previous = rule.enabled;
      setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, enabled: nextEnabled } : r)));
      try {
        // 步骤 2：持久化到服务端，成功提示
        await updateStrategyRule(rule.id, { enabled: nextEnabled });
        toast.success(
          t('ui.rules.statusChanged', {
            name: rule.ruleName,
            status: t(nextEnabled ? 'ui.rules.enabled' : 'ui.rules.disabled'),
          }),
        );
      } catch (err) {
        // 步骤 3：失败回滚旧值并提示
        setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, enabled: previous } : r)));
        const message = err instanceof Error ? err.message : t('ui.rules.toggleFailed');
        logger.error('更新规则状态失败', err);
        toast.error(t('ui.rules.toggleFailed'), { description: message });
      }
    },
    [t],
  );

  // ── 新增规则 ────────────────────────────────────
  /** 打开新增弹窗：清空编辑目标并重置表单为默认值。 */
  const openCreateDialog = useCallback(() => {
    setEditingRule(null);
    setFormData({
      ruleKey: '',
      ruleName: '',
      ruleType: 'soft',
      threshold: '',
      unit: '',
      description: '',
      category: 'none',
      severity: 'warning',
    });
    setDialogOpen(true);
  }, []);

  // ── 编辑规则 ────────────────────────────────────
  /** 打开编辑弹窗：按传入规则预填表单（threshold/unit/description/category 缺省补空）。 */
  const openEditDialog = useCallback((rule: StrategyRule) => {
    setEditingRule(rule);
    setFormData({
      ruleKey: rule.ruleKey,
      ruleName: rule.ruleName,
      ruleType: rule.ruleType,
      threshold: rule.threshold ?? '',
      unit: rule.unit ?? '',
      description: rule.description ?? '',
      category: rule.category ?? 'none',
      severity: rule.severity,
    });
    setDialogOpen(true);
  }, []);

  /** 校验并提交新增/编辑弹窗；成功后关弹窗并重拉列表。threshold 有值时必须是有限数字。 */
  const handleSaveDialog = useCallback(async () => {
    // 步骤 1：必填项校验（ruleKey 与 ruleName）
    if (!formData.ruleKey.trim() || !formData.ruleName.trim()) {
      toast.error(t('ui.rules.fillRequired'));
      return;
    }

    // 步骤 2：阈值校验——有输入时必须是有限数字；空输入表示不设阈值
    const thresholdNum = formData.threshold.trim() !== '' ? Number(formData.threshold) : undefined;
    if (
      formData.threshold.trim() !== '' &&
      (Number.isNaN(thresholdNum) || !isFinite(thresholdNum))
    ) {
      toast.error(t('ui.rules.validThreshold'));
      return;
    }

    // 步骤 3：组装 payload（trim；unit/description/category 为空时省略）
    setSaving(true);
    try {
      const payload: CreateStrategyRuleDto & UpdateStrategyRuleDto = {
        ruleKey: formData.ruleKey.trim(),
        ruleName: formData.ruleName.trim(),
        ruleType: formData.ruleType,
        threshold: thresholdNum,
        unit: formData.unit.trim() || undefined,
        description: formData.description.trim() || undefined,
        category: formData.category === 'none' ? undefined : formData.category,
        severity: formData.severity,
      };

      // 步骤 4：按 editingRule 分派更新或新建
      if (editingRule) {
        await updateStrategyRule(editingRule.id, payload as unknown as Record<string, unknown>);
        toast.success(t('ui.rules.ruleUpdated'));
      } else {
        await createStrategyRule(payload as unknown as Record<string, unknown>);
        toast.success(t('ui.rules.ruleCreated'));
      }

      // 步骤 5：关弹窗、清编辑目标、重拉列表
      setDialogOpen(false);
      setEditingRule(null);
      await loadRules();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('rules.saveFailed');
      logger.error('保存规则失败', err);
      toast.error(t('rules.saveFailed'), { description: message });
    } finally {
      setSaving(false);
    }
  }, [formData, editingRule, loadRules, t]);

  // ── 删除规则 ────────────────────────────────────
  /** 确认删除 deleteTarget 持有的规则；成功后清目标并重拉列表。 */
  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const target = deleteTarget;
    try {
      await deleteStrategyRule(target.id);
      toast.success(t('ui.rules.ruleDeleted', { name: target.ruleName }));
      setDeleteTarget(null);
      await loadRules();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('rules.deleteFailed');
      logger.error('删除规则失败', err);
      toast.error(t('rules.deleteFailed'), { description: message });
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, loadRules, t]);

  // ── 恢复默认 ────────────────────────────────────
  /** 把全部规则重置为系统默认集，然后重拉列表。 */
  const handleReset = useCallback(async () => {
    setResetting(true);
    try {
      await resetStrategyRules();
      toast.success(t('ui.rules.rulesRestored'));
      setResetOpen(false);
      await loadRules();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('rules.restoreFailed');
      logger.error('恢复默认规则失败', err);
      toast.error(t('rules.restoreFailed'), { description: message });
    } finally {
      setResetting(false);
    }
  }, [loadRules, t]);

  // ── 拖拽排序 ────────────────────────────────────
  /** 记录被拖规则的 id 与所属分类（写入 ref 供 drop 事件读取），并设置拖拽数据。 */
  const handleDragStart = useCallback((e: React.DragEvent<HTMLDivElement>, rule: StrategyRule) => {
    dragIdRef.current = rule.id;
    dragCatRef.current = getCategoryKey(rule);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', rule.id);
  }, []);

  /** 悬停高亮目标行：preventDefault 才允许放置，dropEffect=move。 */
  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>, ruleId: string) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragOverId !== ruleId) {
        setDragOverId(ruleId);
      }
    },
    [dragOverId],
  );

  /** 离开行时清除高亮：relatedTarget 仍在行内（子元素间移动）则忽略。 */
  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const related = e.relatedTarget as Node | null;
    const current = e.currentTarget as Node;
    if (related && current.contains(related)) return;
    setDragOverId(null);
  }, []);

  /**
   * 分类内重排：跨分类 drop 直接拒绝。流程——读 ref 定位拖拽与目标规则 →
   * 组内乐观 splice 重排 → 重新编号 sort 0..n → 更新整体 rules →
   * 持久化 reorderStrategyRules，失败回滚旧 rules。
   */
  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>, targetRule: StrategyRule) => {
      e.preventDefault();
      // 步骤 1：读取并清空拖拽 ref，清除高亮
      const draggedId = dragIdRef.current;
      const dragCat = dragCatRef.current;
      const targetCat = getCategoryKey(targetRule);
      dragIdRef.current = null;
      dragCatRef.current = null;
      setDragOverId(null);

      // 步骤 2：合法性检查——同规则、跨分类直接返回
      if (!draggedId || draggedId === targetRule.id) return;
      if (dragCat !== targetCat) {
        toast.error(t('ui.rules.sameCategoryOnly'));
        return;
      }

      // 步骤 3：在组内定位拖拽与目标的索引
      const groupList = grouped[targetCat];
      const dragIdx = groupList.findIndex((r) => r.id === draggedId);
      const targetIdx = groupList.findIndex((r) => r.id === targetRule.id);
      if (dragIdx === -1 || targetIdx === -1) return;
      if (dragIdx === targetIdx) return;

      // 乐观更新：重排
      const newGroupList = [...groupList];
      const [removed] = newGroupList.splice(dragIdx, 1);
      newGroupList.splice(targetIdx, 0, removed);

      // 组内新顺序重新编号 sort（0..n）
      const reordered: Array<{ id: string; sort: number }> = newGroupList.map((r, i) => ({
        id: r.id,
        sort: i,
      }));

      // 更新整体 rules 状态
      const updatedRules = rules.map((r) => {
        const found = reordered.find((o) => o.id === r.id);
        return found ? { ...r, sort: found.sort } : r;
      });
      setRules(updatedRules);

      // 步骤 4：持久化新顺序；失败回滚旧 rules
      setReordering(true);
      try {
        await reorderStrategyRules(reordered);
        toast.success(t('ui.rules.orderSaved'));
      } catch (err) {
        // 失败回滚
        setRules(rules);
        const message = err instanceof Error ? err.message : t('rules.saveFailed');
        logger.error('保存排序失败', err);
        toast.error(t('rules.saveFailed'), { description: message });
      } finally {
        setReordering(false);
      }
    },
    [grouped, rules, t],
  );

  /** 拖拽结束后清空 ref 与高亮（drop 未触发的兜底清理）。 */
  const handleDragEnd = useCallback(() => {
    dragIdRef.current = null;
    dragCatRef.current = null;
    setDragOverId(null);
  }, []);

  // ── 阈值行内编辑 ────────────────────────────────────
  /** 进入某规则阈值的行内编辑态：预填当前阈值。 */
  const startThresholdEdit = useCallback((rule: StrategyRule) => {
    setEditingThresholdId(rule.id);
    setThresholdValue(rule.threshold ?? '');
  }, []);

  /** 取消行内编辑：清空编辑行与输入草稿。 */
  const cancelThresholdEdit = useCallback(() => {
    setEditingThresholdId(null);
    setThresholdValue('');
  }, []);

  /** 保存行内阈值：值未变则直接退出；乐观更新该行，失败回滚旧阈值。 */
  const saveThreshold = useCallback(
    async (rule: StrategyRule) => {
      // 步骤 1：值未变化——无需请求，直接退出编辑态
      if (thresholdValue === (rule.threshold ?? '')) {
        cancelThresholdEdit();
        return;
      }
      // 步骤 2：校验必须是有限数字
      const numValue = Number(thresholdValue);
      if (Number.isNaN(numValue) || !isFinite(numValue)) {
        toast.error(t('ui.rules.validNumber'));
        return;
      }
      // 步骤 3：乐观更新该行阈值
      const previous = rule.threshold;
      setRules((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, threshold: thresholdValue } : r)),
      );
      try {
        // 步骤 4：持久化，成功后退出编辑态
        await updateStrategyRule(rule.id, { threshold: numValue });
        toast.success(t('ui.rules.thresholdSaved', { name: rule.ruleName }));
        setEditingThresholdId(null);
        setThresholdValue('');
      } catch (err) {
        // 步骤 5：失败回滚旧阈值
        setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, threshold: previous } : r)));
        const message = err instanceof Error ? err.message : t('rules.saveFailed');
        logger.error('更新阈值失败', err);
        toast.error(t('rules.saveFailed'), { description: message });
      }
    },
    [thresholdValue, cancelThresholdEdit, t],
  );

  // ── 渲染区 ────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* 顶部操作栏：embedded 时右对齐且不渲染页头 */}
      <div
        className={`flex flex-col gap-4 sm:flex-row sm:items-start ${embedded ? 'sm:justify-end' : 'sm:justify-between'}`}
      >
        {/* 什么时候走到这里：独立路由页（非嵌入）——渲染标题与描述 */}
        {!embedded && (
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {t('rules.title')}
            </h1>
            <p className="text-sm text-muted-foreground">{t('ui.rules.pageDescription')}</p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setResetOpen(true)}
            className="border-warning/40 text-warning hover:bg-warning/10 hover:text-warning"
          >
            <RotateCcw size={16} />
            {t('ui.rules.resetDefaults')}
          </Button>
          <Button variant="default" onClick={openCreateDialog}>
            <Plus size={16} />
            {t('rules.addRule')}
          </Button>
        </div>
      </div>

      {/* 说明卡片：硬规则 / 软规则各一张 */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="border-destructive/20 bg-destructive/5">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-destructive/10 text-destructive">
                <Shield size={18} />
              </div>
              <CardTitle className="text-base text-foreground">{t('rules.hardRule')}</CardTitle>
              <Badge
                variant="outline"
                className="border-destructive/40 bg-destructive/10 text-destructive"
              >
                Hard
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-6 text-muted-foreground">
              {t('ui.rules.hardDescription')}
              <span className="font-medium text-destructive">{t('ui.rules.hardEmphasis')}</span>。
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {t('ui.rules.hardCount', { count: hardCount })}
            </p>
          </CardContent>
        </Card>

        <Card className="border-warning/20 bg-warning/5">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-warning/10 text-warning">
                <Lightbulb size={18} />
              </div>
              <CardTitle className="text-base text-foreground">{t('rules.softRule')}</CardTitle>
              <Badge variant="outline" className="border-warning/40 bg-warning/10 text-warning">
                Soft
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-6 text-muted-foreground">
              {t('ui.rules.softDescription')}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {t('ui.rules.softCount', { count: softCount })}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* 错误提示：什么时候走到这里——列表加载失败（附原始错误信息 + 重试路径为刷新/重进） */}
      {error && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
        >
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="font-medium">{t('rules.loadFailed')}</div>
            <div className="break-words">{error}</div>
          </div>
        </div>
      )}

      {/* 分组展示：加载中走骨架屏，否则按 CATEGORY_ORDER 逐组渲染 */}
      {loading ? (
        // 什么时候走到这里：首次加载中——两组骨架占位
        <div className="space-y-6">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-3">
              <Skeleton className="h-6 w-48" />
              <div className="space-y-2">
                {[0, 1].map((j) => (
                  <Skeleton key={j} className="h-20 w-full" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-6" data-ai-section-type="card-list">
          {CATEGORY_ORDER.map((cat) => {
            const groupRulesList = grouped[cat.key] ?? [];
            return (
              <div key={cat.key}>
                {/* 分组标题：名称 + 数量徽标 + 分隔线 */}
                <div className="mb-3 flex items-center gap-2">
                  <h2 className="text-base font-semibold text-foreground">{t(cat.labelKey)}</h2>
                  <Badge
                    variant="outline"
                    className="border-warning/30 bg-warning/10 px-2 py-0 text-[10px] text-warning"
                  >
                    {groupRulesList.length}
                  </Badge>
                  <div className="ml-2 h-px flex-1 bg-border/50" />
                </div>

                {/* 规则列表：空组给虚线占位，否则渲染 RuleCard 行 */}
                {groupRulesList.length === 0 ? (
                  // 什么时候走到这里：该分类暂无规则——虚线空占位
                  <div className="rounded-lg border border-dashed border-border p-4">
                    <p className="text-center text-xs text-muted-foreground">
                      {t('ui.rules.emptyCategory')}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {groupRulesList.map((rule) => (
                      <RuleCard
                        key={rule.id}
                        rule={rule}
                        editingThresholdId={editingThresholdId}
                        thresholdValue={thresholdValue}
                        setThresholdValue={setThresholdValue}
                        startThresholdEdit={startThresholdEdit}
                        cancelThresholdEdit={cancelThresholdEdit}
                        saveThreshold={saveThreshold}
                        onToggle={handleToggle}
                        onEdit={openEditDialog}
                        onDelete={(r) => setDeleteTarget(r)}
                        onDragStart={handleDragStart}
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                        onDragEnd={handleDragEnd}
                        isDragOver={dragOverId === rule.id}
                        isReordering={reordering}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 新增 / 编辑弹窗：active=false（分区未激活）时强制关闭 */}
      <Dialog open={active && dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90dvh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t(editingRule ? 'ui.rules.editTitle' : 'ui.rules.createTitle')}
            </DialogTitle>
            <DialogDescription>
              {editingRule ? t('ui.rules.editDescription') : t('ui.rules.createDescription')}
            </DialogDescription>
          </DialogHeader>

          {/* 表单：两列标识区 → 三列类型/阈值/单位 → 两列分类/严重级别 → 描述 */}
          <div className="grid gap-4 py-2">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="ruleKey">{t('ui.rules.ruleKey')}</Label>
                <Input
                  id="ruleKey"
                  value={formData.ruleKey}
                  onChange={(e) => setFormData({ ...formData, ruleKey: e.target.value })}
                  placeholder={t('ui.rules.ruleKeyPlaceholder')}
                  disabled={!!editingRule}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ruleName">{t('ui.rules.ruleName')}</Label>
                <Input
                  id="ruleName"
                  value={formData.ruleName}
                  onChange={(e) => setFormData({ ...formData, ruleName: e.target.value })}
                  placeholder={t('ui.rules.ruleNamePlaceholder')}
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="ruleType">{t('ui.rules.ruleType')}</Label>
                <Select
                  value={formData.ruleType}
                  onValueChange={(v) =>
                    setFormData({
                      ...formData,
                      ruleType: v as RuleType,
                    })
                  }
                >
                  <SelectTrigger id="ruleType" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hard">{t('rules.hardRule')}</SelectItem>
                    <SelectItem value="soft">{t('rules.softRule')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="threshold">{t('ui.rules.threshold')}</Label>
                <Input
                  id="threshold"
                  value={formData.threshold}
                  onChange={(e) => setFormData({ ...formData, threshold: e.target.value })}
                  placeholder={t('ui.rules.thresholdExample')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="unit">{t('rules.unit')}</Label>
                <Input
                  id="unit"
                  value={formData.unit}
                  onChange={(e) => setFormData({ ...formData, unit: e.target.value })}
                  placeholder={t('ui.rules.unitExample')}
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="category">{t('ui.rules.category')}</Label>
                <Select
                  value={formData.category}
                  onValueChange={(v) =>
                    setFormData({
                      ...formData,
                      category: v as RuleCategory | 'none',
                    })
                  }
                >
                  <SelectTrigger id="category" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* 分类下拉：排除 other（other 只是兜底桶，不允许手动选择）+ 未分类选项 */}
                    {CATEGORY_ORDER.filter((c) => c.key !== 'other').map((c) => (
                      <SelectItem key={c.key} value={c.key}>
                        {t(c.labelKey)}
                      </SelectItem>
                    ))}
                    <SelectItem value="none">{t('ui.rules.uncategorized')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="severity">{t('ui.rules.severity')}</Label>
                <Select
                  value={formData.severity}
                  onValueChange={(v) =>
                    setFormData({
                      ...formData,
                      severity: v as RuleSeverity,
                    })
                  }
                >
                  <SelectTrigger id="severity" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="warning">{t('rules.warning')}</SelectItem>
                    <SelectItem value="hard_block">{t('rules.hardBlock')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">{t('ui.rules.description')}</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder={t('ui.rules.descriptionPlaceholder')}
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void handleSaveDialog()} disabled={saving}>
              {saving
                ? t('common.saving')
                : editingRule
                  ? t('ui.rules.saveChanges')
                  : t('ui.rules.createRule')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认弹窗：active=false 强制关闭；deleting 进行中禁止再关（防误触丢确认） */}
      <AlertDialog
        open={active && deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-rose-500" />
              {t('ui.rules.deleteTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('ui.rules.deleteDescription', { name: deleteTarget?.ruleName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTarget(null)} disabled={deleting}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-700"
              onClick={() => void handleDelete()}
              disabled={deleting}
            >
              {deleting ? t('rules.deleting') : t('ui.rules.confirmDelete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 恢复默认确认弹窗：active=false 强制关闭 */}
      <AlertDialog open={active && resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <RotateCcw className="h-5 w-5 text-amber-500" />
              {t('ui.rules.resetTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('ui.rules.resetDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setResetOpen(false)} disabled={resetting}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-600 hover:bg-amber-700"
              onClick={() => void handleReset()}
              disabled={resetting}
            >
              {resetting ? t('rules.restoring') : t('rules.restoreConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── 规则卡片子组件 ────────────────────────────────
/** {@link RuleCard} 的入参：规则数据 + 阈值行内编辑受控值 + 父级注入的全部回调与拖拽状态。 */
interface RuleCardProps {
  rule: StrategyRule;
  editingThresholdId: string | null;
  thresholdValue: string;
  setThresholdValue: (v: string) => void;
  startThresholdEdit: (rule: StrategyRule) => void;
  cancelThresholdEdit: () => void;
  saveThreshold: (rule: StrategyRule) => Promise<void>;
  onToggle: (rule: StrategyRule, enabled: boolean) => Promise<void>;
  onEdit: (rule: StrategyRule) => void;
  onDelete: (rule: StrategyRule) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>, rule: StrategyRule) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>, ruleId: string) => void;
  onDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>, rule: StrategyRule) => Promise<void>;
  onDragEnd: () => void;
  isDragOver: boolean;
  isReordering: boolean;
}

/**
 * 单条可拖拽规则行。
 * 渲染名称/key/描述、阈值（点击进入行内编辑）、严重级别与规则类型徽标、
 * 启用开关、编辑/删除按钮与拖拽手柄；拖拽事件全部委托父级回调处理。
 */
function RuleCard({
  rule,
  editingThresholdId,
  thresholdValue,
  setThresholdValue,
  startThresholdEdit,
  cancelThresholdEdit,
  saveThreshold,
  onToggle,
  onEdit,
  onDelete,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  isDragOver,
  isReordering,
}: RuleCardProps) {
  const { t } = useTranslation();
  // 本行是否处于阈值编辑态；是否设有阈值（无阈值时阈值按钮禁用）
  const isEditing = editingThresholdId === rule.id;
  const hasThreshold = rule.threshold !== null && rule.threshold !== undefined;

  return (
    <Card
      draggable={!isReordering}
      onDragStart={(e) => onDragStart(e, rule)}
      onDragOver={(e) => onDragOver(e, rule.id)}
      onDragLeave={onDragLeave}
      onDrop={(e) => void onDrop(e, rule)}
      onDragEnd={onDragEnd}
      className={`
        transition-all duration-150
        ${isDragOver ? 'border-amber-500/60 ring-2 ring-amber-500/30' : ''}
        ${!rule.enabled ? 'opacity-60' : ''}
      `}
    >
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-4">
        {/* 顶部行：拖拽手柄 + 名称 */}
        <div className="flex items-center gap-3 min-w-0 flex-1 w-full sm:w-auto">
          {/* 拖拽手柄（仅视觉提示，draggable 在 Card 上） */}
          <div
            className="flex shrink-0 cursor-grab items-center justify-center text-muted-foreground/60 transition-colors hover:text-muted-foreground active:cursor-grabbing"
            title={t('ui.rules.dragSort')}
          >
            <GripVertical size={18} />
          </div>

          {/* 名称 + key + 可选描述 */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="min-w-0 break-words font-medium text-foreground">
                {rule.ruleName}
              </span>
              <span className="min-w-0 break-all font-mono text-[11px] text-muted-foreground">
                {rule.ruleKey}
              </span>
            </div>
            {rule.description && (
              <p className="mt-0.5 text-xs text-muted-foreground break-words">{rule.description}</p>
            )}
          </div>
        </div>

        {/* 底部行（桌面端在右侧）：阈值 + 徽章 + 开关 + 操作 */}
        <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto sm:justify-end">
          {/* 中部：阈值参数 */}
          <div className="flex items-center gap-2">
            {/* 什么时候走到这里：该行处于阈值行内编辑态——输入框（Enter 保存 / Escape 取消）+ 单位 + 确认/取消按钮 */}
            {isEditing ? (
              <div className="flex items-center gap-2">
                <Input
                  value={thresholdValue}
                  onChange={(e) => setThresholdValue(e.target.value)}
                  className="h-8 w-24 text-center font-mono"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      void saveThreshold(rule);
                    } else if (e.key === 'Escape') {
                      cancelThresholdEdit();
                    }
                  }}
                />
                {rule.unit && (
                  <span className="w-6 text-xs text-muted-foreground">{rule.unit}</span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-400"
                  onClick={() => void saveThreshold(rule)}
                  title={t('common.save')}
                >
                  <Check size={16} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  onClick={cancelThresholdEdit}
                  title={t('common.cancel')}
                >
                  <X size={16} />
                </Button>
              </div>
            ) : (
              // 什么时候走到这里：非编辑态——阈值展示按钮（有阈值才可点击进入编辑）
              <button
                type="button"
                onClick={() => hasThreshold && startThresholdEdit(rule)}
                disabled={!hasThreshold}
                className={`
                flex items-center gap-1.5 rounded-md border border-transparent
                px-2 py-1 text-sm transition-colors
                ${
                  hasThreshold
                    ? 'cursor-pointer hover:border-border hover:bg-accent/50'
                    : 'cursor-default'
                }
              `}
                title={hasThreshold ? t('ui.rules.editThreshold') : t('ui.rules.noThreshold')}
              >
                <span className="font-mono-nums font-medium text-foreground">
                  {hasThreshold ? formatThreshold(rule.threshold, rule.unit, t) : '—'}
                </span>
                {hasThreshold && (
                  <Pencil
                    size={12}
                    className="ml-0.5 text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100"
                  />
                )}
              </button>
            )}
          </div>

          {/* 右部：徽章 + 开关 + 操作按钮 */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* 严重级别徽章：hard_block 红底 / warning 琥珀描边 */}
            <Badge
              variant={rule.severity === 'hard_block' ? 'destructive' : 'outline'}
              className={
                rule.severity === 'hard_block'
                  ? 'bg-destructive text-destructive-foreground'
                  : 'border-warning/40 bg-warning/10 text-warning'
              }
            >
              {t(SEVERITY_LABEL_KEYS[rule.severity])}
            </Badge>

            {/* ruleType 徽章：hard 主色 / soft 灰 */}
            <Badge
              variant="outline"
              className={
                rule.ruleType === 'hard'
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border bg-muted text-muted-foreground'
              }
            >
              {t(RULE_TYPE_LABEL_KEYS[rule.ruleType])}
            </Badge>

            {/* 启停开关（乐观更新在父级 handleToggle） */}
            <Switch
              checked={rule.enabled}
              onCheckedChange={(checked) => {
                void onToggle(rule, checked);
              }}
            />

            {/* 编辑按钮：打开预填弹窗 */}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              onClick={() => onEdit(rule)}
              title={t('ui.rules.editRule')}
            >
              <Pencil size={16} />
            </Button>

            {/* 删除按钮：仅打开确认弹窗，真正删除在确认后 */}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-400"
              onClick={() => onDelete(rule)}
              title={t('ui.rules.deleteRule')}
            >
              <Trash2 size={16} />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default StrategyRulesPage;
