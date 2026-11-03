import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { builderProfiles, builderProposals } from '../../database/schema';
import { LlmService } from '../multi-agent/llm.service';
import type {
  BuilderConfig,
  BuilderPreview,
  BuilderProfile,
  BuilderProposal,
  RecordBuilderFillDto,
  Market,
  Currency,
  PaperSide,
} from '@shared/api.interface';
import { normalizeBuilderConfig, validateManualFill } from './agent-builder.rules';
import { LocalAgentsService } from '../local-agents/local-agents.service';
import { LocalAgentError } from '../local-agents/local-agents.types';
import { LlmBudgetService } from '../llm-budget/llm-budget.service';
import { strategyOutbox } from '../../database/strategy.schema';

@Injectable()
export class AgentBuilderService {
  private readonly logger = new Logger(AgentBuilderService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly llm: LlmService,
    @Optional() private readonly localAgents?: LocalAgentsService,
    @Optional() private readonly budgets?: LlmBudgetService,
  ) {}

  async listProfiles(userId: string): Promise<BuilderProfile[]> {
    const rows = await this.db.select().from(builderProfiles)
      .where(eq(builderProfiles.owner, userId))
      .orderBy(desc(builderProfiles.createdAt));
    return rows.map((row) => this.mapProfile(row));
  }

  async getProfile(userId: string, id: string): Promise<BuilderProfile> {
    const [row] = await this.db.select().from(builderProfiles)
      .where(and(eq(builderProfiles.id, id), eq(builderProfiles.owner, userId)));
    if (!row) throw new NotFoundException('Agent profile not found');
    return this.mapProfile(row);
  }

  async getActiveProfile(userId: string): Promise<BuilderProfile | null> {
    const [row] = await this.db.select().from(builderProfiles)
      .where(and(eq(builderProfiles.owner, userId), eq(builderProfiles.status, 'active')));
    return row ? this.mapProfile(row) : null;
  }

  async createProfile(userId: string, input: BuilderConfig): Promise<BuilderProfile> {
    const config = this.validateConfig(input);
    const count = await this.listProfiles(userId);
    if (count.length >= 10) throw new BadRequestException('最多可保存 10 个 Agent 配置');
    const [row] = await this.db.insert(builderProfiles)
      .values({ owner: userId, config, status: 'draft' })
      .returning();
    return this.mapProfile(row);
  }

  async updateProfile(userId: string, id: string, input: BuilderConfig): Promise<BuilderProfile> {
    const config = this.validateConfig(input);
    const current = await this.getProfile(userId, id);
    if (current.status === 'active') {
      throw new BadRequestException('Pause the agent before editing its rules');
    }
    const [row] = await this.db.update(builderProfiles)
      .set({ config, version: current.version + 1, updatedAt: new Date() })
      .where(and(
        eq(builderProfiles.id, id),
        eq(builderProfiles.owner, userId),
        ne(builderProfiles.status, 'active'),
      ))
      .returning();
    if (!row) throw new BadRequestException('Agent state changed; reload and try again');
    return this.mapProfile(row);
  }

