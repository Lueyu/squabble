import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AiInvestmentView } from '@shared/investment-policy.interface';
import type { UserInvestmentStrategy } from '@shared/user-investment-strategy.interface';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { businessTime } from '@/utils/strategy-dates';
import { useInvestmentStrategyEditor } from './use-investment-strategy-editor';
import StrategyEditorForm from './StrategyEditorForm';
import StrategyExecutionReview from './StrategyExecutionReview';

interface InvestmentStrategyEditorProps {
  item: UserInvestmentStrategy | null;
  currentId: string | null;
  timezone: string;
  investment?: AiInvestmentView;
  onClose: () => void;
  onChanged: () => void;
}

export default function InvestmentStrategyEditor({
  item,
  currentId,
  timezone,
  investment,
  onClose,
  onChanged,
}: InvestmentStrategyEditorProps) {
  const {
    zh,
    content,
    setContent,
    saved,
    busy,
    message,
    error,
    setError,
    elapsed,
    preparation,
    checking,
    statusUnknown,
    dirty,
    prepared,
    readyToApply,
    simulationReady,
    valid,
    runAction,
  } = useInvestmentStrategyEditor({
    item,
    currentId,
    timezone,
    investment,
    onClose,
    onChanged,
  });
  const [editingExpanded, setEditingExpanded] = useState(
    () => !(item?.status === 'draft' && item.preview?.canConfirm),
  );
  const showEditor = editingExpanded || !readyToApply;
  const sources = saved?.sources ?? item?.sources ?? [];
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="flex max-h-[90dvh] min-w-0 flex-col overflow-hidden p-4 sm:max-w-3xl sm:p-6">
        <DialogHeader className="shrink-0 pr-6">
          <DialogTitle>
            {readyToApply
              ? zh
                ? '核对并启用策略'
                : 'Review and enable strategy'
              : zh
                ? '写下你的投资策略'
                : 'Write your investment strategy'}
          </DialogTitle>
          <DialogDescription>
            {currentId
              ? zh
                ? '编辑期间旧策略继续运行。点击应用才会整体切换。'
                : 'The applied strategy keeps running while you edit. Apply explicitly to switch it.'
              : readyToApply
                ? zh
                  ? '核对以下执行说明和风险边界，确认后交给模拟盘。'
                  : 'Review the execution details and risk limits below, then confirm to enable this strategy in your simulation.'
                : zh
                  ? '先保存想法，再核对执行说明，最后交给模拟盘。'
                  : 'Save your intent, review execution details, then apply it to your simulation.'}
          </DialogDescription>
        </DialogHeader>
        <div
          data-strategy-scroll
          className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto pr-1"
        >
          <StrategyExecutionReview
            item={item}
            prepared={prepared}
            content={content}
            dirty={dirty}
            readyToApply={readyToApply}
            zh={zh}
          />
          {readyToApply && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={showEditor}
              onClick={() => setEditingExpanded((value) => !value)}
            >
              {showEditor
                ? zh
                  ? '收起编辑内容'
                  : 'Collapse editing'
                : zh
                  ? '修改策略内容'
                  : 'Edit strategy content'}
            </Button>
          )}
          {showEditor && (
            <StrategyEditorForm
              content={content}
              setContent={setContent}
              investment={investment}
              busy={!!busy}
              zh={zh}
              setError={setError}
            />
          )}
          {!!sources.length && (
            <section
              aria-label={zh ? '固定研究来源' : 'Pinned research sources'}
              className="space-y-2 rounded-xl border p-3"
            >
              <h3 className="text-sm font-medium">
                {zh ? '固定研究来源' : 'Pinned research sources'}
              </h3>
              {sources.map((source) => (
                <div
                  key={source.key}
                  className="text-xs leading-6 [overflow-wrap:anywhere]"
                >
                  {source.kind === 'report' && source.versionId ? (
                    <Link
                      className="text-primary underline"
                      to={`/analysis/reports/${encodeURIComponent(source.versionId)}`}
                      onClick={onClose}
                    >
                      {source.title}
                    </Link>
                  ) : source.sessionId ? (
                    <Link
                      className="text-primary underline"
                      to={`/council?session=${encodeURIComponent(source.sessionId)}`}
                      onClick={onClose}
                    >
                      {source.title}
                    </Link>
                  ) : (
                    <span>{source.title}</span>
                  )}
                  <span className="ml-2 text-muted-foreground">
                    {businessTime(source.createdAt, content.timezone)}
                  </span>
                </div>
              ))}
            </section>
          )}

          {busy === 'prepare' && (
            <p role="status" className="rounded-xl bg-primary/5 p-3 text-sm">
              {zh
                ? `股友正在整理执行说明 · ${elapsed} 秒。草稿已保存，可以稍后回来查看。`
                : `Preparing execution details · ${elapsed}s. Your draft is saved; you can return later.`}
            </p>
          )}
          {preparation.status === 'pending' && (
            <p role="status" className="rounded-xl bg-primary/5 p-3 text-sm">
              {zh
                ? '执行说明仍在整理中。可关闭后回来查看；不会重复调用股友。'
                : 'Execution details are still being prepared. You can return later; no duplicate model call is made.'}
            </p>
          )}
          {statusUnknown && (
            <p role="status" className="text-sm text-muted-foreground">
              {zh
                ? '整理状态尚未核实，请先读取状态，避免重复调用。'
                : 'Preparation status is unconfirmed. Check its status before starting another model call.'}
            </p>
          )}
          {message && (
            <p
              role="status"
              className="text-sm text-emerald-700 dark:text-emerald-300"
            >
              {message}
            </p>
          )}
          {error && (
            <div role="alert" className="space-y-2 text-sm text-destructive">
              <p>{error}</p>
              {preparation.status === 'failed' &&
                preparation.error.code.startsWith('LLM_BUDGET_EXCEEDED') && (
                  <Link
                    className="text-primary underline"
                    to="/settings/budget"
                    onClick={onClose}
                  >
                    {zh
                      ? '查看研究预算设置'
                      : 'Review research budget settings'}
                  </Link>
                )}
            </div>
          )}
          {saved &&
            (!!error ||
              statusUnknown ||
              preparation.status === 'pending' ||
              preparation.status === 'succeeded') && (
              <Button
                variant="outline"
                size="sm"
                disabled={!!busy || checking}
                onClick={() => void runAction('read')}
              >
                {zh ? '读取整理状态' : 'Check preparation status'}
              </Button>
            )}
          {error && prepared && !dirty && (
            <Button
              variant="outline"
              size="sm"
              disabled={!!busy}
              onClick={() => void runAction('recheck')}
            >
              {zh ? '重新核对已有说明' : 'Recheck saved explanation'}
            </Button>
          )}
          {!simulationReady && (
            <p className="text-sm text-muted-foreground">
              {zh
                ? '应用前先设置 AI 模拟盘。'
                : 'Set up your simulation before applying.'}{' '}
              <Link
                className="text-primary underline"
                to={
                  saved
                    ? `/paper?investmentStrategyId=${encodeURIComponent(saved.id)}`
                    : '/paper'
                }
                onClick={onClose}
              >
                {zh ? '设置模拟盘并继续' : 'Set up simulation and continue'}
              </Link>
            </p>
          )}
          <p role="status" className="text-xs leading-6 text-muted-foreground">
            {readyToApply
              ? zh
                ? '执行说明已就绪。核对无误后，点击确认才会应用到模拟盘。'
                : 'Execution details are ready. Review them, then confirm to apply to your simulation.'
              : prepared && !dirty
                ? zh
                  ? '请先处理上方执行说明中的问题，再重新核对；当前尚未应用到模拟盘。'
                  : 'Resolve the issues above, then review again. This strategy has not been applied to your simulation.'
                : zh
                  ? '下一步先整理执行说明供你核对，这一步只保存和整理，不会应用到模拟盘。'
                  : 'Next, prepare the execution details for review. This step saves and prepares only; it does not apply to your simulation.'}
          </p>
          {!readyToApply && preparation.status !== 'pending' && (
            <div className="space-y-2 rounded-xl bg-muted/30 p-3 text-sm">
              <p className="leading-6 text-muted-foreground">
                {zh
                  ? '只是想先记下关注事项？可仅作观察策略核对，不调用 AI，也不生成自动买卖条件。'
                  : 'Want to keep an idea to watch? Review it as observation only, without AI calls or automatic trade conditions.'}
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={!!busy || !valid || checking || statusUnknown}
                onClick={() => void runAction('observe')}
              >
                {zh ? '仅作观察策略核对' : 'Review as observation only'}
              </Button>
            </div>
          )}
        </div>
        <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t pt-4">
          <Button variant="ghost" onClick={onClose}>
            {zh ? '关闭' : 'Close'}
          </Button>
          <Button
            variant="outline"
            disabled={!!busy || !valid}
            onClick={() => void runAction('save')}
          >
            {item?.status === 'confirmed' && !saved
              ? zh
                ? '另存为草稿'
                : 'Copy as draft'
              : zh
                ? '仅保存草稿'
                : 'Save draft only'}
          </Button>
          <Button
            disabled={
              !!busy ||
              !valid ||
              checking ||
              statusUnknown ||
              preparation.status === 'pending' ||
              (readyToApply && !simulationReady)
            }
            onClick={() =>
              void runAction(
                readyToApply
                  ? 'apply'
                  : preparation.status === 'succeeded'
                    ? 'read'
                    : 'prepare',
              )
            }
          >
            {busy === 'prepare'
              ? zh
                ? '正在整理说明…'
                : 'Preparing details…'
              : busy === 'apply'
                ? zh
                  ? '正在应用…'
                  : 'Applying…'
                : checking
                  ? zh
                    ? '正在读取状态…'
                    : 'Checking status…'
                  : preparation.status === 'pending'
                    ? zh
                      ? '正在整理说明…'
                      : 'Preparing details…'
                    : readyToApply
                      ? zh
                        ? '确认说明并应用'
                        : 'Review and apply to simulation'
                      : preparation.status === 'succeeded'
                        ? zh
                          ? '读取已整理说明'
                          : 'Read prepared details'
                        : preparation.status === 'failed'
                          ? zh
                            ? '重试整理说明'
                            : 'Retry preparation'
                          : zh
                            ? '核对执行说明'
                            : 'Review execution details'}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
