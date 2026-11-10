import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { builderProfiles, paperAccounts, paperSnapshots } from '../../database/schema';
import { investmentPolicies, investmentRequests } from '../../database/investment-policy.schema';
import { portfolioAccountCompanions, portfolioCombinationDrafts, portfolioCombinationPreviews, portfolioCombinationRevisions,
  portfolioStrategyAssignments } from '../../database/portfolio-workspace.schema';
import { strategyMandates } from '../../database/strategy-mandates.schema';
import { lockMemoryOwner } from '../research-memory/research-memory.fence';
import { SimpleCouncilService } from '../council/simple-council.service';
import { cancelInvestmentCandidates, expireInvestmentConstraints, InvestmentPolicyService, policyView,
  type InvestmentTx, type PolicyRow } from './investment-policy.service';
import { UserInvestmentStrategyService } from './user-investment-strategy.service';
import { effectiveInvestmentConfig } from './investment-policy.rules';
import { installInvestorCombinationMandate } from './user-strategy-runtime';
import { combinationHash, combinationIssues, workspaceCombinationSchema, workspaceCompanionSchema, workspaceHash, workspaceMutationSchema } from './portfolio-workspace.rules';
import type { PortfolioAccountDetail, PortfolioAccountSummary, PortfolioAllocationInput, PortfolioCombination,
  PortfolioCombinationPreview, PortfolioCompanionResult, PortfolioStrategyAssignment } from '../../../shared/portfolio-workspace.interface';

