import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { stageStrategyAllocation } from '@/utils/portfolio-workspace';
import type { AccountCombinationEditorState } from './use-account-strategy-combination';

export default function CombinationStrategyLibrary({
  editor,
}: {
  editor: AccountCombinationEditorState;
}) {
  const {
    zh,
    adding,
    setAdding,
    setEditing,
    library,
    strategies,
    allocations,
    changed,
    nextHistory,
    nextDraft,
    paging,
    loadMore,
    localError,
  } = editor;
  return (
    <Dialog open={adding} onOpenChange={setAdding}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{zh ? '添加策略' : 'Add a strategy'}</DialogTitle>
          <DialogDescription>
            {zh
              ? '已确认策略保留原始快照；草稿需先核对执行说明。'
              : 'Confirmed strategies keep their snapshots. Review execution details for drafts before applying.'}
          </DialogDescription>
        </DialogHeader>
        <Button
          variant="outline"
          onClick={() => {
            setAdding(false);
            setEditing({ item: null });
          }}
        >
          <Plus size={15} />
          {zh ? '写一份新策略' : 'Write a new strategy'}
        </Button>
        {library.isPending && (
          <p role="status" className="text-sm text-muted-foreground">
            {zh ? '正在读取资料库…' : 'Loading library…'}
          </p>
        )}
        {library.isError && (
          <div role="alert" className="space-y-2 text-sm">
            <p>
              {zh
                ? '策略资料库暂不可用。'
                : 'The strategy library is unavailable.'}
            </p>
            <Button variant="outline" onClick={() => void library.refetch()}>
              {zh ? '重试' : 'Retry'}
            </Button>
          </div>
        )}
        <div className="divide-y">
          {[...strategies.values()].map((item) => (
            <div
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-3 py-4"
            >
              <div className="min-w-0">
                <p className="break-words text-sm font-medium">
                  {item.content.title}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {item.status === 'confirmed'
                    ? zh
                      ? '已确认'
                      : 'Confirmed'
                    : zh
                      ? '草稿'
                      : 'Draft'}{' '}
                  · v{item.revision}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={allocations.some(
                  (value) => value.strategyId === item.id,
                )}
                onClick={() => {
                  changed(
                    stageStrategyAllocation(
                      allocations,
                      item.id,
                      item.revision,
                    ),
                  );
                  setAdding(false);
                }}
              >
                {allocations.some((value) => value.strategyId === item.id)
                  ? zh
                    ? '已加入'
                    : 'Added'
                  : zh
                    ? '加入组合'
                    : 'Add to combination'}
              </Button>
            </div>
          ))}
        </div>
        {(nextHistory || nextDraft) && (
          <Button
            variant="ghost"
            disabled={paging}
            onClick={() => void loadMore()}
          >
            {zh ? '加载更早的策略' : 'Load earlier strategies'}
          </Button>
        )}
        {localError && (
          <p role="alert" className="text-sm text-destructive">
            {localError}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
