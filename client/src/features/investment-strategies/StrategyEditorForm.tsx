import type { Dispatch, SetStateAction } from 'react';
import type { AiInvestmentView } from '@shared/investment-policy.interface';
import type {
  StrategyDraftInput,
  StrategyEntry,
} from '@shared/user-investment-strategy.interface';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { editStrategyEntry } from '@/utils/user-strategy-editor';
import {
  businessTime,
  resolveZonedInput,
  strategyPeriodDates,
  zonedInput,
} from '@/utils/strategy-dates';
import {
  draftLimits,
  simulationLimits,
  strategyRiskLabels,
} from './strategy-editor-limits';

interface StrategyEditorFormProps {
  content: StrategyDraftInput;
  setContent: Dispatch<SetStateAction<StrategyDraftInput>>;
  investment?: AiInvestmentView;
  busy: boolean;
  zh: boolean;
  setError: (message: string) => void;
}

/** Edit investor intent only; saving and execution authorization belong to the editor workflow. */
export default function StrategyEditorForm({
  content,
  setContent,
  investment,
  busy,
  zh,
  setError,
}: StrategyEditorFormProps) {
  const changeEntry = (
    id: string,
    change: (entry: StrategyEntry) => StrategyEntry,
  ) =>
    setContent((c) => ({
      ...c,
      entries: c.entries.map((e) => (e.id === id ? change(e) : e)),
    }));
  const riskLabels = strategyRiskLabels(zh);
  return (
    <div className="space-y-4">
      <label className="block space-y-2 text-sm">
        <span>{zh ? '策略名称' : 'Strategy name'}</span>
        <Input
          value={content.title}
          maxLength={120}
          disabled={!!busy}
          onChange={(e) => setContent((c) => ({ ...c, title: e.target.value }))}
        />
      </label>
      <label className="block space-y-2 text-sm">
        <span>{zh ? '总体想法（可选）' : 'Overall intent (optional)'}</span>
        <Textarea
          className="min-h-20"
          maxLength={4000}
          disabled={!!busy}
          placeholder={
            zh
              ? '例如：本月控制总仓位，优先检查已有持仓。'
              : 'For example: control total exposure this month and review existing positions first.'
          }
          value={content.body}
          onChange={(e) => setContent((c) => ({ ...c, body: e.target.value }))}
        />
      </label>
      <div className="space-y-3">
        {content.entries.map((entry, index) => (
          <article
            key={entry.id}
            className="space-y-3 rounded-2xl border bg-muted/20 p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">
                {zh ? `想法 ${index + 1}` : `Idea ${index + 1}`}
              </h3>
              <Button
                variant="ghost"
                size="sm"
                disabled={!!busy}
                onClick={() =>
                  setContent((c) => ({
                    ...c,
                    entries: c.entries.filter((e) => e.id !== entry.id),
                  }))
                }
              >
                {zh ? '移除' : 'Remove'}
              </Button>
            </div>
            <Textarea
              className="min-h-24"
              aria-label={
                zh ? `策略条目 ${index + 1}` : `Strategy entry ${index + 1}`
              }
              maxLength={12000}
              disabled={!!busy}
              value={entry.text}
              placeholder={
                zh
                  ? '写清股票、什么情况下行动，以及股数或仓位；只想观察也可以。'
                  : 'Describe the security, condition and shares or position size. Observation-only ideas are welcome.'
              }
              onChange={(e) =>
                changeEntry(entry.id, (v) =>
                  editStrategyEntry(v, e.target.value),
                )
              }
            />
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <label className="flex flex-wrap items-center gap-2">
                <span>{zh ? '这条有效至' : 'This entry ends'}</span>
                <Input
                  className="h-8 w-40"
                  type="date"
                  disabled={!!busy}
                  value={
                    entry.endsAt
                      ? zonedInput(
                          entry.endsAt,
                          entry.timezone ?? content.timezone,
                        ).slice(0, 10)
                      : ''
                  }
                  onChange={(e) => {
                    const date = e.target.value;
                    const end = date
                      ? resolveZonedInput(
                          `${date}T23:59`,
                          entry.timezone ?? content.timezone,
                        )
                      : null;
                    if (end?.error) {
                      setError(
                        zh
                          ? '该日期无法在当前时区确定。'
                          : 'The date cannot be resolved in this timezone.',
                      );
                      return;
                    }
                    changeEntry(entry.id, (v) => ({
                      ...v,
                      endsAt: end?.iso
                        ? new Date(Date.parse(end.iso) + 59999).toISOString()
                        : undefined,
                    }));
                  }}
                />
                <span>
                  {entry.timezone ?? content.timezone} ·{' '}
                  {zh
                    ? '留空沿用总策略期限'
                    : 'Blank uses the total strategy period'}
                </span>
              </label>
              {!!entry.sourceKeys.length && (
                <span>
                  {entry.sourceKeys.length}{' '}
                  {zh ? '处固定来源' : 'pinned sources'}
                </span>
              )}
            </div>
            <p className="text-xs leading-6 text-muted-foreground [overflow-wrap:anywhere]">
              {zh ? '生效期间：' : 'Effective period: '}
              {businessTime(
                entry.startsAt ?? content.startsAt,
                entry.timezone ?? content.timezone,
              )}{' '}
              —{' '}
              {businessTime(
                entry.endsAt ?? content.endsAt,
                entry.timezone ?? content.timezone,
              )}{' '}
              ·{' '}
              {zh
                ? '到期仅停止新动作，不自动清仓。'
                : 'Expiry stops new actions; it does not automatically sell.'}
            </p>
            {entry.directive?.trigger.kind === 'semantic' && (
              <label className="flex items-start gap-2 text-sm leading-6">
                <input
                  type="checkbox"
                  disabled={!!busy}
                  checked={entry.directive.semanticAuthorized === true}
                  onChange={(e) =>
                    changeEntry(entry.id, (v) => ({
                      ...v,
                      directive: v.directive
                        ? {
                            ...v.directive,
                            semanticAuthorized: e.target.checked,
                          }
                        : undefined,
                    }))
                  }
                />
                <span>
                  {zh
                    ? '我允许 AI 在这条已明确金额和范围的条件内补充判断。'
                    : 'Allow AI to assess this qualitative condition within its explicit amount and scope.'}
                </span>
              </label>
            )}
          </article>
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={!!busy || content.entries.length >= 20}
        onClick={() =>
          setContent((c) => ({
            ...c,
            entries: [
              ...c.entries,
              { id: 'manual_' + crypto.randomUUID(), text: '', sourceKeys: [] },
            ],
          }))
        }
      >
        {zh ? '再写一条' : 'Add another idea'}
      </Button>
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-primary/5 p-3 text-sm">
        <span>
          {zh ? '总策略期限' : 'Total strategy period'} · {content.timezone}
        </span>
        {(['day', 'month', 'custom'] as const).map((p) => (
          <Button
            type="button"
            key={p}
            size="sm"
            variant="ghost"
            disabled={!!busy}
            onClick={() =>
              setContent((c) => ({
                ...c,
                ...strategyPeriodDates(p, c.timezone),
              }))
            }
          >
            {p === 'day'
              ? zh
                ? '今日'
                : 'Today'
              : p === 'month'
                ? zh
                  ? '本月'
                  : 'This month'
                : zh
                  ? '未来一周'
                  : 'Next week'}
          </Button>
        ))}
        <Input
          className="h-8 w-40"
          aria-label={zh ? '总策略到期日期' : 'Total strategy end date'}
          type="date"
          disabled={!!busy}
          value={zonedInput(content.endsAt, content.timezone).slice(0, 10)}
          onChange={(e) => {
            const end = resolveZonedInput(
              `${e.target.value}T23:59`,
              content.timezone,
            );
            if (end.iso)
              setContent((c) => ({
                ...c,
                endsAt: new Date(Date.parse(end.iso) + 59999).toISOString(),
              }));
          }}
        />
      </div>
      <details className="rounded-xl border p-3">
        <summary className="cursor-pointer text-sm font-medium">
          {zh ? '仓位和资金边界' : 'Position and cash limits'}
        </summary>
        {content.limits ? (
          <>
            <p className="mt-3 text-xs leading-6 text-muted-foreground">
              {zh
                ? '请核对这些草稿边界；保存不会授权交易，仍需核对执行说明并确认应用。'
                : 'Review these draft limits. Saving does not authorize trading; review the execution details and apply explicitly.'}
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {(
                Object.keys(content.limits) as Array<
                  keyof NonNullable<StrategyDraftInput['limits']>
                >
              ).map((key) => (
                <label key={key} className="space-y-1 text-sm">
                  <span>{riskLabels[key]} (%)</span>
                  <Input
                    type="number"
                    min="0"
                    max={key === 'maxDailyTurnoverPct' ? 200 : 100}
                    disabled={!!busy}
                    value={content.limits?.[key] ?? ''}
                    onChange={(e) =>
                      setContent((c) => ({
                        ...c,
                        limits: c.limits
                          ? { ...c.limits, [key]: Number(e.target.value) }
                          : undefined,
                      }))
                    }
                  />
                </label>
              ))}
            </div>
          </>
        ) : (
          <div className="mt-3 space-y-3">
            <p className="text-sm text-muted-foreground">
              {zh
                ? '保存想法不需要资金边界。执行前请设置并核对，也可以使用模拟盘当前边界作为草稿。'
                : 'You can save ideas without funding limits. Set and review them before execution, or use the current simulation limits as a draft.'}
            </p>
            <div className="flex flex-wrap gap-2">
              {investment?.account && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() =>
                    setContent((c) => ({
                      ...c,
                      limits: simulationLimits(investment.limits),
                    }))
                  }
                >
                  {zh ? '使用模拟盘当前边界' : 'Use current simulation limits'}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!!busy}
                onClick={() =>
                  setContent((c) => ({ ...c, limits: { ...draftLimits } }))
                }
              >
                {zh ? '设置并核对边界' : 'Set and review limits'}
              </Button>
            </div>
          </div>
        )}
      </details>
    </div>
  );
}
