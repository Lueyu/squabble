import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { cashAccounts, holdings, paperAccounts, paperPositions } from '../../database/schema';
import { simulationCash } from '../../database/simulation-experiments.schema';
import type { HistoryPosition, MarkCash } from './portfolio-history.rules';

export interface HistoryPortfolio { accountId: string; name: string; kind: 'real' | 'simulation'; positions: HistoryPosition[]; cash: MarkCash[]; cashScopeKnown?: boolean }

@Injectable()
export class PortfolioHistoryHoldings {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async read(owner: string, selection?: string[]): Promise<HistoryPortfolio[]> {
    if (selection && (selection.length > 30 || selection.some(id => id !== 'real' && !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(id)))) {
      throw new BadRequestException('COMPARISON_ACCOUNTS_INVALID');
    }
    return this.db.transaction(async tx => {
      const [accounts, real, personalCash, simulated, nativeCash] = await Promise.all([
        tx.select().from(paperAccounts).where(eq(paperAccounts.owner, owner)).orderBy(asc(paperAccounts.createdAt), asc(paperAccounts.id)),
        tx.select().from(holdings).where(eq(holdings.owner, owner)),
        tx.select().from(cashAccounts).where(eq(cashAccounts.owner, owner)),
        tx.select().from(paperPositions).where(eq(paperPositions.owner, owner)),
        tx.select().from(simulationCash).where(eq(simulationCash.owner, owner)),
      ]);
      if (selection?.some(id => id !== 'real' && !accounts.some(account => account.id === id))) throw new NotFoundException('COMPARISON_ACCOUNT_NOT_FOUND');
      const portfolios: HistoryPortfolio[] = [];
      if (!selection || selection.includes('real')) portfolios.push({ accountId: 'real', name: 'Real portfolio', kind: 'real', positions: real,
        cash: personalCash.map(row => ({ currency: row.currency, balance: row.balance, known: row.reconciliationStatus === 'confirmed' })) });
      for (const account of accounts.filter(row => selection ? selection.includes(row.id) : row.isActive)) {
        portfolios.push({ accountId: account.id, name: account.name, kind: 'simulation', cashScopeKnown: account.ledgerMode === 'legacy_usd',
          positions: simulated.filter(position => position.accountId === account.id).map(position => {
            // Public saved price only; a copied position's acquisition cost is never treated as a current quote.
            const saved = real.find(row => row.ticker === position.ticker && row.market === position.market && row.currency === position.currency);
            return { ...position, currentPrice: saved?.currentPrice ?? null };
          }),
          cash: account.ledgerMode === 'legacy_usd' ? [{ currency: 'USD', balance: account.cashBalance, known: true }]
            : nativeCash.filter(row => row.accountId === account.id).map(row => ({ currency: row.currency,
              balance: String(Number(row.available) + Number(row.frozen) + Number(row.unsettled)), known: row.availabilityKnown })),
        });
      }
      return portfolios;
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
}
