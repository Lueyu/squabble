import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AiInvestmentView } from '@shared/investment-policy.interface';
import type {
  StrategyDraftInput,
  UserInvestmentStrategy,
  StrategyPreparationStatus,
} from '@shared/user-investment-strategy.interface';
import { investmentStrategiesApi } from '@/api/investment-strategies';
import {
  canReuseStrategyInterpretation,
  strategyEditorContent,
} from '@/utils/user-strategy-editor';
import { strategyPeriodDates } from '@/utils/strategy-dates';
import { normalizeApiPreparationError } from '@/utils/strategy-preparation';
import { simulationLimits } from './strategy-editor-limits';

export type StrategyEditorAction =
  | 'save'
  | 'prepare'
  | 'apply'
  | 'read'
  | 'observe'
  | 'recheck';

interface UseInvestmentStrategyEditorOptions {
  item: UserInvestmentStrategy | null;
  currentId: string | null;
  timezone: string;
  investment?: AiInvestmentView;
  onClose: () => void;
  onChanged: () => void;
  onReviewed?: (strategy: UserInvestmentStrategy) => Promise<void>;
}

function initialContent(
  item: UserInvestmentStrategy | null,
  timezone: string,
  investment?: AiInvestmentView,
): StrategyDraftInput {
  if (item) return structuredClone(item.content);
  const limits = investment?.limits;
  return {
    title: '投资策略 / Investment strategy',
    body: '',
    timezone,
    ...strategyPeriodDates('custom', timezone),
    entries: [
      { id: 'manual_' + crypto.randomUUID(), text: '', sourceKeys: [] },
    ],
    ...(limits ? { limits: simulationLimits(limits) } : {}),
  };
}

