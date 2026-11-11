import type {
  PortfolioAllocationInput,
  PortfolioCombinationPreview,
} from '@shared/portfolio-workspace.interface';
import type { TeamDecisionRef } from '@shared/team-workspace.interface';
import { canonicalTeamDecisionRefs } from '@/features/investment-strategies/team-decision-context';
import { friendlyError } from './error-message';

const workspaceErrors: Record<string, { zh: string; en: string }> = {
  POLICY_REVISION_CHANGED: {
    zh: '账户政策已变化，请重新读取并预览。',
    en: 'The account policy changed. Reload and preview again.',
  },
  STRATEGY_REVISION_CHANGED: {
    zh: '策略已有新修订，请打开“规则与来源”核对后保存到组合草稿。',
    en: 'A strategy revision changed. Open Rules & sources, review it and save it to the combination draft.',
  },
  STRATEGY_REVIEW_REQUIRED: {
    zh: '请先打开草稿的“规则与来源”，核对执行说明并保存到组合草稿，再预览组合。',
    en: 'Open the draft’s Rules & sources, review its execution details and save it to the combination draft before previewing.',
  },
  COMBINATION_PREVIEW_EXPIRED: {
    zh: '预览已过期，请重新预览当前组合。',
    en: 'The preview expired. Preview the current combination again.',
  },
  COMBINATION_PREVIEW_CHANGED: {
    zh: '组合或来源已变化，请重新核对预览。',
    en: 'The combination or source changed. Review a new preview.',
  },
  COMBINATION_CONFLICT: {
    zh: '组合中存在冲突，请重新预览并核对关联策略。',
    en: 'The combination has conflicts. Preview again and review the affected strategies.',
  },
  CONFIRMED_STRATEGY_REQUIRED: {
    zh: '请先添加并应用已核对的策略组合，再恢复账户。',
    en: 'Apply a reviewed strategy combination before resuming this account.',
  },
  ARCHIVED_ACCOUNT_READ_ONLY: {
    zh: '此账户已归档，仅可回看。',
    en: 'This account is archived and read-only.',
  },
  ACCOUNT_REQUIRES_POLICY_ADOPTION: {
    zh: '此旧版账户尚未建立账户政策，请从已核对的起点创建新模拟账户。',
    en: 'This legacy account has no account policy. Create a new simulation from a reviewed starting point.',
  },
  ACCOUNT_NOT_FOUND: {
    zh: '账户不存在或不可访问，请返回账户列表。',
    en: 'The account is missing or unavailable. Return to the account list.',
  },
  PINNED_DISCUSSION_CHANGED: {
    zh: '固定讨论来源已变化，请重新核对来源。',
    en: 'A pinned discussion source changed. Review its source again.',
  },
  REQUEST_KEY_CONFLICT: {
    zh: '此次请求内容已变化，请重新读取后再操作。',
    en: 'This request’s content changed. Reload before trying again.',
  },
  'Report content is not ready for readable publication': {
    zh: '这份报告没有可复制的可读研究正文，请重新读取报告后再试。',
    en: 'This saved report has no readable research to copy. Reload the report and try again.',
  },
  'Enabled strategies require a positive budget': {
    zh: '启用策略的预算必须大于 0%。',
    en: 'Enabled strategies need a budget greater than 0%.',
  },
};

export function portfolioWorkspaceError(
  error: unknown,
  zh: boolean,
  fallback: { zh: string; en: string },
) {
  const message = friendlyError(error, zh, fallback);
  return workspaceErrors[message]?.[zh ? 'zh' : 'en'] ?? message;
}

export const simulationAccountPath = (accountId: string) =>
  `/paper/${encodeURIComponent(accountId)}`;
export const simulationStrategyPath = (
  accountId: string,
  strategyId?: string,
) =>
  `${simulationAccountPath(accountId)}/strategies${strategyId ? `?investmentStrategyId=${encodeURIComponent(strategyId)}` : ''}`;

/** Canonical selection identity prevents a previous response authorizing edited inputs. */
export function combinationIdentity(
  accountId: string,
  revision: number,
  allocations: PortfolioAllocationInput[],
  teamDecisionRefs: TeamDecisionRef[] = [],
) {
  return JSON.stringify({
    teamDecisionRefs: canonicalTeamDecisionRefs(teamDecisionRefs),
    accountId,
    revision,
    allocations: allocations
      .map((item) => ({
        strategyId: item.strategyId,
        strategyRevision: item.strategyRevision,
        allocationPct: item.allocationPct,
        enabled: item.enabled,
      }))
      .sort((a, b) => a.strategyId.localeCompare(b.strategyId)),
  });
}

export function canApplyCombination(
  accountId: string,
  revision: number,
  allocations: PortfolioAllocationInput[],
  preview: PortfolioCombinationPreview | null,
  reviewedIdentity: string | null,
  now = Date.now(),
  teamDecisionRefs: TeamDecisionRef[] = [],
) {
  return Boolean(
    preview?.canApply &&
    preview.accountId === accountId &&
    preview.expectedPolicyRevision === revision &&
    Date.parse(preview.expiresAt) > now &&
    reviewedIdentity === combinationIdentity(accountId, revision, allocations, teamDecisionRefs) &&
    JSON.stringify(canonicalTeamDecisionRefs(preview.teamDecisionRefs)) === JSON.stringify(canonicalTeamDecisionRefs(teamDecisionRefs)),
  );
}

export function stageStrategyAllocation(
  allocations: PortfolioAllocationInput[],
  strategyId: string,
  revision: number,
) {
  const existing = allocations.find((item) => item.strategyId === strategyId);
  return existing
    ? allocations.map((item) =>
        item.strategyId === strategyId
          ? { ...item, strategyRevision: revision }
          : item,
      )
    : [
        ...allocations,
        {
          strategyId,
          strategyRevision: revision,
          allocationPct: 0,
          enabled: false,
        },
      ];
}

export function portfolioMoney(
  value: string | number | null | undefined,
  language = 'en',
) {
  return value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
    ? '—'
    : new Intl.NumberFormat(language, {
        style: 'currency',
        currency: 'USD',
        currencyDisplay: 'narrowSymbol',
        maximumFractionDigits: 2,
      }).format(Number(value));
}

export function accountStatusLabel(status: string, zh: boolean) {
  return status === 'paused'
    ? zh
      ? '已暂停'
      : 'Paused'
    : status === 'archived'
      ? zh
        ? '已归档'
        : 'Archived'
      : zh
        ? '运行中'
        : 'Running';
}
