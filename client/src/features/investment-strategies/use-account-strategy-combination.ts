import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type {
  PortfolioAccountDetail,
  PortfolioAllocationInput,
  PortfolioCombination,
  PortfolioCombinationDraft,
  PortfolioCombinationPreview,
} from '@shared/portfolio-workspace.interface';
import type { UserInvestmentStrategy } from '@shared/user-investment-strategy.interface';
import {
  portfolioWorkspaceApi,
  portfolioWorkspaceKeys,
} from '@/api/portfolio-workspace';
import { investmentStrategiesApi } from '@/api/investment-strategies';
import { createRequestIntent } from '@/utils/simple-experience';
import {
  canApplyCombination,
  combinationIdentity,
  portfolioWorkspaceError,
  simulationAccountPath,
  stageStrategyAllocation,
} from '@/utils/portfolio-workspace';

/** Keep the reviewed combination bound to one account and one opening policy revision. */
export function useAccountStrategyCombination(account: PortfolioAccountDetail) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const language = zh ? 'zh-CN' : 'en';
  const client = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const requestedId = params.get('investmentStrategyId');
  const initial =
    account.combination.draft?.allocations ?? account.combination.allocations;
  const [allocations, setAllocations] = useState<PortfolioAllocationInput[]>(
    () =>
      initial.map(
        ({ strategyId, strategyRevision, allocationPct, enabled }) => ({
          strategyId,
          strategyRevision,
          allocationPct,
          enabled,
        }),
      ),
  );
  const [expectedRevision, setExpectedRevision] = useState(
    account.combination.policyRevision,
  );
  const [preview, setPreview] = useState<PortfolioCombinationPreview | null>(
    null,
  );
  const [reviewedIdentity, setReviewedIdentity] = useState<string | null>(null);
  const [savedIdentity, setSavedIdentity] = useState(() =>
    combinationIdentity(
      account.id,
      account.combination.policyRevision,
      initial,
    ),
  );
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{
    item: UserInvestmentStrategy | null;
  } | null>(null);
  const [message, setMessage] = useState('');
  const [localError, setLocalError] = useState('');
  const [older, setOlder] = useState<UserInvestmentStrategy[]>([]);
  const [historyCursor, setHistoryCursor] = useState<
    string | null | undefined
  >();
  const [draftCursor, setDraftCursor] = useState<string | null | undefined>();
  const [paging, setPaging] = useState(false);
  const intent = useRef(createRequestIntent(() => crypto.randomUUID()));
  const opened = useRef<string | null>(null);
  const identity = combinationIdentity(
    account.id,
    expectedRevision,
    allocations,
  );
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const remoteIdentity = combinationIdentity(
    account.id,
    account.combination.policyRevision,
    initial,
  );
  const observedRemoteIdentity = useRef(remoteIdentity);
  const library = useQuery({
    queryKey: ['investment-strategies'],
    queryFn: investmentStrategiesApi.workspace,
    retry: false,
  });
  const selected = useQuery({
    queryKey: [
      'portfolio-strategy-selections',
      account.id,
      ...allocations.map(
        (item) => `${item.strategyId}:${item.strategyRevision}`,
      ),
    ],
    queryFn: () =>
      Promise.all(
        allocations.map((item) => investmentStrategiesApi.get(item.strategyId)),
      ),
    enabled: allocations.length > 0,
    retry: false,
  });
  const linked = useQuery({
    queryKey: ['investment-strategy', requestedId],
    queryFn: () => investmentStrategiesApi.get(requestedId!),
    enabled: !!requestedId,
    retry: false,
  });
  const strategies = new Map<string, UserInvestmentStrategy>(
    [
      ...(library.data?.current ? [library.data.current] : []),
      ...(library.data?.history ?? []),
      ...(library.data?.drafts ?? []),
      ...older,
      ...account.combination.allocations.map((item) => item.snapshot),
      ...(selected.data ?? []),
      ...(linked.data ? [linked.data] : []),
    ].map((item) => [item.id, item]),
  );
  const nextHistory =
    historyCursor === undefined ? library.data?.historyCursor : historyCursor;
  const nextDraft =
    draftCursor === undefined ? library.data?.draftsCursor : draftCursor;
  const changed = (next: PortfolioAllocationInput[]) => {
    identityRef.current = combinationIdentity(
      account.id,
      expectedRevision,
      next,
    );
    setAllocations(next);
    setPreview(null);
    setReviewedIdentity(null);
    setMessage('');
    setLocalError('');
  };
  const cacheDraft = async (draft: PortfolioCombinationDraft) => {
    // A response started before this save must not replace the acknowledged draft.
    await Promise.all([
      client.cancelQueries({ queryKey: portfolioWorkspaceKeys.account(account.id) }),
      client.cancelQueries({ queryKey: portfolioWorkspaceKeys.combination(account.id) }),
    ]);
    client.setQueryData<PortfolioAccountDetail>(
      portfolioWorkspaceKeys.account(account.id),
      (current) => current?.combination.policyRevision === draft.expectedPolicyRevision
        ? { ...current, combination: { ...current.combination, draft } }
        : current,
    );
    client.setQueryData<PortfolioCombination>(
      portfolioWorkspaceKeys.combination(account.id),
      (current) => current?.policyRevision === draft.expectedPolicyRevision
        ? { ...current, draft }
        : current,
    );
  };
  const mutation = useMutation({
    retry: false,
    mutationFn: async (action: 'save' | 'preview' | 'apply') => {
      const captured = combinationIdentity(
        account.id,
        expectedRevision,
        allocations,
      );
      const body = { expectedPolicyRevision: expectedRevision, allocations };
      const request = {
        ...body,
        requestKey: intent.current.keyFor({
          action,
          accountId: account.id,
          ...body,
          ...(action === 'apply' ? { previewHash: preview?.previewHash } : {}),
        }),
      };
      if (action === 'apply') {
        if (
          !canApplyCombination(
            account.id,
            expectedRevision,
            allocations,
            preview,
            reviewedIdentity,
          )
        )
          throw Error(
            zh
              ? '预览已失效，请重新核对。'
              : 'Preview is no longer valid. Review again.',
          );
        await portfolioWorkspaceApi.apply(account.id, {
          ...request,
          previewHash: preview!.previewHash,
        });
        return { action, identity: captured, result: null };
      }
      if (action === 'preview')
        return {
          action,
          identity: captured,
          result: await portfolioWorkspaceApi.preview(account.id, request),
        };
      const draft = await portfolioWorkspaceApi.saveDraft(account.id, request);
      return { action, identity: captured, result: draft };
    },
    onSuccess: async (result) => {
      intent.current.complete();
      if (result.action === 'apply') {
        await Promise.all([
          client.invalidateQueries({
            queryKey: portfolioWorkspaceKeys.accounts,
          }),
          client.invalidateQueries({
            queryKey: portfolioWorkspaceKeys.account(account.id),
          }),
          client.invalidateQueries({
            queryKey: portfolioWorkspaceKeys.combination(account.id),
          }),
          client.invalidateQueries({ queryKey: ['investment-strategies'] }),
        ]);
        navigate(simulationAccountPath(account.id));
      } else if (
        result.action === 'preview' &&
        result.result &&
        identityRef.current === result.identity
      ) {
        setPreview(result.result);
        setReviewedIdentity(result.identity);
        setMessage('');
      } else if (result.action === 'save') {
        await cacheDraft(result.result);
        setSavedIdentity(result.identity);
        setMessage(
          zh
            ? '组合草稿已保存。当前运行组合保持原样。'
            : 'Combination draft saved. The running combination is unchanged.',
        );
      }
    },
  });
  useEffect(() => {
    if (observedRemoteIdentity.current === remoteIdentity) return;
    observedRemoteIdentity.current = remoteIdentity;
    // Policy changes require the existing explicit reload. Same-revision draft
    // refreshes may initialize a clean editor, but never overwrite local work.
    if (expectedRevision !== account.combination.policyRevision) return;
    if (identity === savedIdentity && !mutation.isPending) {
      setAllocations(initial.map(({ strategyId, strategyRevision, allocationPct, enabled }) => ({
        strategyId, strategyRevision, allocationPct, enabled,
      })));
    }
    setSavedIdentity(remoteIdentity);
    setPreview(null);
    setReviewedIdentity(null);
  }, [remoteIdentity, expectedRevision, account.combination.policyRevision,
    identity, savedIdentity, initial, mutation.isPending]);
  useEffect(() => {
    if (!requestedId) {
      opened.current = null;
      return;
    }
    if (linked.data && opened.current !== requestedId) {
      opened.current = requestedId;
      setEditing({ item: linked.data });
    }
  }, [requestedId, linked.data]);
  useEffect(() => {
    if (!preview) return;
    const timeout = window.setTimeout(
      () => {
        setPreview(null);
        setReviewedIdentity(null);
      },
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [preview]);
  const closeEditor = () => {
    setEditing(null);
    if (params.has('investmentStrategyId')) {
      const next = new URLSearchParams(params);
      next.delete('investmentStrategyId');
      setParams(next, { replace: true });
    }
  };
  const reviewSaved = async (item: UserInvestmentStrategy) => {
    const replacedId = editing?.item?.id;
    const next =
      replacedId &&
      replacedId !== item.id &&
      allocations.some((value) => value.strategyId === replacedId)
        ? allocations.map((value) =>
            value.strategyId === replacedId
              ? {
                  ...value,
                  strategyId: item.id,
                  strategyRevision: item.revision,
                }
              : value,
          )
        : stageStrategyAllocation(allocations, item.id, item.revision);
    const body = {
      expectedPolicyRevision: expectedRevision,
      allocations: next,
    };
    const draft = await portfolioWorkspaceApi.saveDraft(account.id, {
      ...body,
      requestKey: intent.current.keyFor({
        accountId: account.id,
        action: 'review-draft',
        ...body,
      }),
    });
    await cacheDraft(draft);
    intent.current.complete();
    changed(next);
    setSavedIdentity(combinationIdentity(account.id, expectedRevision, next));
    setMessage(
      zh
        ? '已保存到组合草稿。为策略设置预算并启用，再预览组合。'
        : 'Saved to the combination draft. Set its budget and enable it, then preview the combination.',
    );
  };
  const loadMore = async () => {
    setPaging(true);
    setLocalError('');
    try {
      const [history, drafts] = await Promise.all([
        nextHistory ? investmentStrategiesApi.history(nextHistory) : null,
        nextDraft ? investmentStrategiesApi.drafts(nextDraft) : null,
      ]);
      setOlder((current) => [
        ...current,
        ...(history?.items ?? []),
        ...(drafts?.items ?? []),
      ]);
      if (history) setHistoryCursor(history.nextCursor);
      if (drafts) setDraftCursor(drafts.nextCursor);
    } catch (error) {
      setLocalError(
        portfolioWorkspaceError(error, zh, {
          zh: '较早策略暂不可读，请重试。',
          en: 'Earlier strategies could not be loaded. Retry.',
        }),
      );
    } finally {
      setPaging(false);
    }
  };
  const stale = expectedRevision !== account.combination.policyRevision;
  const invalidAllocation = allocations.some(
    (item) =>
      !Number.isFinite(item.allocationPct) ||
      item.allocationPct < 0 ||
      item.allocationPct > 100 ||
      (item.enabled && item.allocationPct <= 0),
  );
  const allocated = allocations
    .filter((item) => item.enabled)
    .reduce((sum, item) => sum + item.allocationPct, 0);
  const locked = mutation.isPending || account.status === 'archived' || stale;
  const canApply = canApplyCombination(
    account.id,
    expectedRevision,
    allocations,
    preview,
    reviewedIdentity,
  );
  return {
    zh,
    language,
    allocations,
    expectedRevision,
    preview,
    savedIdentity,
    adding,
    setAdding,
    editing,
    setEditing,
    message,
    localError,
    paging,
    identity,
    library,
    selected,
    linked,
    strategies,
    nextHistory,
    nextDraft,
    changed,
    mutation,
    closeEditor,
    reviewSaved,
    loadMore,
    stale,
    invalidAllocation,
    allocated,
    locked,
    canApply,
    setExpectedRevision,
    setPreview,
    setReviewedIdentity,
    setSavedIdentity,
  };
}

export type AccountCombinationEditorState = ReturnType<
  typeof useAccountStrategyCombination
>;
