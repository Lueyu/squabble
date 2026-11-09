import { Trash2 } from 'lucide-react';
import type { PortfolioAllocationInput } from '@shared/portfolio-workspace.interface';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { AccountCombinationEditorState } from './use-account-strategy-combination';

export default function CombinationAllocationCard({
  item,
  editor,
}: {
  item: PortfolioAllocationInput;
  editor: AccountCombinationEditorState;
}) {
  const { zh, strategies, locked, changed, allocations, setEditing } = editor;
  const strategy = strategies.get(item.strategyId);
  return (
    <article className="space-y-5 rounded-2xl border bg-card p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words font-semibold">
            {strategy?.content.title ??
              (zh ? '正在读取策略…' : 'Loading strategy…')}
          </h3>
          <p className="mt-2 text-xs text-muted-foreground">
            {strategy?.status === 'confirmed'
              ? zh
                ? '已确认快照'
                : 'Confirmed snapshot'
              : strategy?.preview?.canConfirm
                ? zh
                  ? '已核对草稿 · 应用时确认'
                  : 'Reviewed draft · confirm on apply'
                : zh
                  ? '草稿 · 需核对执行说明'
                  : 'Draft · execution review required'}{' '}
            · {zh ? '修订' : 'Revision'} {item.strategyRevision}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          disabled={locked}
          aria-label={`${zh ? '从组合移除' : 'Remove from combination'} ${strategy?.content.title ?? item.strategyId}`}
          onClick={() =>
            changed(
              allocations.filter(
                (value) => value.strategyId !== item.strategyId,
              ),
            )
          }
        >
          <Trash2 size={15} />
        </Button>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <label className="min-w-[130px] flex-1 space-y-2 text-xs text-muted-foreground">
          <span>{zh ? '预算占比（%）' : 'Budget cap (%)'}</span>
          <Input
            aria-label={`${strategy?.content.title ?? item.strategyId} ${zh ? '预算占比' : 'budget cap'}`}
            type="number"
            min={0}
            max={100}
            step="0.1"
            disabled={locked}
            value={item.allocationPct}
            onChange={(event) =>
              changed(
                allocations.map((value) =>
                  value.strategyId === item.strategyId
                    ? {
                        ...value,
                        allocationPct:
                          event.target.value === ''
                            ? 0
                            : Number(event.target.value),
                      }
                    : value,
                ),
              )
            }
          />
        </label>
        <label className="flex min-h-9 items-center gap-3 text-sm">
          <Switch
            checked={item.enabled}
            disabled={locked}
            onCheckedChange={(enabled) =>
              changed(
                allocations.map((value) =>
                  value.strategyId === item.strategyId
                    ? { ...value, enabled }
                    : value,
                ),
              )
            }
            aria-label={`${zh ? '启用' : 'Enable'} ${strategy?.content.title ?? item.strategyId}`}
          />
          {item.enabled ? (zh ? '启用' : 'Enabled') : zh ? '停用' : 'Disabled'}
        </label>
        <Button
          variant="ghost"
          size="sm"
          disabled={!strategy || locked}
          onClick={() => {
            if (strategy) setEditing({ item: strategy });
          }}
        >
          {zh ? '规则与来源 →' : 'Rules & sources →'}
        </Button>
      </div>
    </article>
  );
}
