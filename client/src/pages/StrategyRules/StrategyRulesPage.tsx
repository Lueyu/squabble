/**
 * @file pages/StrategyRules/StrategyRulesPage.tsx
 * @description Route `/settings/rules`: manage multi-agent strategy rules.
 *
 * Rules are grouped by category (position concentration, stop-loss/take-profit,
 * buy conditions, cash management, risk gates). Each rule has a `hard`/`soft`
 * type and a `warning`/`hard_block` severity. The page supports:
 *  - create / edit / delete via dialogs
 *  - per-rule enable toggle (optimistic update with rollback)
 *  - inline threshold editing
 *  - drag-and-drop reordering within a category (optimistic, rolled back on error)
 *  - resetting to the system-default rule set
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
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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

// ── Category definitions ─────────────────────────────────
/** Ordered list of rule categories for grouping and rendering. */
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

const SEVERITY_LABEL_KEYS: Record<RuleSeverity, string> = {
  hard_block: 'rules.hardBlock', warning: 'rules.warning',
};

const RULE_TYPE_LABEL_KEYS: Record<RuleType, string> = {
  hard: 'rules.hardRule', soft: 'rules.softRule',
};

// ── Helpers ──────────────────────────────────────────────
/**
 * Resolve a rule's category bucket, defaulting unknown values to `other`.
 */
function getCategoryKey(rule: StrategyRule): RuleCategory | 'other' {
  if (!rule.category) return 'other';
  const defined = CATEGORY_ORDER.slice(0, -1).some(
    (c) => c.key === rule.category,
  );
  return defined ? rule.category : 'other';
}

/**
 * Bucket rules into the fixed category order, sorted by each rule's `sort`.
 */
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

/**
 * Pretty-print a threshold value with its unit.
 * Recognizes `pct/%`, `days`, `usd`; other units are appended verbatim.
 */
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

// ── Main page component ────────────────────────────────────
/**
 * Strategy rules management page.
 *
 * State groups: list loading, create/edit dialog, delete confirmation, reset
 * confirmation, drag-and-drop, and inline threshold editing. Mutations use
 * optimistic updates where cheap (toggle, reorder, threshold) and roll back on
 * failure; create/delete/reset refetch the whole list.
 */
