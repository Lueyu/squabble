import http from './http';
import type {
  ApplyPortfolioCombinationRequest,
  CreatePortfolioAccountRequest,
  PortfolioAccountDetail,
  PortfolioAccountMutationRequest,
  PortfolioAccountMutationResult,
  PortfolioAccountSummary,
  PortfolioCombination,
  PortfolioCombinationDraft,
  PortfolioCombinationPreview,
  PortfolioCombinationRequest,
} from '@shared/portfolio-workspace.interface';

const base = '/api/ai-investment/accounts';
const accountPath = (accountId: string) => {
  if (!accountId.trim())
    throw new Error('An explicit simulation account is required.');
  return `${base}/${encodeURIComponent(accountId)}`;
};

/** Account identity is required at the transport boundary and in every query key. */
export const portfolioWorkspaceKeys = {
  accounts: ['portfolio-accounts'] as const,
  account: (accountId: string) => ['portfolio-account', accountId] as const,
  combination: (accountId: string) =>
    ['portfolio-combination', accountId] as const,
};

export const portfolioWorkspaceApi = {
  accounts: async () => (await http.get<PortfolioAccountSummary[]>(base)).data,
  account: async (accountId: string) =>
    (await http.get<PortfolioAccountDetail>(accountPath(accountId))).data,
  create: async (input: CreatePortfolioAccountRequest) =>
    (await http.post<PortfolioAccountMutationResult>(base, input)).data,
  rename: async (
    accountId: string,
    input: PortfolioAccountMutationRequest & { name: string },
  ) =>
    (
      await http.patch<PortfolioAccountMutationResult>(
        accountPath(accountId),
        input,
      )
    ).data,
  pause: async (accountId: string, input: PortfolioAccountMutationRequest) =>
    (
      await http.post<PortfolioAccountMutationResult>(
        `${accountPath(accountId)}/pause`,
        input,
      )
    ).data,
  resume: async (accountId: string, input: PortfolioAccountMutationRequest) =>
    (
      await http.post<PortfolioAccountMutationResult>(
        `${accountPath(accountId)}/resume`,
        input,
      )
    ).data,
  combination: async (accountId: string) =>
    (
      await http.get<PortfolioCombination>(
        `${accountPath(accountId)}/strategies`,
      )
    ).data,
  saveDraft: async (accountId: string, input: PortfolioCombinationRequest) =>
    (
      await http.post<PortfolioCombinationDraft>(
        `${accountPath(accountId)}/strategies/draft`,
        input,
      )
    ).data,
  preview: async (accountId: string, input: PortfolioCombinationRequest) =>
    (
      await http.post<PortfolioCombinationPreview>(
        `${accountPath(accountId)}/strategies/preview`,
        input,
      )
    ).data,
  apply: async (accountId: string, input: ApplyPortfolioCombinationRequest) =>
    (
      await http.post<PortfolioAccountMutationResult>(
        `${accountPath(accountId)}/strategies/apply`,
        input,
      )
    ).data,
};
