/**
 * BudgetPanel.tsx — 研究预算分区：用量仪表（日/月/调用次数/估算成本）、开关、限额编辑与最近调用表。
 *
 * 职责边界：
 *  - 展示 fetchLlmBudgetUsage 的用量与配置；开关直接沿用当前 settings 只翻转 enabled；
 *    限额编辑由 BudgetEditor 子组件持独立草稿完成；不触及其他分区数据。
 * 上下游：
 *  - 上游（路由入口/谁引用）：SettingsPage 的 budget 分区（锚点 id="research-budget"）。
 *  - 下游（调用哪些 hooks/api/组件）：useQuery(30s 轮询)/useMutation/useQueryClient；
 *    fetchLlmBudgetUsage、saveLlmBudget；council-state 的 budgetPercent/validateBudget；
 *    AgentBuilder/errorMessage；Card/Badge/Button/Input/Label/Progress/Switch；toast。
 * 关键约定：
 *  - 用量查询每 30 秒轮询一次（refetchInterval: 30_000）；保存成功后 invalidate 'llm-budget'。
 *  - 预算未启用时（settings.enabled=false）各仪表 limit 传 null，按"无上限"渲染、不显示进度条。
 *  - BudgetEditor 用 JSON.stringify(settings) 作 key：settings 变化时强制重建草稿，避免旧值残留。
 *  - estimatedCostUsd 为 null 表示成本未知（模型无单价配置），渲染"未知"文案。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Coins, Loader2, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import type { LlmBudgetSettings } from '@shared/council.interface';
import { fetchLlmBudgetUsage, saveLlmBudget } from '@/api/council';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { budgetPercent, validateBudget } from '@/utils/council-state';
import { errorMessage } from '@/pages/AgentBuilder/errorMessage';

export default function BudgetPanel() {
  // —— 状态声明区 ——
  const { t, i18n } = useTranslation();
  // 是否展开限额编辑器
  const [editing, setEditing] = useState(false);

  // —— 数据获取区 ——
  // 用量 + 配置：每 30 秒轮询，覆盖日/月 token、调用次数、估算成本与最近调用
  const query = useQuery({
    queryKey: ['llm-budget', 'usage'],
    queryFn: fetchLlmBudgetUsage,
    refetchInterval: 30_000,
  });
  const usage = query.data;
  const client = useQueryClient();
  // 预算总开关：只翻转 enabled，其余设置原样带上；成功后退出编辑并刷新用量
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => saveLlmBudget({ ...usage!.settings, enabled }),
    onSuccess: () => {
      setEditing(false);
      void client.invalidateQueries({ queryKey: ['llm-budget'] });
    },
    onError: (cause: Error) => toast.error(errorMessage(cause, t('council.saveFailed'))),
  });
  // 按 i18n 语言本地化数字格式
  const number = (value: number) => value.toLocaleString(i18n.language);

  // —— 渲染区 ——
  return (
    <Card id="research-budget" className="min-w-0 scroll-mt-6">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 font-serif text-xl">
              <Coins className="size-5 text-primary" />
              {t('council.budget.title')}
            </CardTitle>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              {t('council.budget.intro')}
            </p>
          </div>
          {/* 编辑按钮：仅在用量加载完成且预算已启用时可点；展开后变"关闭" */}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!usage || !usage.settings.enabled}
            onClick={() => setEditing(!editing)}
            aria-expanded={editing}
          >
            <Settings2 />
            {t(editing ? 'council.close' : 'council.budget.edit')}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* 预算启用开关及其状态说明 */}
        {usage && (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-muted/30 p-4">
            <div className="min-w-0">
              <Label htmlFor="budget-enabled" className="font-semibold">
                {t('council.budget.enabled')}
              </Label>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t(
                  usage.settings.enabled
                    ? 'council.budget.enabledHint'
                    : 'council.budget.disabledHint',
                )}
              </p>
            </div>
            <Switch
              id="budget-enabled"
              checked={usage.settings.enabled}
              disabled={toggle.isPending}
              onCheckedChange={(enabled: boolean) => toggle.mutate(enabled)}
              aria-label={t('council.budget.enabled')}
            />
          </div>
        )}
        {/* 什么时候走到这里：用量首次加载中 */}
        {query.isLoading && <p className="text-sm text-muted-foreground">{t('council.loading')}</p>}
        {/* 什么时候走到这里：用量查询失败——错误信息 + 重试按钮 */}
        {query.isError && (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
            {errorMessage(query.error, t('council.loadFailed'))}
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              {t('council.retry')}
            </Button>
          </div>
        )}
        {usage && (
          <>
            {/* 四格统计：日 token / 月 token / 日调用次数 / 估算成本 */}
            <div
              className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4"
              data-ai-section-type="card-stat"
            >
              <BudgetMeter
                label={t('council.budget.today')}
                used={usage.dayTokens}
                limit={usage.settings.enabled ? usage.settings.dailyTokenLimit : null}
                number={number}
              />
              <BudgetMeter
                label={t('council.budget.month')}
                used={usage.monthTokens}
                limit={usage.settings.enabled ? usage.settings.monthlyTokenLimit : null}
                number={number}
              />
              <BudgetMeter
                label={t('council.budget.calls')}
                used={usage.dayCalls}
                limit={usage.settings.enabled ? usage.settings.dailyCallLimit : null}
                number={number}
              />
              {/* 估算成本：无单价配置时显示"未知" */}
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">{t('council.budget.estimatedCost')}</p>
                <p className="font-mono text-xl font-semibold">
                  {usage.estimatedCostUsd === null
                    ? t('council.budget.unknown')
                    : `$${usage.estimatedCostUsd.toFixed(4)}`}
                </p>
                <p className="text-xs text-muted-foreground">{t('council.budget.estimateHint')}</p>
              </div>
            </div>
            {/* 预留 token 徽标 + 统计口径（UTC）说明 */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-xs text-muted-foreground">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">
                  {t('council.budget.reserved', { count: usage.reservedTokens })}
                </Badge>
                <span className="self-center">{t('council.budget.utc')}</span>
              </div>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              {t('council.budget.accountingHint')}
            </p>
            {/* 什么时候走到这里：编辑模式且预算已启用——渲染限额编辑器；
                key 取 settings 快照，设置变化时重建编辑器避免残留旧草稿 */}
            {editing && usage.settings.enabled && (
              <BudgetEditor
                key={JSON.stringify(usage.settings)}
                settings={usage.settings}
                onSaved={() => setEditing(false)}
              />
            )}
            {/* 什么时候走到这里：存在最近调用记录——折叠展示最近 10 条明细表 */}
            {usage.recent.length > 0 && (
              <details className="rounded-lg border border-border p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  {t('council.budget.recent')}
                </summary>
                <div className="mt-3 max-w-full overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="p-2">{t('council.budget.purpose')}</th>
                        <th className="p-2">{t('council.model')}</th>
                        <th className="p-2">{t('council.budget.tokens')}</th>
                        <th className="p-2">{t('council.state')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.recent.slice(0, 10).map((call) => (
                        <tr key={call.id} className="border-t border-border">
                          {/* purpose 为动态键：查不到译文时回退原值；nsSeparator 关闭避免把键里的点当命名空间 */}
                          <td className="max-w-48 break-words p-2">
                            {t(`council.budget.purposes.${call.purpose}`, {
                              defaultValue: call.purpose,
                              nsSeparator: false,
                            })}
                          </td>
                          <td className="max-w-40 break-words p-2 font-mono">{call.model}</td>
                          <td className="whitespace-nowrap p-2">{number(call.chargedTokens)}</td>
                          <td className="p-2">
                            {t(`council.budget.status.${call.status}`, {
                              defaultValue: call.status,
                            })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** 单个用量仪表：已用/限额数字；有限额时附进度条（budgetPercent 计算占比）。 */
function BudgetMeter({
  label,
  used,
  limit,
  number,
}: {
  label: string;
  used: number;
  limit: number | null;
  number: (value: number) => string;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-mono text-xl font-semibold">
        {number(used)}
        <span className="ml-1 text-xs font-normal text-muted-foreground">
          / {limit === null ? t('council.budget.unlimited') : number(limit)}
        </span>
      </p>
      {/* 什么时候走到这里：该维度设置了限额——渲染用量进度条；limit=null 表示无上限 */}
      {limit !== null && <Progress value={budgetPercent(used, limit)} aria-label={label} />}
    </div>
  );
}

/** 限额类数字字段（token/次数上限），均须为 >=1 的整数 */
const CAP_FIELDS = [
  'dailyTokenLimit',
  'monthlyTokenLimit',
  'perTaskTokenLimit',
  'maxInputTokens',
  'maxOutputTokens',
  'maxCallsPerTask',
  'dailyCallLimit',
] as const;
/** 单价字段（每百万 token 美元），可选，留空即 null */
const PRICE_FIELDS: Array<'inputUsdPerMillion' | 'outputUsdPerMillion'> = [
  'inputUsdPerMillion',
  'outputUsdPerMillion',
];

/** 限额编辑器：独立草稿状态；提交前 validateBudget 校验，非法则显示错误键不提交。 */
function BudgetEditor({ settings, onSaved }: { settings: LlmBudgetSettings; onSaved: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [draft, setDraft] = useState<LlmBudgetSettings>(settings);
  // validateBudget 返回的错误键（如 tokenCapBelowUsage）；null 表示校验通过
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: saveLlmBudget,
    retry: false,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['llm-budget'] });
      toast.success(t('council.budget.saved'));
      onSaved();
    },
    onError: (cause: Error) => toast.error(errorMessage(cause, t('council.saveFailed'))),
  });
  return (
    <form
      className="space-y-4 rounded-xl bg-muted/40 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        // 先整体校验草稿，非法时仅提示、不发起保存
        const invalid = validateBudget(draft);
        setError(invalid);
        if (!invalid) save.mutate(draft);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* 限额字段：必填正整数，空值按 0 提交由校验兜底 */}
        {CAP_FIELDS.map((field) => (
          <div key={field} className="space-y-2">
            <Label htmlFor={`budget-${field}`}>{t(`council.budget.fields.${field}`)}</Label>
            <Input
              id={`budget-${field}`}
              type="number"
              min={1}
              step={1}
              required
              value={draft[field] ?? ''}
              onChange={(event) => setDraft({ ...draft, [field]: Number(event.target.value) })}
            />
          </div>
        ))}
        {/* 单价字段：可留空（null = 按模型默认价计） */}
        {PRICE_FIELDS.map((field) => (
          <div key={field} className="space-y-2">
            <Label htmlFor={`budget-${field}`}>{t(`council.budget.fields.${field}`)}</Label>
            <Input
              id={`budget-${field}`}
              type="number"
              min={0}
              max={100000}
              step="any"
              placeholder={t('council.budget.optionalPrice')}
              value={draft[field] ?? ''}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  [field]: event.target.value.trim() === '' ? null : Number(event.target.value),
                })
              }
            />
          </div>
        ))}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{t('council.budget.limitHint')}</p>
      {/* 什么时候走到这里：提交被校验拦下——展示 validateBudget 给出的错误键译文 */}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t(`council.budget.${error}`)}
        </p>
      )}
      <Button type="submit" disabled={save.isPending}>
        {save.isPending && <Loader2 className="animate-spin" />}
        {t('council.budget.save')}
      </Button>
    </form>
  );
}
