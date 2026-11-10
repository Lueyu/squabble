import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { paperAccounts } from '../../database/schema';
import { investmentPolicies } from '../../database/investment-policy.schema';
import { strategyInterviews, strategyInterviewRequests } from '../../database/strategy-interviews.schema';
import { userInvestmentStrategies } from '../../database/user-investment-strategies.schema';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { UserInvestmentStrategyService, type UserStrategyTransaction } from './user-investment-strategy.service';
import { acceptInterviewSchema, answerInterviewSchema, createInterviewSchema, interviewIdSchema,
  parseInterviewInput, previewInterviewSchema } from './strategy-interview.dto';
import { acceptInterviewSuggestion, answerInterview, initialInterviewState, interviewDraft, interviewExamples } from './strategy-interview.rules';
import type { StrategyInterviewMutationInput, StrategyInterviewPreview, StrategyInterviewState, StrategyInterviewView } from '../../../shared/strategy-interview.interface';

type Row = typeof strategyInterviews.$inferSelect;
type Reader = Pick<PostgresJsDatabase, 'select'>;
type Result = StrategyInterviewView | StrategyInterviewPreview;
const inputHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Durable, owner/account-scoped authoring. This service has no model or execution dispatcher dependency. */
@Injectable()
export class StrategyInterviewService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly strategies: UserInvestmentStrategyService) {}

  private async account(db: Reader, owner: string, accountId: string, writing = false) {
    const query = db.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId)));
    const [account] = await (writing ? query.for('update') : query);
    if (!account) throw new NotFoundException('ACCOUNT_NOT_FOUND');
    const policies = db.select().from(investmentPolicies).where(and(eq(investmentPolicies.owner, owner), eq(investmentPolicies.accountId, accountId)));
    const [policy] = await (writing ? policies.for('update') : policies);
    if (!policy) throw new ConflictException('INTERVIEW_MANAGED_ACCOUNT_REQUIRED');
    if (writing && (!account.isActive || policy.status === 'archived')) throw new ConflictException('INTERVIEW_ACCOUNT_ARCHIVED');
    return { id: account.id, name: account.name, policyRevision: policy.revision,
      limits: { ...policy.effectiveConfig.limits }, timezone: policy.effectiveConfig.timezone };
  }

  private async row(db: Reader, owner: string, id: string, lock = false): Promise<Row> {
    parseInterviewInput(interviewIdSchema, id);
    const query = db.select().from(strategyInterviews).where(and(eq(strategyInterviews.owner, owner), eq(strategyInterviews.id, id)));
    const [row] = await (lock ? query.for('update') : query);
    if (!row) throw new NotFoundException('INTERVIEW_NOT_FOUND');
    return row;
  }

  private view(row: Row, account: StrategyInterviewView['account']): StrategyInterviewView {
    return { ...row.state, id: row.id, revision: row.revision, accountId: row.accountId, baseStrategyId: row.baseStrategyId,
      status: row.state.pending.length ? 'draft' : 'review_ready', account,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
  }

  private async receipt(db: Reader, owner: string, requestKey: string, hash: string): Promise<Result | null> {
    const [receipt] = await db.select().from(strategyInterviewRequests).where(and(eq(strategyInterviewRequests.owner, owner), eq(strategyInterviewRequests.requestKey, requestKey)));
    if (!receipt) return null;
    if (receipt.inputHash !== hash) throw new ConflictException('INTERVIEW_REQUEST_KEY_REUSED');
    return receipt.result;
  }

  async get(owner: string, id: string): Promise<StrategyInterviewView> {
    const row = await this.row(this.db, owner, id);
    return this.view(row, await this.account(this.db, owner, row.accountId));
  }

  /** Restore the exact saved review and derive its examples without creating a draft or changing observation intent. */
  async review(owner: string, id: string): Promise<StrategyInterviewPreview> {
    const interview = await this.get(owner, id);
    const review = interview.review;
    if (!review) throw new ConflictException('INTERVIEW_REVIEW_REQUIRED');
    const strategy = await this.strategies.get(owner, review.strategyId);
    if (review.interviewRevision !== interview.revision || strategy.revision !== review.strategyRevision
      || strategy.preview?.contentHash !== review.previewHash) throw new ConflictException('INTERVIEW_REVIEW_CHANGED');
    return { interview, strategy, examples: interviewExamples(strategy.content) };
  }

  async list(owner: string, accountId?: string): Promise<StrategyInterviewView[]> {
    if (accountId) {
      parseInterviewInput(interviewIdSchema, accountId);
      await this.account(this.db, owner, accountId);
    }
    const rows = await this.db.select().from(strategyInterviews).where(and(eq(strategyInterviews.owner, owner),
      accountId ? eq(strategyInterviews.accountId, accountId) : undefined)).orderBy(desc(strategyInterviews.updatedAt)).limit(50);
    const accounts = new Map<string, Awaited<ReturnType<StrategyInterviewService['account']>>>();
    for (const row of rows) if (!accounts.has(row.accountId)) accounts.set(row.accountId, await this.account(this.db, owner, row.accountId));
    return rows.map(row => this.view(row, accounts.get(row.accountId)!));
  }

  async create(owner: string, input: unknown): Promise<StrategyInterviewView> {
    const value = parseInterviewInput(createInterviewSchema, input);
    const hash = inputHash({ operation: 'create', ...value });
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const receipt = await this.receipt(tx, owner, value.requestKey, hash);
      if (receipt) return receipt as StrategyInterviewView;
      const account = await this.account(tx, owner, value.accountId, true);
      if (value.baseStrategyId) {
        const [base] = await tx.select().from(userInvestmentStrategies).where(and(eq(userInvestmentStrategies.owner, owner),
          eq(userInvestmentStrategies.id, value.baseStrategyId), isNull(userInvestmentStrategies.deletedAt)));
        if (!base || base.status !== 'confirmed') throw new BadRequestException('INTERVIEW_CONFIRMED_PARENT_REQUIRED');
      }
      const [row] = await tx.insert(strategyInterviews).values({ owner, accountId: value.accountId, baseStrategyId: value.baseStrategyId,
        state: initialInterviewState(value.message, new Date()) }).returning();
      const result = this.view(row, account);
      await tx.insert(strategyInterviewRequests).values({ owner, requestKey: value.requestKey, inputHash: hash, interviewId: row.id, result });
      return result;
    });
  }

  private async mutate<T extends Result>(owner: string, id: string, value: StrategyInterviewMutationInput, operation: string,
    change: (tx: UserStrategyTransaction, row: Row, account: Awaited<ReturnType<StrategyInterviewService['account']>>) => Promise<{ state: StrategyInterviewState; strategy?: StrategyInterviewPreview['strategy'] }>): Promise<T> {
    parseInterviewInput(interviewIdSchema, id);
    const hash = inputHash({ operation, id, ...value });
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const receipt = await this.receipt(tx, owner, value.requestKey, hash);
      if (receipt) return receipt as T;
      const row = await this.row(tx, owner, id, true);
      if (row.revision !== value.expectedRevision) throw new ConflictException('INTERVIEW_REVISION_CHANGED');
      const account = await this.account(tx, owner, row.accountId, true);
      if (row.state.review) {
        const [previous] = await tx.select().from(userInvestmentStrategies).where(and(eq(userInvestmentStrategies.owner, owner),
          eq(userInvestmentStrategies.id, row.state.review.strategyId))).for('share');
        if (previous?.status === 'confirmed' && previous.revision === row.state.review.strategyRevision) row.baseStrategyId = previous.id;
      }
      const changed = await change(tx, row, account);
      if (row.state.review) await this.strategies.invalidateInterviewPreviewInTransaction(tx, owner, row.state.review.strategyId, row.state.review.strategyRevision);
      const [saved] = await tx.update(strategyInterviews).set({ state: changed.state, baseStrategyId: row.baseStrategyId, revision: row.revision + 1, updatedAt: new Date() })
        .where(and(eq(strategyInterviews.owner, owner), eq(strategyInterviews.id, id))).returning();
      const interview = this.view(saved, account);
      const result = changed.strategy ? { interview, strategy: changed.strategy, examples: interviewExamples(changed.strategy.content) } : interview;
      await tx.insert(strategyInterviewRequests).values({ owner, requestKey: value.requestKey, inputHash: hash, interviewId: id, result });
      return result as T;
    });
  }

  async answer(owner: string, id: string, input: unknown): Promise<StrategyInterviewView> {
    const value = parseInterviewInput(answerInterviewSchema, input);
    return this.mutate(owner, id, value, 'answer', async (_tx, row, account) => {
      if (value.field !== row.state.currentQuestion?.field && !row.state.confirmed.some(answer => answer.field === value.field)
        && !row.state.suggestions.some(suggestion => suggestion.field === value.field)) {
        throw new ConflictException('INTERVIEW_QUESTION_CHANGED');
      }
      if (row.state.messages.filter(message => message.role === 'user').reduce((length, message) => length + message.text.length, 0) + value.message.length > 20000) {
        throw new BadRequestException('INTERVIEW_TEXT_LIMIT');
      }
      try { return { state: answerInterview(row.state, value.field, value.message, new Date(), account.timezone) }; }
      catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'INTERVIEW_ANSWER_INVALID'); }
    });
  }

  async accept(owner: string, id: string, input: unknown): Promise<StrategyInterviewView> {
    const value = parseInterviewInput(acceptInterviewSchema, input);
    return this.mutate(owner, id, value, 'accept', async (_tx, row) => {
      try { return { state: acceptInterviewSuggestion(row.state, value.suggestionId, new Date()) }; }
      catch { throw new ConflictException('INTERVIEW_SUGGESTION_CHANGED'); }
    });
  }

  async preview(owner: string, id: string, input: unknown): Promise<StrategyInterviewPreview> {
    const value = parseInterviewInput(previewInterviewSchema, input);
    return this.mutate(owner, id, value, 'preview', async (tx, row, account) => {
      let content;
      try { content = interviewDraft(row.state, account.limits, value.observationOnly === true, new Date()); }
      catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'INTERVIEW_PREVIEW_INVALID'); }
      const strategy = await this.strategies.createInterviewPreviewInTransaction(tx, owner, content, row.baseStrategyId ?? undefined);
      const state = { ...row.state, review: { strategyId: strategy.id, strategyRevision: strategy.revision,
        previewHash: strategy.preview!.contentHash, interviewRevision: row.revision + 1 } };
      return { state, strategy };
    });
  }
}