@Injectable()
export class PortfolioWorkspaceService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly policies: InvestmentPolicyService, private readonly strategies: UserInvestmentStrategyService,
    @Optional() private readonly reviewTeam?: SimpleCouncilService) {}

  private parse<T>(schema: z.ZodType<T>, input: unknown): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new BadRequestException({ code: 'INVALID_WORKSPACE_REQUEST', message: parsed.error.issues[0]?.message });
    return parsed.data;
  }
  private async account(owner: string, accountId: string) {
    if (!z.string().uuid().safeParse(accountId).success) throw new BadRequestException('INVALID_ACCOUNT_ID');
    const [account] = await this.db.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId)));
    if (!account) throw new NotFoundException('ACCOUNT_NOT_FOUND');
    return account;
  }
  private async current(tx: InvestmentTx, owner: string, accountId: string, revision: number) {
    const [account] = await tx.select().from(paperAccounts).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId))).for('update');
    if (!account) throw new NotFoundException('ACCOUNT_NOT_FOUND');
    const [raw] = await tx.select().from(investmentPolicies).where(and(eq(investmentPolicies.owner, owner), eq(investmentPolicies.accountId, accountId))).for('update');
    if (!raw) throw new ConflictException('ACCOUNT_REQUIRES_POLICY_ADOPTION');
    if (!account.isActive || raw.status === 'archived') throw new ConflictException('ARCHIVED_ACCOUNT_READ_ONLY');
    const policy = await expireInvestmentConstraints(tx, raw);
    if (policy.revision !== revision) throw new ConflictException('POLICY_REVISION_CHANGED');
    return { account, policy };
  }
  private async mutate<T>(owner: string, accountId: string, operation: string, request: { requestKey: string },
    action: (tx: InvestmentTx) => Promise<T>): Promise<T> {
    if (!z.string().uuid().safeParse(accountId).success) throw new BadRequestException('INVALID_ACCOUNT_ID');
    // Commit an independently elapsed constraint before checking the caller's
    // revision. A stale request must not roll expiry back and trap every retry.
    await this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      await tx.select({ id: paperAccounts.id }).from(paperAccounts)
        .where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId))).for('update');
      const [policy] = await tx.select().from(investmentPolicies)
        .where(and(eq(investmentPolicies.owner, owner), eq(investmentPolicies.accountId, accountId))).for('update');
      if (policy && policy.status !== 'archived') await expireInvestmentConstraints(tx, policy);
    });
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      // The same client key may safely be used on different accounts.
      const requestKey = `account:${accountId}:${request.requestKey}`;
      const requestHash = workspaceHash({ accountId, operation, request });
      const [prior] = await tx.select().from(investmentRequests).where(and(eq(investmentRequests.owner, owner), eq(investmentRequests.requestKey, requestKey)));
      if (prior) {
        if (prior.requestHash !== requestHash) throw new ConflictException('REQUEST_KEY_CONFLICT');
        return prior.result as T;
      }
      const result = await action(tx);
      await tx.insert(investmentRequests).values({ owner, requestKey, requestHash, operation, result: result as Record<string, unknown> });
      return result;
    });
  }
  async list(owner: string): Promise<PortfolioAccountSummary[]> {
    const [accounts, policies, snapshots, assignments, companions] = await Promise.all([
      this.db.select().from(paperAccounts).where(eq(paperAccounts.owner, owner)).orderBy(desc(paperAccounts.createdAt)),
      this.db.select().from(investmentPolicies).where(eq(investmentPolicies.owner, owner)),
      this.db.selectDistinctOn([paperSnapshots.accountId]).from(paperSnapshots).where(eq(paperSnapshots.owner, owner))
        .orderBy(paperSnapshots.accountId, desc(paperSnapshots.valuedAt), desc(paperSnapshots.snapshotDate)),
      this.db.select().from(portfolioStrategyAssignments).where(eq(portfolioStrategyAssignments.owner, owner)),
      this.db.select().from(portfolioAccountCompanions).where(eq(portfolioAccountCompanions.owner, owner)),
    ]);
    const colorOrder = [...accounts].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    return accounts.map(account => {
      const policy = policies.find(p => p.accountId === account.id);
      const companion = companions.find(item => item.accountId === account.id);
      return { id: account.id, colorIndex: colorOrder.findIndex(a => a.id === account.id), name: account.name, createdAt: account.createdAt.toISOString(),
        companionId: companion?.companionId ?? null, companionRevision: companion?.revision ?? 0,
        status: !account.isActive || policy?.status === 'archived' ? 'archived'
          : policy ? policy.status === 'running' ? 'running' : 'paused' : account.botEnabled ? 'running' : 'paused',
        policyRevision: policy?.revision ?? null, equityUsd: snapshots.find(s => s.accountId === account.id)?.equity ?? null,
        cashBalance: account.cashBalance, strategyCount: assignments.filter(a => a.accountId === account.id && a.enabled).length };
    });
  }
  async detail(owner: string, accountId: string): Promise<PortfolioAccountDetail> {
    await this.account(owner, accountId);
    const [accounts, investment, combination] = await Promise.all([
      this.list(owner), this.policies.overview(owner, accountId), this.combination(owner, accountId),
    ]);
    return { ...accounts.find(a => a.id === accountId)!, investment, combination };
  }
  async create(owner: string, input: unknown) {
    await this.policies.assertFeatureEnabled(owner);
    return this.policies.createAccount(owner, input);
  }
  /** Cosmetic preferences use their own revision and never advance strategy authority. */
  async setCompanion(owner: string, accountId: string, input: unknown): Promise<PortfolioCompanionResult> {
    const request = this.parse(workspaceCompanionSchema, input);
    if (!z.string().uuid().safeParse(accountId).success) throw new BadRequestException('INVALID_ACCOUNT_ID');
    return this.db.transaction(async tx => {
      await lockMemoryOwner(tx, owner);
      const [account] = await tx.select().from(paperAccounts)
        .where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId))).for('update');
      if (!account) throw new NotFoundException('ACCOUNT_NOT_FOUND');
      const requestKey = `companion:${accountId}:${request.requestKey}`;
      const requestHash = workspaceHash({ accountId, request });
      const [prior] = await tx.select().from(investmentRequests)
        .where(and(eq(investmentRequests.owner, owner), eq(investmentRequests.requestKey, requestKey)));
      if (prior) {
        if (prior.requestHash !== requestHash) throw new ConflictException('REQUEST_KEY_CONFLICT');
        return prior.result as unknown as PortfolioCompanionResult;
      }
      const [policy] = await tx.select({ status: investmentPolicies.status }).from(investmentPolicies)
        .where(and(eq(investmentPolicies.owner, owner), eq(investmentPolicies.accountId, accountId)));
      if (!account.isActive || policy?.status === 'archived') throw new ConflictException('ARCHIVED_ACCOUNT_READ_ONLY');
      const [current] = await tx.select().from(portfolioAccountCompanions)
        .where(and(eq(portfolioAccountCompanions.owner, owner), eq(portfolioAccountCompanions.accountId, accountId)));
      if ((current?.revision ?? 0) !== request.expectedRevision) throw new ConflictException('COMPANION_REVISION_CHANGED');
      const value = { owner, accountId, companionId: request.companionId, revision: request.expectedRevision + 1, updatedAt: new Date() };
      await tx.insert(portfolioAccountCompanions).values(value).onConflictDoUpdate({
        target: [portfolioAccountCompanions.owner, portfolioAccountCompanions.accountId], set: value,
      });
      const result = { accountId, companionId: value.companionId, companionRevision: value.revision };
      await tx.insert(investmentRequests).values({ owner, requestKey, requestHash, operation: 'companion', result });
      return result;
    });
  }
  async combination(owner: string, accountId: string): Promise<PortfolioCombination> {
    await this.account(owner, accountId);
    const [policies, drafts, allocations] = await Promise.all([
      this.db.select().from(investmentPolicies).where(and(eq(investmentPolicies.owner, owner), eq(investmentPolicies.accountId, accountId))),
      this.db.select().from(portfolioCombinationDrafts).where(and(eq(portfolioCombinationDrafts.owner, owner), eq(portfolioCombinationDrafts.accountId, accountId))),
      this.db.select().from(portfolioStrategyAssignments).where(and(eq(portfolioStrategyAssignments.owner, owner), eq(portfolioStrategyAssignments.accountId, accountId))),
    ]);
    return { accountId, policyRevision: policies[0]?.revision ?? 0,
      allocations: allocations.map(a => ({ strategyId: a.strategyId, strategyRevision: a.strategyRevision, allocationPct: Number(a.allocationPct), enabled: a.enabled, snapshot: a.snapshot })),
      draft: drafts[0] ? { allocations: drafts[0].allocations, expectedPolicyRevision: drafts[0].expectedPolicyRevision, updatedAt: drafts[0].updatedAt.toISOString() } : null,
      cashFloorPct: policies[0]?.effectiveConfig.limits.minCashPct ?? 0 };
  }
  async saveDraft(owner: string, accountId: string, input: unknown) {
    const request = this.parse(workspaceCombinationSchema, input);
    return this.mutate(owner, accountId, 'draft', request, async tx => {
      await this.current(tx, owner, accountId, request.expectedPolicyRevision);
      for (const allocation of request.allocations) {
        const strategy = await this.strategies.get(owner, allocation.strategyId);
        if (strategy.revision !== allocation.strategyRevision) throw new ConflictException('STRATEGY_REVISION_CHANGED');
      }
      const updatedAt = new Date();
      const value = { owner, accountId, allocations: request.allocations, expectedPolicyRevision: request.expectedPolicyRevision, updatedAt };
      await tx.insert(portfolioCombinationDrafts).values(value).onConflictDoUpdate({
        target: [portfolioCombinationDrafts.owner, portfolioCombinationDrafts.accountId], set: value,
      });
      return { allocations: request.allocations, expectedPolicyRevision: request.expectedPolicyRevision, updatedAt: updatedAt.toISOString() };
    });
  }
  private async snapshots(tx: InvestmentTx, owner: string, allocations: PortfolioAllocationInput[], confirm = false): Promise<PortfolioStrategyAssignment[]> {
    const result: PortfolioStrategyAssignment[] = [];
    for (const allocation of allocations) result.push({ ...allocation,
      snapshot: await this.strategies.accountSnapshot(tx, owner, allocation.strategyId, allocation.strategyRevision, confirm) });
    return result;
  }
  async preview(owner: string, accountId: string, input: unknown): Promise<PortfolioCombinationPreview> {
    const request = this.parse(workspaceCombinationSchema, input);
    return this.mutate(owner, accountId, 'preview', request, async tx => {
      const { policy } = await this.current(tx, owner, accountId, request.expectedPolicyRevision);
      const allocations = await this.snapshots(tx, owner, request.allocations);
      const issues = combinationIssues(allocations);
      const effective = effectiveInvestmentConfig({ ...policy.baseConfig, portfolio: allocations }, policy.constraintRecords);
      const previewHash = combinationHash(accountId, policy.revision, allocations);
      const expiresAt = new Date(Date.now() + 15 * 60_000);
      await tx.insert(portfolioCombinationPreviews).values({ owner, accountId, policyRevision: policy.revision, allocations, previewHash, expiresAt });
      return { accountId, expectedPolicyRevision: policy.revision, previewHash, expiresAt: expiresAt.toISOString(),
        canApply: issues.length === 0, allocations, issues, cashFloorPct: effective.limits.minCashPct,
        allocatedPct: allocations.filter(a => a.enabled).reduce((sum, a) => sum + a.allocationPct, 0) };
    });
  }
  async apply(owner: string, accountId: string, input: unknown) {
    await this.policies.assertFeatureEnabled(owner);
    const hashInput = this.parse(z.object({ previewHash: z.string().length(64) }).passthrough(), input);
    const { previewHash, ...body } = hashInput;
    const request = { ...this.parse(workspaceCombinationSchema, body), previewHash };
    const reviewers = await this.reviewTeam?.resolveMembers(owner).catch(() => null);
    return this.mutate(owner, accountId, 'apply', request, async tx => {
      const { policy } = await this.current(tx, owner, accountId, request.expectedPolicyRevision);
      const [preview] = await tx.select().from(portfolioCombinationPreviews).where(and(eq(portfolioCombinationPreviews.owner, owner),
        eq(portfolioCombinationPreviews.accountId, accountId), eq(portfolioCombinationPreviews.previewHash, request.previewHash)))
        .orderBy(desc(portfolioCombinationPreviews.createdAt)).limit(1).for('update');
      if (!preview || preview.expiresAt.getTime() <= Date.now()) throw new ConflictException('COMBINATION_PREVIEW_EXPIRED');
      const allocations = await this.snapshots(tx, owner, request.allocations, true);
      if (combinationHash(accountId, policy.revision, allocations) !== request.previewHash) throw new ConflictException('COMBINATION_PREVIEW_CHANGED');
      const issues = combinationIssues(allocations);
      if (issues.length) throw new ConflictException({ code: 'COMBINATION_CONFLICT', message: 'COMBINATION_CONFLICT', issues });
      await cancelInvestmentCandidates(tx, owner, accountId, 'Account strategy combination changed');
      const running = allocations.some(a => a.enabled);
      const baseConfig = { ...policy.baseConfig, portfolio: allocations,
        ...(reviewers?.members.length ? { reviewMembers: reviewers.members } : {}) };
      delete baseConfig.userStrategy;
      const [saved] = await tx.update(investmentPolicies).set({ revision: policy.revision + 1, status: running ? 'running' : 'paused',
        baseConfig, effectiveConfig: effectiveInvestmentConfig(baseConfig, policy.constraintRecords), updatedAt: new Date() })
        .where(eq(investmentPolicies.id, policy.id)).returning();
      await tx.delete(portfolioStrategyAssignments).where(and(eq(portfolioStrategyAssignments.owner, owner), eq(portfolioStrategyAssignments.accountId, accountId)));
      if (allocations.length) await tx.insert(portfolioStrategyAssignments).values(allocations.map(a => ({ ...a,
        owner, accountId, allocationPct: String(a.allocationPct), policyRevision: saved.revision })));
      await tx.insert(portfolioCombinationRevisions).values({ owner, accountId, policyRevision: saved.revision, allocations });
      await tx.delete(portfolioCombinationDrafts).where(and(eq(portfolioCombinationDrafts.owner, owner), eq(portfolioCombinationDrafts.accountId, accountId)));
      await this.setRuntime(tx, owner, saved, running);
      return { accountId, status: saved.status as 'running' | 'paused', policy: policyView(saved) };
    });
  }
  private async setRuntime(tx: InvestmentTx, owner: string, policy: PolicyRow, running: boolean) {
    await tx.update(paperAccounts).set({ botEnabled: running, updatedAt: new Date() }).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, policy.accountId)));
    await tx.update(strategyMandates).set({ status: 'paused', updatedAt: new Date() }).where(and(eq(strategyMandates.owner, owner), eq(strategyMandates.accountId, policy.accountId), eq(strategyMandates.status, 'published')));
    await tx.update(builderProfiles).set({ status: 'paused', updatedAt: new Date() }).where(and(eq(builderProfiles.owner, owner), eq(builderProfiles.accountId, policy.accountId), eq(builderProfiles.status, 'active')));
    if (running) await installInvestorCombinationMandate(tx, owner, policy, policy.baseConfig.portfolio ?? []);
  }
  async switchStatus(owner: string, accountId: string, input: unknown, running: boolean) {
    if (running) await this.policies.assertFeatureEnabled(owner);
    const request = this.parse(workspaceMutationSchema, input);
    return this.mutate(owner, accountId, running ? 'resume' : 'pause', request, async tx => {
      const { policy } = await this.current(tx, owner, accountId, request.expectedPolicyRevision);
      if (running && !policy.baseConfig.portfolio?.some(a => a.enabled)) throw new ConflictException('CONFIRMED_STRATEGY_REQUIRED');
      if (running) await this.snapshots(tx, owner, policy.baseConfig.portfolio ?? []);
      await cancelInvestmentCandidates(tx, owner, accountId, running ? 'Fresh account evaluation required' : 'All account automation paused, including protective orders');
      const [saved] = await tx.update(investmentPolicies).set({ status: running ? 'running' : 'paused', revision: policy.revision + 1, updatedAt: new Date() })
        .where(eq(investmentPolicies.id, policy.id)).returning();
      await this.setRuntime(tx, owner, saved, running);
      return { accountId, status: saved.status as 'running' | 'paused', policy: policyView(saved) };
    });
  }
  async rename(owner: string, accountId: string, input: unknown) {
    const request = this.parse(workspaceMutationSchema.extend({ name: z.string().trim().min(1).max(80) }).strict(), input);
    return this.mutate(owner, accountId, 'rename', request, async tx => {
      const { policy } = await this.current(tx, owner, accountId, request.expectedPolicyRevision);
      await tx.update(paperAccounts).set({ name: request.name, updatedAt: new Date() }).where(and(eq(paperAccounts.owner, owner), eq(paperAccounts.id, accountId)));
      // Names do not change execution authority or invalidate in-flight candidates.
      return { accountId, status: policy.status as 'running' | 'paused', policy: policyView(policy) };
    });
  }
}