  async activateProfile(userId: string, id: string): Promise<BuilderProfile> {
    const current = await this.getProfile(userId, id);
    await this.assertCanActivate(userId, current.config);
    const row = await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(builderProfiles).where(and(eq(builderProfiles.id, id), eq(builderProfiles.owner, userId))).for('update');
      if (!locked || locked.version !== current.version) throw new BadRequestException('Agent changed during activation; reload and retry');
      if (locked.status === 'active') return locked;
      await tx.update(builderProfiles)
        .set({ status: 'paused', version: sql`${builderProfiles.version} + 1`, updatedAt: new Date() })
        .where(and(eq(builderProfiles.owner, userId), eq(builderProfiles.status, 'active')));
      const [updated] = await tx.update(builderProfiles)
        .set({ status: 'active', updatedAt: new Date() })
        .where(and(eq(builderProfiles.owner, userId), eq(builderProfiles.id, id)))
        .returning();
      return updated;
    });
    if (!row) throw new NotFoundException('Agent profile not found');
    return this.mapProfile(row);
  }

  async assertCanActivate(userId: string, config: BuilderConfig): Promise<void> {
    if (config.automation?.enabled) {
      if (!config.council?.enabled) throw new BadRequestException('Daily automation requires a research council');
      const reviewer = config.automation.fastReviewer;
      if (reviewer?.executionMode === 'local') {
        if (!this.localAgents || !reviewer.agentId) throw new BadRequestException('Fast reviewer unavailable');
        try { await this.localAgents.validate(userId, reviewer.agentId, reviewer.agentSettings); }
        catch { throw new BadRequestException('Connect the selected fast reviewer before activating'); }
      } else {
        await this.llm.validateConnectionIds(userId, reviewer?.connectionId ? [reviewer.connectionId] : []);
        if (!await this.llm.isConfigured(userId, reviewer?.connectionId)) {
          throw new BadRequestException('Configure a fast model or select a connected native fast reviewer');
        }
      }
    }
    if (config.council?.enabled) {
      const members = config.council.members;
      for (const member of members.filter((item) => item.executionMode === 'local')) {
        if (!this.localAgents || !member.agentId) throw new BadRequestException('Local agent unavailable');
        try { await this.localAgents.validate(userId, member.agentId, member.agentSettings); }
        catch (error) {
          if (error instanceof LocalAgentError) throw new BadRequestException(error.code);
          throw error;
        }
      }
      await this.llm.validateConnectionIds(userId, members.flatMap((member) => member.executionMode !== 'local' && member.connectionId ? [member.connectionId] : []));
      const configured = await Promise.all(members.map((member) => member.executionMode === 'local' ? true : this.llm.isConfigured(userId, member.connectionId)));
      if (configured.some((value) => !value)) throw new BadRequestException('Configure a model connection for every council member');
    } else if (config.customPrompt && !(await this.llm.isConfigured(userId))) {
      throw new BadRequestException('Configure a model for the council, or select basic rules mode');
    }
  }

  async pauseProfile(userId: string, id: string): Promise<BuilderProfile> {
    const row = await this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(builderProfiles).where(and(eq(builderProfiles.owner, userId), eq(builderProfiles.id, id))).for('update');
      if (!current) return undefined;
      if (current.status === 'paused') return current;
      const [updated] = await tx.update(builderProfiles).set({ status: 'paused',
        version: current.status === 'active' ? current.version + 1 : current.version, updatedAt: new Date() })
        .where(and(eq(builderProfiles.owner, userId), eq(builderProfiles.id, id))).returning();
      if (!updated) return undefined;
      const config = updated.config as BuilderConfig;
      if (config.automation?.enabled && config.notifyOnProposal) await tx.insert(strategyOutbox).values({
        owner: userId, profileId: id, eventKey: `strategy-paused:${id}:${updated.updatedAt.toISOString()}`,
        payload: { event: 'strategy_stopped', title: config.language === 'en' ? 'Automatic PAPER strategy paused' : '自动模拟策略已暂停',
          body: config.language === 'en' ? 'Monitoring stopped. No new automatic paper orders will be placed.' : '策略监控已停止，不再提交新的模拟订单。' },
      }).onConflictDoNothing();
      return updated;
    });
    if (!row) throw new NotFoundException('Agent profile not found');
    return this.mapProfile(row);
  }

  preview(input: BuilderConfig): BuilderPreview {
    const config = this.validateConfig(input);
    const canBuy = config.template !== 'guard';
    if (config.automation?.enabled) {
      const english = config.language === 'en';
      return { scenarios: [
        { key: 'daily-plan-trigger', result: canBuy ? 'paper' : 'block', explanation: english
          ? canBuy ? 'A validated daily plan can trigger a paper order after measured indicators, fast review and final hard risk checks pass.'
            : 'The guard template protects existing paper positions and never opens a new position.'
          : canBuy ? '已校验的每日策略触发后，真实指标、快速审核和最终硬风控均通过，才会执行模拟订单。'
            : '守护模板仅保护已有模拟持仓，不会新开仓。' },
        { key: 'review-wait', result: 'wait', explanation: english
          ? 'A fast-review wait or veto does not place an order. A wait can be reconsidered only within bounded retries using a newer quote.'
          : '快速审核等待或否决时不会下单；等待结果只有在更新报价和有限重试条件满足后才会重新审核。' },
        { key: 'protective-stop', result: 'paper', explanation: english
          ? 'A persisted position stop can exit without model review, while valid quotes, market sessions and sellable-share checks still apply.'
          : '已保存的持仓止损可跳过模型审核，但仍须通过有效报价、交易时段和可卖数量检查。' },
        { key: 'invalid-data', result: 'wait', explanation: english
          ? 'Missing or stale quotes, unverified calendars or unavailable entry indicators prevent new entries.'
          : '报价缺失或过期、交易日历未验证或开仓指标不可用时，系统等待，不会新开仓。' },
      ] };
    }
    return {
      scenarios: [
        ...(config.priceRules?.length ? [{
          key: 'price-trigger',
          result: (canBuy ? 'paper' : 'block') as 'paper' | 'block',
          explanation: canBuy
            ? 'A user-set price threshold can create a paper idea without an AI rating, subject to all safety limits.'
            : 'The guard template can only use sell triggers for existing paper positions.',
        }] : []),
        {
          key: 'rated-buy',
          result: canBuy ? 'paper' : 'block',
          explanation: canBuy
            ? `A qualifying rating can open a paper position up to ${config.maxOrderPct}% of equity.`
            : 'This template watches existing positions and never opens a new one.',
        },
        {
          key: 'stale-price',
          result: 'wait',
          explanation: 'Without a current quote, the agent waits; stored portfolio prices cannot trigger an order.',
        },
        {
          key: 'risk-limit',
          result: 'block',
          explanation: `The paper risk gate blocks an order past the configured ${config.dailyLossLimitPct}% daily loss limit.`,
        },
      ],
    };
  }

  async listProposals(userId: string): Promise<BuilderProposal[]> {
    const [pending, history] = await Promise.all([
      this.db.select().from(builderProposals)
        .where(and(eq(builderProposals.owner, userId), eq(builderProposals.status, 'pending')))
        .orderBy(desc(builderProposals.createdAt)),
      this.db.select().from(builderProposals)
        .where(and(eq(builderProposals.owner, userId), ne(builderProposals.status, 'pending')))
        .orderBy(desc(builderProposals.createdAt))
        .limit(100),
    ]);
    return [...pending, ...history]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((row) => this.mapProposal(row));
  }

  async hasDailyProposal(profileId: string, ticker: string, side: PaperSide): Promise<boolean> {
    const today = new Date().toISOString().slice(0, 10);
    const [row] = await this.db.select({ id: builderProposals.id }).from(builderProposals)
      .where(and(
        eq(builderProposals.profileId, profileId),
        eq(builderProposals.signalDate, today),
        eq(builderProposals.ticker, ticker),
        eq(builderProposals.side, side),
      ));
    return Boolean(row);
  }

  async skipProposal(userId: string, id: string): Promise<BuilderProposal> {
    const [row] = await this.db.update(builderProposals)
      .set({ status: 'skipped' })
      .where(and(
        eq(builderProposals.id, id),
        eq(builderProposals.owner, userId),
        eq(builderProposals.status, 'pending'),
      ))
      .returning();
    if (!row) throw new BadRequestException('Proposal is no longer pending');
    return this.mapProposal(row);
  }

  async recordFill(
    userId: string,
    id: string,
    input: RecordBuilderFillDto,
  ): Promise<BuilderProposal> {
    let fill: RecordBuilderFillDto;
    try {
      fill = validateManualFill(input);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    const [row] = await this.db.select().from(builderProposals)
      .where(and(eq(builderProposals.id, id), eq(builderProposals.owner, userId)));
    if (!row) throw new NotFoundException('Proposal not found');
    if (new Date(fill.executedAt) < row.createdAt) {
      throw new BadRequestException('Execution cannot precede the proposal');
    }
    const [updated] = await this.db.update(builderProposals)
      .set({
        status: 'recorded',
        executedAt: new Date(fill.executedAt),
        executedQuantity: String(fill.quantity),
        executedPrice: String(fill.price),
        executedFees: String(fill.fees),
        notes: fill.notes ?? null,
      })
      .where(and(
        eq(builderProposals.id, id),
        eq(builderProposals.owner, userId),
        eq(builderProposals.status, 'pending'),
      ))
      .returning();
    if (!updated) throw new BadRequestException('Proposal is no longer pending');
    return this.mapProposal(updated);
  }

  /** Optional AI review may veto a signal but cannot modify side or size. */
  async reviewSignal(
    userId: string,
    config: BuilderConfig,
    ticker: string,
    reason: string,
  ): Promise<string | null> {
    if (!config.customPrompt) return reason;
    try {
      const response = await this.llm.chatFastJSON([
        {
          role: 'system',
          content: 'Review a PAPER-trade idea. Return JSON {"decision":"approve"|"veto","reason":"short explanation"}. You may veto, but cannot change side, ticker or quantity. If uncertain, veto.',
        },
        {
          role: 'user',
          content: `Ticker: ${ticker}\nCandidate: ${reason}\nInvestor instructions: ${config.customPrompt}`,
        },
      ], userId, { taskId: `builder:${ticker}:${Date.now()}`, purpose: 'builder-review' });
      const data = response.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
      const decision = (data as Record<string, unknown>).decision;
      const explanation = (data as Record<string, unknown>).reason;
      if (decision !== 'approve') return null;
      return typeof explanation === 'string' && explanation.trim()
        ? `${reason}; AI review: ${explanation.trim().slice(0, 300)}`
        : reason;
    } catch (error) {
      this.logger.warn(`AI review failed for ${ticker}: ${String(error)}`);
      return null;
    }
  }

  private validateConfig(input: BuilderConfig): BuilderConfig {
    try {
      return normalizeBuilderConfig(input);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  private mapProfile(row: typeof builderProfiles.$inferSelect): BuilderProfile {
    return {
      id: row.id,
      config: normalizeBuilderConfig(row.config as BuilderConfig),
      status: row.status as BuilderProfile['status'],
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private mapProposal(row: typeof builderProposals.$inferSelect): BuilderProposal {
    return {
      id: row.id,
      profileId: row.profileId,
      profileVersion: row.profileVersion,
      ticker: row.ticker,
      market: row.market as Market,
      currency: row.currency as Currency,
      side: row.side as PaperSide,
      quantity: String(row.quantity),
      referencePrice: String(row.referencePrice),
      reason: row.reason,
      status: row.status as BuilderProposal['status'],
      paperOrderId: row.paperOrderId,
      executedAt: row.executedAt?.toISOString() ?? null,
      executedQuantity: row.executedQuantity === null ? null : String(row.executedQuantity),
      executedPrice: row.executedPrice === null ? null : String(row.executedPrice),
      executedFees: row.executedFees === null ? null : String(row.executedFees),
      notes: row.notes,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
