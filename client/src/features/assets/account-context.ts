import { portfolioWorkspaceApi } from '@/api/portfolio-workspace';
import type { PortfolioAccountAssets } from '@shared/portfolio-workspace.interface';

export type AssetAccount = { kind: 'real'; id: 'real' } | { kind: 'paper'; id: string };

/** Only missing legacy parameters default to real. Explicit invalid targets stay invalid. */
export function readAssetAccount(search: string): AssetAccount {
  const values = new URLSearchParams(search).getAll('accountId');
  if (!values.length) return { kind: 'real', id: 'real' };
  if (values.length !== 1 || !values[0].trim()) throw new Error('INVALID_ACCOUNT_CONTEXT');
  return values[0] === 'real' ? { kind: 'real', id: 'real' } : { kind: 'paper', id: values[0] };
}

export function assetHref(path: string, id: string, search = ''): string {
  const params = new URLSearchParams(search);
  params.set('accountId', id);
  return `${path}?${params}`;
}

export const SIMULATION_ACCOUNTS_PATH = '/holdings/accounts';
export const FORMER_TEAM_ACCOUNTS_PATH = `${SIMULATION_ACCOUNTS_PATH}?status=former-team`;

export const holdingsHref = (id: string) => assetHref('/holdings', id);

/** No placeholder data: switching keys must immediately remove the previous account's rows. */
export function paperAssetsQueryOptions(
  accountId: string,
  read: (id: string) => Promise<PortfolioAccountAssets> = portfolioWorkspaceApi.assets,
) {
  return {
    queryKey: ['portfolio-assets', accountId] as const,
    queryFn: () => read(accountId),
    retry: false as const,
  };
}
