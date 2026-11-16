/**
 * agent-builder.service.ts — agent builder 的配置档案与候选提案服务。
 *
 * 职责边界：
 *  - 管理 builderProfiles（配置 CRUD/激活/暂停）与 builderProposals（候选提案的
 *    生命周期：pending → skipped/recorded），并执行配置可激活性校验与可选的 AI 复核。
 *  - 不做信号计算（decideBuilderSignal 在 agent-builder.rules.ts）、
 *    不做实际下单（由 PaperTradingService 完成）、不做节流（BuilderCadenceService）。
 * 上下游：
 *  - 上游（谁调用本服务）：AgentBuilderController（HTTP 路由）、BotScheduler/paper-trading 扫描链路。
 *  - 下游（本文件调用谁）：Drizzle 数据库（builderProfiles/builderProposals）、
 *    agent-builder.rules 的 normalizeBuilderConfig/validateManualFill、
 *    LlmService（连接校验与 AI 复核）、LocalAgentsService（本地 agent 校验，可选注入）、
 *    LlmBudgetService（可选注入）。
 * 关键约定：
 *  - 数量/价格/费用在 DB 侧为 numeric，API 侧统一转为字符串数值（String(...)）——
 *    单位为交易币种原值（非分），浮点仅用于计算、存储用字符串承载。
 *  - 激活是"单活跃"语义：同一 owner 同时至多一个 active 配置（事务内先降级旧的再激活新的）。
 *  - AI 复核（reviewSignal）只能否决信号，不能修改方向、标的或数量。
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { and, desc, eq, ne } from 'drizzle-orm';
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

@Injectable()
export class AgentBuilderService {
  private readonly logger = new Logger(AgentBuilderService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly llm: LlmService,
    @Optional() private readonly localAgents?: LocalAgentsService,
    @Optional() private readonly budgets?: LlmBudgetService,
  ) {}

  /**
   * listProfiles — 列出当前用户的全部 agent 配置档案（按创建时间倒序）。
   *
   * @param userId 用户 id。
   * @returns BuilderProfile 数组。
   */
  async listProfiles(userId: string): Promise<BuilderProfile[]> {
    const rows = await this.db
      .select()
      .from(builderProfiles)
      .where(eq(builderProfiles.owner, userId))
      .orderBy(desc(builderProfiles.createdAt));
    return rows.map((row) => this.mapProfile(row));
  }

  /**
   * getProfile — 读取指定配置档案（归属校验：不属于该用户视为不存在）。
   *
   * @param userId 用户 id。
   * @param id     配置档案 id。
   * @returns BuilderProfile。
   * @throws NotFoundException 当档案不存在或不属于该用户时。
   */
  async getProfile(userId: string, id: string): Promise<BuilderProfile> {
    const [row] = await this.db
      .select()
      .from(builderProfiles)
      .where(and(eq(builderProfiles.id, id), eq(builderProfiles.owner, userId)));
    if (!row) throw new NotFoundException('Agent profile not found');
    return this.mapProfile(row);
  }

  /**
   * getActiveProfile — 读取当前用户唯一处于激活态的配置档案。
   *
   * @param userId 用户 id。
   * @returns 激活中的 BuilderProfile；无则 null。
   */
  async getActiveProfile(userId: string): Promise<BuilderProfile | null> {
    const [row] = await this.db
      .select()
      .from(builderProfiles)
      .where(and(eq(builderProfiles.owner, userId), eq(builderProfiles.status, 'active')));
    return row ? this.mapProfile(row) : null;
  }

  /**
   * createProfile — 新建配置档案（初始状态 draft，每用户至多 10 份）。
   *
   * @param userId 用户 id。
   * @param input  原始 BuilderConfig。
   * @returns 新建的 BuilderProfile。
   * @throws BadRequestException 当配置非法或数量超上限（"最多可保存 10 个 Agent 配置"）时。
   */
  async createProfile(userId: string, input: BuilderConfig): Promise<BuilderProfile> {
    const config = this.validateConfig(input);
    // 每用户至多 10 份配置。
    const count = await this.listProfiles(userId);
    if (count.length >= 10) throw new BadRequestException('最多可保存 10 个 Agent 配置');
    const [row] = await this.db
      .insert(builderProfiles)
      .values({ owner: userId, config, status: 'draft' })
      .returning();
    return this.mapProfile(row);
  }

  /**
   * updateProfile — 更新配置并递增版本号（激活中的配置必须先暂停才能修改）。
   *
   * 更新带 status != 'active' 的条件写保护，状态在读取后被并发改变时返回冲突错误。
   *
   * @param userId 用户 id。
   * @param id     配置档案 id。
   * @param input  原始 BuilderConfig。
   * @returns 更新后的 BuilderProfile。
   * @throws BadRequestException 当配置非法、当前为激活态，或状态并发变化时。
   */
  async updateProfile(userId: string, id: string, input: BuilderConfig): Promise<BuilderProfile> {
    const config = this.validateConfig(input);
    // 激活中的配置不允许直接改规则。
    const current = await this.getProfile(userId, id);
    if (current.status === 'active') {
      throw new BadRequestException('Pause the agent before editing its rules');
    }
    // 条件更新：status != 'active'，防止读取-更新之间的并发激活。
    const [row] = await this.db
      .update(builderProfiles)
      .set({ config, version: current.version + 1, updatedAt: new Date() })
      .where(
        and(
          eq(builderProfiles.id, id),
          eq(builderProfiles.owner, userId),
          ne(builderProfiles.status, 'active'),
        ),
      )
      .returning();
    if (!row) throw new BadRequestException('Agent state changed; reload and try again');
    return this.mapProfile(row);
  }

  /**
   * activateProfile — 激活指定配置（单活跃语义，事务内完成）。
   *
   * 先把该用户现有的 active 配置全部降级为 paused，再把目标配置置为 active。
   *
   * @param userId 用户 id。
   * @param id     要激活的配置档案 id。
   * @returns 激活后的 BuilderProfile。
   * @throws NotFoundException 当档案不存在或激活事务未命中时。
   */
  async activateProfile(userId: string, id: string): Promise<BuilderProfile> {
    const current = await this.getProfile(userId, id);
    await this.assertCanActivate(userId, current.config);
    // 单活跃切换：先降级所有 active，再激活目标配置。
    const row = await this.db.transaction(async (tx) => {
      await tx
        .update(builderProfiles)
        .set({ status: 'paused', updatedAt: new Date() })
        .where(and(eq(builderProfiles.owner, userId), eq(builderProfiles.status, 'active')));
      const [updated] = await tx
        .update(builderProfiles)
        .set({ status: 'active', updatedAt: new Date() })
        .where(and(eq(builderProfiles.owner, userId), eq(builderProfiles.id, id)))
        .returning();
      return updated;
    });
    if (!row) throw new NotFoundException('Agent profile not found');
    return this.mapProfile(row);
  }

  /**
   * assertCanActivate — 激活前的可执行性校验。
   *
   * 委员会模式：逐个校验本地 agent（validate）、模型连接 id 与每个成员的连接可用性；
   * 非委员会模式（仅 customPrompt）：要求已配置默认模型。
   *
   * @param userId 用户 id。
   * @param config 目标 BuilderConfig。
   * @throws BadRequestException 当本地 agent 不可用/校验失败、连接未配置时。
   */
  async assertCanActivate(userId: string, config: BuilderConfig): Promise<void> {
    if (config.council?.enabled) {
      const members = config.council.members;
      // 本地执行成员：逐个验证 agent 可用性。
      for (const member of members.filter((item) => item.executionMode === 'local')) {
        if (!this.localAgents || !member.agentId)
          throw new BadRequestException('Local agent unavailable');
        try {
          await this.localAgents.validate(userId, member.agentId, member.agentSettings);
        } catch (error) {
          if (error instanceof LocalAgentError) throw new BadRequestException(error.code);
          throw error;
        }
      }
      // 模型连接 id 统一交给 LlmService 校验。
      await this.llm.validateConnectionIds(
        userId,
        members.flatMap((member) =>
          member.executionMode !== 'local' && member.connectionId ? [member.connectionId] : [],
        ),
      );
      // 每个非本地成员都必须有可用的模型连接。
      const configured = await Promise.all(
        members.map((member) =>
          member.executionMode === 'local'
            ? true
            : this.llm.isConfigured(userId, member.connectionId),
        ),
      );
      if (configured.some((value) => !value))
        throw new BadRequestException('Configure a model connection for every council member');
    } else if (config.customPrompt && !(await this.llm.isConfigured(userId))) {
      // 非委员会模式但写了自定义指令：要求已配置默认模型。
      throw new BadRequestException(
        'Configure a model for the council, or select basic rules mode',
      );
    }
  }

  /**
   * pauseProfile — 把指定配置置为 paused。
   *
   * @param userId 用户 id。
   * @param id     配置档案 id。
   * @returns 暂停后的 BuilderProfile。
   * @throws NotFoundException 当档案不存在或不属于该用户时。
   */
  async pauseProfile(userId: string, id: string): Promise<BuilderProfile> {
    const [row] = await this.db
      .update(builderProfiles)
      .set({ status: 'paused', updatedAt: new Date() })
      .where(and(eq(builderProfiles.owner, userId), eq(builderProfiles.id, id)))
      .returning();
    if (!row) throw new NotFoundException('Agent profile not found');
    return this.mapProfile(row);
  }

  /**
   * preview — 展示配置在若干典型场景下的行为预览（不落库）。
   *
   * 场景：价格触发（guard 模板阻止买入）、评级买入、行情过期等待、风控拦截。
   *
   * @param input 原始 BuilderConfig。
   * @returns `{ scenarios: [...] }`（result 为 paper/block/wait，explanation 为英文文案）。
   */
  preview(input: BuilderConfig): BuilderPreview {
    const config = this.validateConfig(input);
    // guard 模板只卖不买，其余模板可买。
    const canBuy = config.template !== 'guard';
    return {
      scenarios: [
        ...(config.priceRules?.length
          ? [
              {
                key: 'price-trigger',
                result: (canBuy ? 'paper' : 'block') as 'paper' | 'block',
                explanation: canBuy
                  ? 'A user-set price threshold can create a paper idea without an AI rating, subject to all safety limits.'
                  : 'The guard template can only use sell triggers for existing paper positions.',
              },
            ]
          : []),
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
          explanation:
            'Without a current quote, the agent waits; stored portfolio prices cannot trigger an order.',
        },
        {
          key: 'risk-limit',
          result: 'block',
          explanation: `The paper risk gate blocks an order past the configured ${config.dailyLossLimitPct}% daily loss limit.`,
        },
      ],
    };
  }

  /**
   * listProposals — 列出当前用户的提案：全部 pending + 最近 100 条历史，按时间倒序合并。
   *
   * @param userId 用户 id。
   * @returns BuilderProposal 数组（pending 在前，整体按 createdAt 倒序）。
   */
  async listProposals(userId: string): Promise<BuilderProposal[]> {
    // 并行取：未处理的全部 + 非 pending 的最近 100 条。
    const [pending, history] = await Promise.all([
      this.db
        .select()
        .from(builderProposals)
        .where(and(eq(builderProposals.owner, userId), eq(builderProposals.status, 'pending')))
        .orderBy(desc(builderProposals.createdAt)),
      this.db
        .select()
        .from(builderProposals)
        .where(and(eq(builderProposals.owner, userId), ne(builderProposals.status, 'pending')))
        .orderBy(desc(builderProposals.createdAt))
        .limit(100),
    ]);
    return [...pending, ...history]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((row) => this.mapProposal(row));
  }

  /**
   * hasDailyProposal — 判断某配置今日（UTC 日期）是否已就 (ticker, side) 产生过提案。
   *
   * @param profileId 配置档案 id。
   * @param ticker    标的代码。
   * @param side      买卖方向。
   * @returns 已存在返回 true。
   */
  async hasDailyProposal(profileId: string, ticker: string, side: PaperSide): Promise<boolean> {
    const today = new Date().toISOString().slice(0, 10);
    const [row] = await this.db
      .select({ id: builderProposals.id })
      .from(builderProposals)
      .where(
        and(
          eq(builderProposals.profileId, profileId),
          eq(builderProposals.signalDate, today),
          eq(builderProposals.ticker, ticker),
          eq(builderProposals.side, side),
        ),
      );
    return Boolean(row);
  }

  /**
   * skipProposal — 把一条 pending 提案标记为 skipped。
   *
   * @param userId 用户 id。
   * @param id     提案 id。
   * @returns 更新后的 BuilderProposal。
   * @throws BadRequestException 当提案已不存在 pending 状态时。
   */
  async skipProposal(userId: string, id: string): Promise<BuilderProposal> {
    const [row] = await this.db
      .update(builderProposals)
      .set({ status: 'skipped' })
      .where(
        and(
          eq(builderProposals.id, id),
          eq(builderProposals.owner, userId),
          eq(builderProposals.status, 'pending'),
        ),
      )
      .returning();
    if (!row) throw new BadRequestException('Proposal is no longer pending');
    return this.mapProposal(row);
  }

  /**
   * recordFill — 为 pending 提案登记人工成交（进入对照台账）。
   *
   * 先经 validateManualFill 校验自报成交，再确认提案存在、成交时间不早于提案创建时间，
   * 最后条件更新（仅 pending）写入执行数量/价格/费用与备注。
   *
   * @param userId 用户 id。
   * @param id     提案 id。
   * @param input  用户自报的成交载荷。
   * @returns 更新后的 BuilderProposal（status=recorded）。
   * @throws BadRequestException 当载荷非法、成交早于提案、或提案已非 pending 时。
   * @throws NotFoundException   当提案不存在或不属于该用户时。
   */
  async recordFill(
    userId: string,
    id: string,
    input: RecordBuilderFillDto,
  ): Promise<BuilderProposal> {
    // 载荷校验失败统一转 400。
    let fill: RecordBuilderFillDto;
    try {
      fill = validateManualFill(input);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    const [row] = await this.db
      .select()
      .from(builderProposals)
      .where(and(eq(builderProposals.id, id), eq(builderProposals.owner, userId)));
    if (!row) throw new NotFoundException('Proposal not found');
    // 成交时间不能早于提案创建时间。
    if (new Date(fill.executedAt) < row.createdAt) {
      throw new BadRequestException('Execution cannot precede the proposal');
    }
    // 数量/价格/费用入 numeric 列时转字符串（DB numeric ↔ API 字符串数值约定）。
    const [updated] = await this.db
      .update(builderProposals)
      .set({
        status: 'recorded',
        executedAt: new Date(fill.executedAt),
        executedQuantity: String(fill.quantity),
        executedPrice: String(fill.price),
        executedFees: String(fill.fees),
        notes: fill.notes ?? null,
      })
      .where(
        and(
          eq(builderProposals.id, id),
          eq(builderProposals.owner, userId),
          eq(builderProposals.status, 'pending'),
        ),
      )
      .returning();
    if (!updated) throw new BadRequestException('Proposal is no longer pending');
    return this.mapProposal(updated);
  }

  /**
   * reviewSignal — 可选的 AI 复核：只能否决信号，不能修改方向或数量。
   *
   * 无 customPrompt 时直接放行原 reason；配置了 customPrompt 时调用 LLM 快速 JSON 复核，
   * decision=approve 时把解释（截断 300 字符）拼回 reason，否则返回 null（否决）。
   * LLM 调用失败视为否决（返回 null）并记 warn 日志。
   *
   * @param userId  用户 id。
   * @param config  配置（读取 customPrompt）。
   * @param ticker  标的代码。
   * @param reason  规则层给出的候选理由。
   * @returns 通过后的理由；被否决或复核失败返回 null。
   */
  async reviewSignal(
    userId: string,
    config: BuilderConfig,
    ticker: string,
    reason: string,
  ): Promise<string | null> {
    // 未配置自定义指令：不做 AI 复核，直接放行。
    if (!config.customPrompt) return reason;
    try {
      const response = await this.llm.chatFastJSON(
        [
          {
            role: 'system',
            content:
              'Review a PAPER-trade idea. Return JSON {"decision":"approve"|"veto","reason":"short explanation"}. You may veto, but cannot change side, ticker or quantity. If uncertain, veto.',
          },
          {
            role: 'user',
            content: `Ticker: ${ticker}\nCandidate: ${reason}\nInvestor instructions: ${config.customPrompt}`,
          },
        ],
        userId,
        { taskId: `builder:${ticker}:${Date.now()}`, purpose: 'builder-review' },
      );
      const data = response.data;
      // 响应不是对象视为否决。
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
      const decision = (data as Record<string, unknown>).decision;
      const explanation = (data as Record<string, unknown>).reason;
      if (decision !== 'approve') return null;
      return typeof explanation === 'string' && explanation.trim()
        ? `${reason}; AI review: ${explanation.trim().slice(0, 300)}`
        : reason;
    } catch (error) {
      // 复核失败视为否决，不阻塞扫描。
      this.logger.warn(`AI review failed for ${ticker}: ${String(error)}`);
      return null;
    }
  }

  /**
   * validateConfig — 内部统一入口：规则校验失败转 BadRequestException。
   *
   * @param input 原始 BuilderConfig。
   * @returns 规范化后的 BuilderConfig。
   * @throws BadRequestException（保留原始错误文案）。
   */
  private validateConfig(input: BuilderConfig): BuilderConfig {
    try {
      return normalizeBuilderConfig(input);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * mapProfile — DB 行 → API 的 BuilderProfile（config 重新走一遍规范化）。
   *
   * @param row builderProfiles 查询行。
   * @returns BuilderProfile（时间转 ISO 字符串）。
   */
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

  /**
   * mapProposal — DB 行 → API 的 BuilderProposal。
   *
   * DB numeric 列（quantity/referencePrice/executed*）在 API 层统一转字符串数值。
   *
   * @param row builderProposals 查询行。
   * @returns BuilderProposal（时间转 ISO 字符串，NULL 归一为 null）。
   */
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