/** Own draft writes and durable preparation receipts for one editor session. */
export function useInvestmentStrategyEditor({
  item,
  currentId,
  timezone,
  investment,
  onClose,
  onChanged,
  onReviewed,
}: UseInvestmentStrategyEditorOptions) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [content, setContent] = useState(() =>
    initialContent(item, timezone, investment),
  );
  const [saved, setSaved] = useState<UserInvestmentStrategy | null>(() =>
    item?.status === 'draft' ? item : null,
  );
  // Keep the opening snapshot: a refresh must not silently authorize replacing
  // a different strategy that became current while this editor was open.
  const [expectedCurrentId] = useState(currentId);
  const [busy, setBusy] = useState<StrategyEditorAction | ''>('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [preparation, setPreparation] = useState<StrategyPreparationStatus>({
    status: 'none',
  });
  const [checking, setChecking] = useState(false);
  const [statusUnknown, setStatusUnknown] = useState(false);
  // Block double clicks before React renders. Retries keep the same request key
  // until the saved revision changes or a preparation is known to have failed.
  const lock = useRef(false);
  const prepareIntent = useRef<{ revision: string; key: string } | null>(null);
  const applyIntent = useRef<{ revision: string; key: string } | null>(null);
  const dirty = saved
    ? JSON.stringify(strategyEditorContent(content)) !==
      JSON.stringify(saved.content)
    : item?.status === 'confirmed'
      ? JSON.stringify(strategyEditorContent(content)) !==
        JSON.stringify(item.content)
      : true;
  const prepared = saved?.preview;
  const readyToApply = !!saved && !dirty && prepared?.canConfirm === true;
  const simulationReady = !!investment?.account && !!investment.policy;
  const savedId = saved?.id;
  const savedRevision = saved?.revision;
  const hasPreview = !!saved?.preview;

  useEffect(() => {
    if (savedId === undefined || savedRevision === undefined || hasPreview) {
      setPreparation({ status: 'none' });
      setStatusUnknown(false);
      setChecking(false);
      return;
    }
    // Ignore receipts for a replaced revision or an unmounted editor.
    // Reading status never starts preparation.
    let current = true;
    setChecking(true);
    investmentStrategiesApi
      .preparation(savedId, savedRevision)
      .then((state) => {
        if (!current) return;
        if (
          !state ||
          !['none', 'pending', 'succeeded', 'failed'].includes(state.status)
        )
          throw Error('STATUS');
        setPreparation(state);
        setStatusUnknown(false);
        if (state.status === 'failed') {
          prepareIntent.current = null;
          setError(state.error.message[zh ? 'zh-CN' : 'en']);
        }
      })
      .catch(() => {
        if (current) setStatusUnknown(true);
      })
      .finally(() => {
        if (current) setChecking(false);
      });
    return () => {
      current = false;
    };
  }, [savedId, savedRevision, hasPreview, zh]);
  useEffect(() => {
    if (busy !== 'prepare') return;
    const started = Date.now();
    setElapsed(0);
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [busy]);
  const saveLatest = async (observationOnly = false) => {
    const value = strategyEditorContent(content);
    // This explicit user choice removes executable authority; it never guesses a condition.
    if (observationOnly)
      value.entries = value.entries.map((entry) => ({
        ...entry,
        directive: undefined,
        mandateRule: undefined,
        mandateReviewedText: undefined,
      }));
    if (!value.title || !value.entries.length) throw Error('EMPTY');
    const result = saved
      ? JSON.stringify(value) === JSON.stringify(saved.content)
        ? saved
        : await investmentStrategiesApi.update(saved.id, saved.revision, value)
      : await investmentStrategiesApi.create(
          value,
          item?.status === 'confirmed' ? item.id : undefined,
        );
    setSaved(result);
    setContent(result.content);
    onChanged();
    return result;
  };
  const runAction = async (kind: StrategyEditorAction) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(kind);
    setError('');
    setMessage('');
    let attempted: UserInvestmentStrategy | null = null;
    try {
      if (kind === 'read' && saved) {
        const state = await investmentStrategiesApi.preparation(
          saved.id,
          saved.revision,
        );
        if (
          !state ||
          !['none', 'pending', 'succeeded', 'failed'].includes(state.status)
        )
          throw Error('STATUS');
        // A receipt is historical evidence; another tab may have saved a newer revision.
        const value = await investmentStrategiesApi.get(saved.id);
        setPreparation(state);
        setStatusUnknown(false);
        setSaved(value);
        if (!dirty) setContent(value.content);
        if (state.status === 'failed') {
          prepareIntent.current = null;
          setError(state.error.message[zh ? 'zh-CN' : 'en']);
        } else
          setMessage(
            state.status === 'pending'
              ? zh
                ? '执行说明仍在整理中。这里只读取状态，不会重复调用股友。'
                : 'Execution details are still being prepared. This only checks status; it never redispatches the model.'
              : zh
                ? '已读取保存结果，未保存的修改继续保留。'
                : 'Loaded the saved result. Unsaved edits are preserved.',
          );
        return;
      }
      if (kind === 'apply') {
        // Only the saved revision and its reviewed hash may become execution authority.
        if (
          !saved?.preview ||
          dirty ||
          !saved.preview.canConfirm ||
          !simulationReady
        )
          throw Error('PREVIEW');
        if (onReviewed) {
          // Account combinations publish only through their own reviewed apply transaction.
          await onReviewed(saved);
          onChanged();
          onClose();
          return;
        }
        const revision = `${saved.id}:${saved.revision}:${saved.preview.contentHash}`;
        if (applyIntent.current?.revision !== revision)
          applyIntent.current = { revision, key: crypto.randomUUID() };
        await investmentStrategiesApi.apply({
          strategyId: saved.id,
          expectedRevision: saved.revision,
          previewHash: saved.preview.contentHash,
          expectedCurrentId,
          requestKey: applyIntent.current.key,
        });
        onChanged();
        onClose();
        return;
      }
      const wasInterpreted = canReuseStrategyInterpretation(
        content,
        saved?.preview ? saved : item,
      );
      const value = await saveLatest(kind === 'observe');
      attempted = value;
      if (kind === 'observe' || kind === 'recheck') {
        const next = await investmentStrategiesApi.preview(
          value.id,
          value.revision,
        );
        setSaved(next);
        setContent(next.content);
        setPreparation({ status: 'none' });
        setStatusUnknown(false);
        onChanged();
        setMessage(
          kind === 'observe'
            ? zh
              ? '已按仅观察方式核对，不调用 AI、不生成自动买卖条件。确认应用后也不会自动交易。'
              : 'Reviewed as observation only, without AI calls or automatic trade conditions. Applying this explanation will not trade.'
            : zh
              ? '已重新核对已有执行说明，未调用 AI。请核对后再确认应用。'
              : 'Saved execution details were rechecked without AI calls. Review them before applying.',
        );
        return;
      }
      if (kind === 'prepare') {
        const revision = `${value.id}:${value.revision}`;
        if (prepareIntent.current?.revision !== revision)
          prepareIntent.current = { revision, key: crypto.randomUUID() };
        const next = wasInterpreted
          ? await investmentStrategiesApi.preview(value.id, value.revision)
          : await investmentStrategiesApi.prepare(
              value.id,
              value.revision,
              prepareIntent.current.key,
            );
        setSaved(next);
        setContent(next.content);
        onChanged();
        setMessage(
          zh
            ? '执行说明已整理，请核对下面的条件与金额。'
            : 'Execution details are ready. Review the conditions and amounts below.',
        );
      } else
        setMessage(
          zh
            ? '草稿已保存。正在执行的策略保持原样。'
            : 'Draft saved. The applied strategy keeps running.',
        );
    } catch (cause) {
      if (kind === 'prepare') {
        // A failed response can hide a completed server job. Read its receipt
        // before offering another model call.
        setError(normalizeApiPreparationError(cause, i18n.language).message);
        if (attempted)
          try {
            const state = await investmentStrategiesApi.preparation(
              attempted.id,
              attempted.revision,
            );
            if (
              !state ||
              !['none', 'pending', 'succeeded', 'failed'].includes(state.status)
            )
              throw Error('STATUS');
            setPreparation(state);
            setStatusUnknown(false);
            if (state.status === 'failed') {
              prepareIntent.current = null;
              setError(state.error.message[zh ? 'zh-CN' : 'en']);
            } else if (
              state.status === 'pending' ||
              state.status === 'succeeded'
            ) {
              setError('');
              setMessage(
                state.status === 'pending'
                  ? zh
                    ? '执行说明仍在整理中，已读取到保存状态，不会重复调用。'
                    : 'Execution details are still being prepared. The saved status was verified; no duplicate call is made.'
                  : zh
                    ? '执行说明已经整理完成，可读取已有说明后核对。'
                    : 'Execution details are already prepared. Read the saved explanation to review it.',
              );
            }
          } catch {
            setStatusUnknown(true);
          }
        return;
      }
      if (kind === 'read') {
        setStatusUnknown(true);
        setError(
          zh
            ? '暂时无法核对整理状态，请稍后再读取；不会自动重试。'
            : 'Preparation status is unavailable. Check again later; no automatic retry is made.',
        );
        return;
      }
      const apiError = (
        cause as {
          response?: {
            data?: { error?: { message?: string }; message?: string };
          };
        }
      )?.response?.data;
      const code = String(
        apiError?.error?.message ??
          apiError?.message ??
          (cause instanceof Error ? cause.message : ''),
      );
      setError(
        code === 'EMPTY'
          ? zh
            ? '请写一条策略想法并填写标题。'
            : 'Add an idea and a title.'
          : /changed|stale|revision/iu.test(code)
            ? zh
              ? '草稿、来源或当前策略已变化，请关闭后重新核对。'
              : 'The draft, source or applied strategy changed. Close and review it again.'
            : kind === 'apply'
              ? zh
                ? '尚未确认切换。请核对模拟盘、执行说明和风险限制后再试。'
                : 'The switch is unconfirmed. Review the account, execution details and limits before retrying.'
              : zh
                ? '尚未确认保存，请核对内容后重试。'
                : 'Save is unconfirmed. Review the content and retry.',
      );
    } finally {
      lock.current = false;
      setBusy('');
    }
  };
  const valid =
    content.title.trim() && strategyEditorContent(content).entries.length > 0;

  return {
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
  };
}