function StrategyRulesPage({ embedded = false, active = true }: { embedded?: boolean; active?: boolean } = {}) {
  const { t } = useTranslation();
  const [rules, setRules] = useState<StrategyRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 新增 / 编辑弹窗
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

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<StrategyRule | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 恢复默认确认
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  // 拖拽状态
  const dragIdRef = useRef<string | null>(null);
  const dragCatRef = useRef<RuleCategory | 'other' | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);

  // 阈值行内编辑
  const [editingThresholdId, setEditingThresholdId] = useState<string | null>(
    null,
  );
  const [thresholdValue, setThresholdValue] = useState('');

  // ── Data loading ────────────────────────────────────────────
  /** Fetch all strategy rules and populate state. */
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

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const grouped = useMemo(() => groupRules(rules), [rules]);

  const hardCount = rules.filter((r) => r.ruleType === 'hard').length;
  const softCount = rules.filter((r) => r.ruleType === 'soft').length;

  // ── Enable/disable toggle ────────────────────────────────────
  /**
   * Optimistically flip a rule's `enabled` flag; reverts on API failure.
   */
  const handleToggle = useCallback(
    async (rule: StrategyRule, nextEnabled: boolean) => {
      const previous = rule.enabled;
      setRules((prev) =>
        prev.map((r) =>
          r.id === rule.id ? { ...r, enabled: nextEnabled } : r,
        ),
      );
      try {
        await updateStrategyRule(rule.id, { enabled: nextEnabled });
        toast.success(t('ui.rules.statusChanged', {
          name: rule.ruleName,
          status: t(nextEnabled ? 'ui.rules.enabled' : 'ui.rules.disabled'),
        }));
      } catch (err) {
        setRules((prev) =>
          prev.map((r) =>
            r.id === rule.id ? { ...r, enabled: previous } : r,
          ),
        );
        const message = err instanceof Error ? err.message : t('ui.rules.toggleFailed');
        logger.error('更新规则状态失败', err);
        toast.error(t('ui.rules.toggleFailed'), { description: message });
      }
    },
    [t],
  );

  // ── Create rule ────────────────────────────────────────────
  /** Open the create dialog with a blank form. */
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

  // ── Edit rule ────────────────────────────────────────────
  /** Open the edit dialog, pre-filling the form from the given rule. */
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

  /**
   * Validate and submit the create/edit dialog. Re-runs the list on success.
   * Threshold must be a finite number when provided.
   */
  const handleSaveDialog = useCallback(async () => {
    if (!formData.ruleKey.trim() || !formData.ruleName.trim()) {
      toast.error(t('ui.rules.fillRequired'));
      return;
    }

    const thresholdNum =
      formData.threshold.trim() !== ''
        ? Number(formData.threshold)
        : undefined;
    if (
      formData.threshold.trim() !== '' &&
      (Number.isNaN(thresholdNum) || !isFinite(thresholdNum))
    ) {
      toast.error(t('ui.rules.validThreshold'));
      return;
    }

    setSaving(true);
    try {
      const payload: CreateStrategyRuleDto & UpdateStrategyRuleDto = {
        ruleKey: formData.ruleKey.trim(),
        ruleName: formData.ruleName.trim(),
        ruleType: formData.ruleType,
        threshold: thresholdNum,
        unit: formData.unit.trim() || undefined,
        description: formData.description.trim() || undefined,
        category:
          formData.category === 'none' ? undefined : formData.category,
        severity: formData.severity,
      };

      if (editingRule) {
        await updateStrategyRule(editingRule.id, payload as unknown as Record<string, unknown>);
        toast.success(t('ui.rules.ruleUpdated'));
      } else {
        await createStrategyRule(payload as unknown as Record<string, unknown>);
        toast.success(t('ui.rules.ruleCreated'));
      }

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

  // ── Delete rule ────────────────────────────────────────────
  /** Confirm-and-delete the rule held in `deleteTarget`. */
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

  // ── Reset to defaults ────────────────────────────────────
  /** Reset all rules to the system default set, then refetch. */
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

  // ── Drag-and-drop reordering ────────────────────────────────────
  /** Track the dragged rule id + its category bucket. */
  const handleDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>, rule: StrategyRule) => {
      dragIdRef.current = rule.id;
      dragCatRef.current = getCategoryKey(rule);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', rule.id);
    },
    [],
  );

  /** Highlight the drop target row. */
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

  /** Clear the drop highlight when leaving the row (ignoring child enter/leave). */
  const handleDragLeave = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const related = e.relatedTarget as Node | null;
      const current = e.currentTarget as Node;
      if (related && current.contains(related)) return;
      setDragOverId(null);
    },
    [],
  );

  /**
   * Reorder within a single category. Cross-category drops are rejected.
   * Applies an optimistic splice, persists the new `sort` to the backend, and
   * rolls the UI back if the API call fails.
   */
  const handleDrop = useCallback(
    async (
      e: React.DragEvent<HTMLDivElement>,
      targetRule: StrategyRule,
    ) => {
      e.preventDefault();
      const draggedId = dragIdRef.current;
      const dragCat = dragCatRef.current;
      const targetCat = getCategoryKey(targetRule);
      dragIdRef.current = null;
      dragCatRef.current = null;
      setDragOverId(null);

      if (!draggedId || draggedId === targetRule.id) return;
      if (dragCat !== targetCat) {
        toast.error(t('ui.rules.sameCategoryOnly'));
        return;
      }

      const groupList = grouped[targetCat];
      const dragIdx = groupList.findIndex((r) => r.id === draggedId);
      const targetIdx = groupList.findIndex((r) => r.id === targetRule.id);
      if (dragIdx === -1 || targetIdx === -1) return;
      if (dragIdx === targetIdx) return;

      // 乐观更新：重排
      const newGroupList = [...groupList];
      const [removed] = newGroupList.splice(dragIdx, 1);
      newGroupList.splice(targetIdx, 0, removed);

      const reordered: Array<{ id: string; sort: number }> = newGroupList.map(
        (r, i) => ({ id: r.id, sort: i }),
      );

      // 更新整体 rules 状态
      const updatedRules = rules.map((r) => {
        const found = reordered.find((o) => o.id === r.id);
        return found ? { ...r, sort: found.sort } : r;
      });
      setRules(updatedRules);

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

  /** Clear drag refs after the drag ends. */
  const handleDragEnd = useCallback(() => {
    dragIdRef.current = null;
    dragCatRef.current = null;
    setDragOverId(null);
  }, []);

  // ── Inline threshold editing ────────────────────────────────────
  /** Enter inline edit mode for a rule's threshold. */
  const startThresholdEdit = useCallback((rule: StrategyRule) => {
    setEditingThresholdId(rule.id);
    setThresholdValue(rule.threshold ?? '');
  }, []);

  /** Exit inline edit mode without saving. */
  const cancelThresholdEdit = useCallback(() => {
    setEditingThresholdId(null);
    setThresholdValue('');
  }, []);

  /**
   * Persist an inline threshold edit. No-ops when the value is unchanged.
   * Optimistically updates the row and rolls back on API failure.
   */
  const saveThreshold = useCallback(
    async (rule: StrategyRule) => {
      if (thresholdValue === (rule.threshold ?? '')) {
        cancelThresholdEdit();
        return;
      }
      const numValue = Number(thresholdValue);
      if (Number.isNaN(numValue) || !isFinite(numValue)) {
        toast.error(t('ui.rules.validNumber'));
        return;
      }
      const previous = rule.threshold;
      setRules((prev) =>
        prev.map((r) =>
          r.id === rule.id ? { ...r, threshold: thresholdValue } : r,
        ),
      );
      try {
        await updateStrategyRule(rule.id, { threshold: numValue });
        toast.success(t('ui.rules.thresholdSaved', { name: rule.ruleName }));
        setEditingThresholdId(null);
        setThresholdValue('');
      } catch (err) {
        setRules((prev) =>
          prev.map((r) =>
            r.id === rule.id ? { ...r, threshold: previous } : r,
          ),
        );
        const message = err instanceof Error ? err.message : t('rules.saveFailed');
        logger.error('更新阈值失败', err);
        toast.error(t('rules.saveFailed'), { description: message });
      }
    },
    [thresholdValue, cancelThresholdEdit, t],
  );

  // ── 渲染 ────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* 顶部操作栏 */}
      <div className={`flex flex-col gap-4 sm:flex-row sm:items-start ${embedded ? 'sm:justify-end' : 'sm:justify-between'}`}>
        {!embedded && <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {t('rules.title')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('ui.rules.pageDescription')}
          </p>
        </div>}
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

      {/* 说明卡片 */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="border-destructive/20 bg-destructive/5">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-destructive/10 text-destructive">
                <Shield size={18} />
              </div>
              <CardTitle className="text-base text-foreground">
                {t('rules.hardRule')}
              </CardTitle>
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
              <span className="font-medium text-destructive">
                {t('ui.rules.hardEmphasis')}
              </span>
              。
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
              <CardTitle className="text-base text-foreground">
                {t('rules.softRule')}
              </CardTitle>
              <Badge
                variant="outline"
                className="border-warning/40 bg-warning/10 text-warning"
              >
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

      {/* 错误提示 */}
      {error && (
        <div role="alert" className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="font-medium">{t('rules.loadFailed')}</div>
            <div className="break-words">{error}</div>
          </div>
        </div>
      )}

      {/* 分组展示 */}
      {loading ? (
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
                {/* 分组标题 */}
                <div className="mb-3 flex items-center gap-2">
                  <h2 className="text-base font-semibold text-foreground">
                    {t(cat.labelKey)}
                  </h2>
                  <Badge
                    variant="outline"
                    className="border-warning/30 bg-warning/10 px-2 py-0 text-[10px] text-warning"
                  >
                    {groupRulesList.length}
                  </Badge>
                  <div className="ml-2 h-px flex-1 bg-border/50" />
                </div>

                {/* 规则列表 */}
                {groupRulesList.length === 0 ? (
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

      {/* 新增 / 编辑弹窗 */}
      <Dialog open={active && dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90dvh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t(editingRule ? 'ui.rules.editTitle' : 'ui.rules.createTitle')}
            </DialogTitle>
            <DialogDescription>
              {editingRule
                ? t('ui.rules.editDescription')
                : t('ui.rules.createDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-2">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="ruleKey">{t('ui.rules.ruleKey')}</Label>
                <Input
                  id="ruleKey"
                  value={formData.ruleKey}
                  onChange={(e) =>
                    setFormData({ ...formData, ruleKey: e.target.value })
                  }
                  placeholder={t('ui.rules.ruleKeyPlaceholder')}
                  disabled={!!editingRule}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ruleName">{t('ui.rules.ruleName')}</Label>
                <Input
                  id="ruleName"
                  value={formData.ruleName}
                  onChange={(e) =>
                    setFormData({ ...formData, ruleName: e.target.value })
                  }
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
                  onChange={(e) =>
                    setFormData({ ...formData, threshold: e.target.value })
                  }
                  placeholder={t('ui.rules.thresholdExample')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="unit">{t('rules.unit')}</Label>
                <Input
                  id="unit"
                  value={formData.unit}
                  onChange={(e) =>
                    setFormData({ ...formData, unit: e.target.value })
                  }
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
                    {CATEGORY_ORDER.filter((c) => c.key !== 'other').map(
                      (c) => (
                        <SelectItem key={c.key} value={c.key}>
                          {t(c.labelKey)}
                        </SelectItem>
                      ),
                    )}
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
                onChange={(e) =>
                  setFormData({ ...formData, description: e.target.value })
                }
                placeholder={t('ui.rules.descriptionPlaceholder')}
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={saving}
            >
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void handleSaveDialog()} disabled={saving}>
              {saving ? t('common.saving') : editingRule ? t('ui.rules.saveChanges') : t('ui.rules.createRule')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认弹窗 */}
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
            <AlertDialogCancel
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
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

      {/* 恢复默认确认弹窗 */}
      <AlertDialog open={active && resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <RotateCcw className="h-5 w-5 text-amber-500" />
              {t('ui.rules.resetTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('ui.rules.resetDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setResetOpen(false)}
              disabled={resetting}
            >
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

// ── Rule card sub-component ────────────────────────────────
/** Props for {@link RuleCard}. */
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
  onDragStart: (
    e: React.DragEvent<HTMLDivElement>,
    rule: StrategyRule,
  ) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>, ruleId: string) => void;
  onDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (
    e: React.DragEvent<HTMLDivElement>,
    rule: StrategyRule,
  ) => Promise<void>;
  onDragEnd: () => void;
  isDragOver: boolean;
  isReordering: boolean;
}

/**
 * A single draggable rule row.
 * Renders the name/key/description, threshold (click-to-edit), severity and
 * rule-type badges, enable switch, edit/delete actions, and the drag handle.
 * Drag wiring is delegated to the parent via callbacks.
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
          {/* 拖拽手柄 */}
          <div
            className="flex shrink-0 cursor-grab items-center justify-center text-muted-foreground/60 transition-colors hover:text-muted-foreground active:cursor-grabbing"
            title={t('ui.rules.dragSort')}
          >
            <GripVertical size={18} />
          </div>

          {/* 名称 + 说明 */}
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
              <p className="mt-0.5 text-xs text-muted-foreground break-words">
                {rule.description}
              </p>
            )}
          </div>
        </div>

        {/* 底部行（桌面端在右侧）：阈值 + 徽章 + 开关 + 操作 */}
        <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto sm:justify-end">
          {/* 中部：阈值参数 */}
          <div className="flex items-center gap-2">
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
                <span className="w-6 text-xs text-muted-foreground">
                  {rule.unit}
                </span>
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
          {/* 严重级别徽章 */}
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

          {/* ruleType 徽章 */}
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

          {/* 启停开关 */}
          <Switch
            checked={rule.enabled}
            onCheckedChange={(checked) => {
              void onToggle(rule, checked);
            }}
          />

          {/* 编辑按钮 */}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={() => onEdit(rule)}
            title={t('ui.rules.editRule')}
          >
            <Pencil size={16} />
          </Button>

          {/* 删除按钮 */}
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
