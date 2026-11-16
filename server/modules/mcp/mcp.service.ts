/**
 * mcp.service.ts — MCP (Model Context Protocol) 服务实现。
 *
 * 职责边界：
 *  - MCP Streamable HTTP 传输：单一 POST 端点接收 JSON-RPC 2.0 消息，实现客户端所需的最小面：
 *    initialize → tools/list → tools/call。
 *  - 每次 tools/call 都针对一个智能体会话（Bearer token）鉴权，并受该会话的
 *    permission（只读/交易）、dailyLimitUsd（日限额）与 approvalMode（审批模式）约束。
 *  - 暴露 6 个工具：get_portfolio（模拟盘概览）、get_quotes（实时行情）、get_research_report（最新深度报告）、
 *    place_paper_order（受控下单）、list_orders（最近订单）、import_holdings（导入持仓）。
 *  - 会话 CRUD 属于面向用户的 API，不属于 MCP 协议本体。
 * 上下游：
 *  - 上游：McpController（POST /mcp 与会话管理路由）、外部 MCP 客户端。
 *  - 下游：PaperTradingService（下单/概览）、QuoteService（行情）、ImportService（导入持仓）、agentSessions/paperOrders/deepReport 表。
 * 关键约定：
 *  - token 形态 sq-<24 字节 hex>，仅在创建响应中出现一次；撤回会话即失效。
 *  - 下单权限 permission==='trade'；买入金额粗校验为 日限额×10 的上限护栏，真实限额检查在 placeOrder 风控内。
 *  - 行情最多 20 只；订单列表 1–50 条（默认 10）。
 */
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { agentSessions, deepReport, paperOrders } from '../../database/schema';
import { PaperTradingService } from '../paper-trading/paper-trading.service';
import { QuoteService } from '../quote/quote.service';
import { ImportService } from '../import/import.service';
import type {
  AgentSession,
  CreateAgentSessionDto,
  AgentPermission,
  AgentApprovalMode,
} from '@shared/api.interface';

/** 附加在 MCP 请求上的已验证智能体会话上下文。 */
export interface McpSessionContext {
  sessionId: string;
  userId: string;
  name: string;
  dailyLimitUsd: number;
  permission: AgentPermission;
  approvalMode: AgentApprovalMode;
}

/** JSON-RPC 工具描述符。 */
interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 生成随机会话 token（sq- + 24 字节 hex）。 */
function generateToken(): string {
  return `sq-${randomBytes(24).toString('hex')}`;
}

@Injectable()
export class McpService {
  private readonly logger = new Logger('Mcp');

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly paperTrading: PaperTradingService,
    private readonly quoteService: QuoteService,
    private readonly importService: ImportService,
  ) {}

  // ------------------------------------------------------------------
  // Agent 会话 CRUD（面向用户的 API，不属于 MCP 协议）
  // ------------------------------------------------------------------

  /** 列出调用者的智能体会话（token 永不返回）。 */
  async listSessions(userId: string): Promise<AgentSession[]> {
    const rows = await this.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.owner, userId))
      .orderBy(desc(agentSessions.createdAt));
    return rows.map((r) => this.mapSession(r));
  }

  /** 创建智能体会话并返回（含仅出现一次的 token）。 */
  async createSession(userId: string, dto: CreateAgentSessionDto): Promise<AgentSession> {
    const name = (dto.name ?? '').trim();
    if (!name) throw new BadRequestException('Please provide an agent name');
    const token = generateToken();
    const [row] = await this.db
      .insert(agentSessions)
      .values({
        owner: userId,
        name,
        token,
        dailyLimitUsd: String(dto.dailyLimitUsd ?? 500),
        permission: dto.permission ?? 'trade',
        approvalMode: dto.approvalMode ?? 'require_approval',
      })
      .returning();
    return this.mapSession(row, token);
  }

  /** 更新会话的限额/模式（属主范围内）。 */
  async updateSession(
    userId: string,
    id: string,
    patch: {
      dailyLimitUsd?: number;
      permission?: AgentPermission;
      approvalMode?: AgentApprovalMode;
    },
  ): Promise<AgentSession> {
    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.dailyLimitUsd != null && patch.dailyLimitUsd > 0) {
      values.dailyLimitUsd = String(patch.dailyLimitUsd);
    }
    if (patch.permission) values.permission = patch.permission;
    if (patch.approvalMode) values.approvalMode = patch.approvalMode;
    const [row] = await this.db
      .update(agentSessions)
      .set(values)
      .where(and(eq(agentSessions.owner, userId), eq(agentSessions.id, id)))
      .returning();
    if (!row) throw new NotFoundException('Session not found');
    return this.mapSession(row);
  }

  /** 撤销会话（属主范围内）。 */
  async revokeSession(userId: string, id: string): Promise<void> {
    await this.db
      .update(agentSessions)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(and(eq(agentSessions.owner, userId), eq(agentSessions.id, id)));
  }

  // ------------------------------------------------------------------
  // MCP 协议：鉴权 + 工具分发
  // ------------------------------------------------------------------

  /** 用 Bearer token 对照活动智能体会话验证身份。 */
  async authenticate(token: string): Promise<McpSessionContext> {
    if (!token) throw new UnauthorizedException('Missing MCP token');
    const [row] = await this.db.select().from(agentSessions).where(eq(agentSessions.token, token));
    if (!row) throw new UnauthorizedException('Invalid MCP token');
    if (row.status !== 'active')
      throw new ForbiddenException('This agent session has been revoked');
    // 记录使用痕迹（lastUsedAt）。
    await this.db
      .update(agentSessions)
      .set({ lastUsedAt: new Date() })
      .where(eq(agentSessions.id, row.id));
    return {
      sessionId: row.id,
      userId: row.owner,
      name: row.name,
      dailyLimitUsd: Number(row.dailyLimitUsd),
      permission: row.permission as AgentPermission,
      approvalMode: row.approvalMode as AgentApprovalMode,
    };
  }

  /** 返回全部工具描述符（get_portfolio/get_quotes/get_research_report/place_paper_order/list_orders/import_holdings）。 */
  getTools(): ToolDescriptor[] {
    return [
      {
        name: 'get_portfolio',
        description:
          "获取模拟盘账户概览：现金、净值、持仓（含现价和浮盈亏）、今日盈亏、AI 盯盘状态。Get the paper trading account overview: cash, equity, positions with live prices and unrealized P&L, today's P&L, and bot status.",
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_quotes',
        description:
          '获取股票实时行情。支持美股（如 AAPL）、港股（如 0700）、A股（如 600519）。Get live stock quotes. Supports US (AAPL), HK (0700), and CN (600519) markets.',
        inputSchema: {
          type: 'object',
          properties: {
            tickers: {
              type: 'array',
              items: { type: 'string' },
              description: '股票代码列表，如 ["AAPL", "0700", "600519"]',
            },
          },
          required: ['tickers'],
        },
      },
      {
        name: 'get_research_report',
        description:
          '获取指定股票的最新 AI 深度研究报告（多空辩论、批评者审视、风控检查、评级）。Get the latest AI deep research report for a stock (bull/bear debate, critic review, risk gates, rating).',
        inputSchema: {
          type: 'object',
          properties: {
            ticker: {
              type: 'string',
              description: '股票代码，如 "NVDA"',
            },
          },
          required: ['ticker'],
        },
      },
      {
        name: 'place_paper_order',
        description:
          '在模拟盘下单（买入或卖出）。订单会经过风控检查（日亏损熔断、单笔上限、频次上限）。如果代理会话设置了"需要审批"模式，订单将进入待审批状态。Place a paper trading order (buy or sell). Orders go through risk gates. If the session requires approval, the order will be pending until the user approves it.',
        inputSchema: {
          type: 'object',
          properties: {
            ticker: { type: 'string', description: '股票代码，如 "NVDA" 或 "0700"' },
            side: { type: 'string', enum: ['buy', 'sell'], description: '方向' },
            quantity: { type: 'number', description: '股数（正整数）' },
            reason: { type: 'string', description: '下单理由（会展示给用户）' },
          },
          required: ['ticker', 'side', 'quantity'],
        },
      },
      {
        name: 'list_orders',
        description:
          '获取最近的模拟盘订单（含状态：已成交/待审批/被风控拦截）。Get recent paper trading orders (including status: filled/pending_approval/rejected).',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '返回条数（默认 10，最多 50）' },
          },
        },
      },
      {
        name: 'import_holdings',
        description:
          '将持仓数据导入吵股（创建真实的持仓记录）。输入为股票代码、股数、成本价的列表。Import holdings into Squabble (creates real holding records). Input is a list of ticker, shares, and cost basis.',
        inputSchema: {
          type: 'object',
          properties: {
            rows: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  ticker: { type: 'string' },
                  shares: { type: 'number' },
                  avgCost: { type: 'number' },
                  company: { type: 'string' },
                },
                required: ['ticker', 'shares'],
              },
              description: '持仓列表',
            },
            source: { type: 'string', description: '来源标识，默认 "mcp"' },
          },
          required: ['rows'],
        },
      },
    ];
  }

  /** 分发一次 tools/call 请求；未知工具抛 BadRequest。 */
  async callTool(
    ctx: McpSessionContext,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.logger.log(`tool=${name} session=${ctx.name}`);
    switch (name) {
      case 'get_portfolio':
        return this.toolGetPortfolio(ctx);
      case 'get_quotes':
        return this.toolGetQuotes(ctx, args);
      case 'get_research_report':
        return this.toolGetResearchReport(ctx, args);
      case 'place_paper_order':
        return this.toolPlaceOrder(ctx, args);
      case 'list_orders':
        return this.toolListOrders(ctx, args);
      case 'import_holdings':
        return this.toolImportHoldings(ctx, args);
      default:
        throw new BadRequestException(`未知工具: ${name}`);
    }
  }

  // ------------------------------------------------------------------
  // 工具实现
  // ------------------------------------------------------------------

  /** get_portfolio：模拟盘账户概览（现金、净值、持仓现价与浮盈亏、熔断与盯盘状态）。 */
  private async toolGetPortfolio(ctx: McpSessionContext) {
    const overview = await this.paperTrading.getOverview(ctx.userId);
    return {
      cash: overview.account.cashBalance,
      equity: overview.equity,
      positionsValue: overview.positionsValue,
      todayPl: overview.todayPl,
      totalPl: overview.totalPl,
      totalPlPct: overview.totalPlPct,
      botEnabled: overview.account.botEnabled,
      circuitBreakerActive: overview.circuitBreakerActive,
      positions: overview.positions.map((p) => ({
        ticker: p.ticker,
        company: p.company,
        shares: Number(p.shares),
        avgCost: Number(p.avgCost),
        lastPrice: p.lastPrice ? Number(p.lastPrice) : null,
        unrealizedPl: p.unrealizedPl ? Number(p.unrealizedPl) : null,
        unrealizedPct: p.unrealizedPct ? Number(p.unrealizedPct) : null,
      })),
    };
  }

  /** get_quotes：批量实时行情（最多 20 只）。 */
  private async toolGetQuotes(_ctx: McpSessionContext, args: Record<string, unknown>) {
    const tickers = Array.isArray(args.tickers) ? args.tickers.map(String) : [];
    if (tickers.length === 0) throw new BadRequestException('tickers cannot be empty');
    const quotes = await this.quoteService.getBatchQuotes(tickers.slice(0, 20));
    return quotes.map((q) => ({
      ticker: q.symbol,
      name: q.companyName ?? undefined,
      price: Number(q.price),
      change: Number(q.change),
      changePercent: Number(q.changePercent),
      currency: q.currency,
      market: q.market,
    }));
  }

  /** get_research_report：返回指定代码最新深度报告的摘要字段（无报告时 found:false）。 */
  private async toolGetResearchReport(ctx: McpSessionContext, args: Record<string, unknown>) {
    const ticker = String(args.ticker ?? '')
      .trim()
      .toUpperCase();
    if (!ticker) throw new BadRequestException('ticker cannot be empty');
    const [report] = await this.db
      .select()
      .from(deepReport)
      .where(and(eq(deepReport.owner, ctx.userId), eq(deepReport.ticker, ticker)))
      .orderBy(desc(deepReport.createdAt))
      .limit(1);
    if (!report) {
      return {
        found: false,
        message: `没有 ${ticker} 的研究报告。请先在吵股中对该股票运行多智能体分析。`,
      };
    }
    return {
      found: true,
      ticker: report.ticker,
      rating: report.rating,
      confidence: report.confidence,
      targetBear: report.targetBear ? Number(report.targetBear) : null,
      targetBase: report.targetBase ? Number(report.targetBase) : null,
      targetBull: report.targetBull ? Number(report.targetBull) : null,
      coreThesis: report.coreThesis,
      viewChange: report.viewChange,
      bullPoints: report.bullPoints,
      bearPoints: report.bearPoints,
      criticPoints: report.criticPoints,
      pmAction: report.pmAction,
      riskItems: report.riskItems,
    };
  }

  /** place_paper_order：受控下单（只读会话拒绝、粗额度校验、经 paper-trading 风控与审批链）。 */
  private async toolPlaceOrder(ctx: McpSessionContext, args: Record<string, unknown>) {
    if (ctx.permission !== 'trade') {
      throw new ForbiddenException('This agent session is read-only and cannot place orders');
    }
    const ticker = String(args.ticker ?? '').trim();
    const side = String(args.side ?? '').trim();
    const quantity = Math.floor(Number(args.quantity));
    if (!ticker) throw new BadRequestException('ticker cannot be empty');
    if (side !== 'buy' && side !== 'sell')
      throw new BadRequestException('side must be buy or sell');
    if (!Number.isFinite(quantity) || quantity <= 0)
      throw new BadRequestException('quantity must be a positive integer');

    // 检查会话今日已用额度（买入方向）。
    const todaySpend = await this.todaySessionSpend(ctx.sessionId);
    const notionalEstimate = quantity * 100; // 保守下界：真实检查在 placeOrder 内。
    if (side === 'buy' && todaySpend + notionalEstimate > ctx.dailyLimitUsd * 10) {
      // 真实名义价值检查要等到拿到价格后（placeOrder 内）；这里先按日限额 10 倍做激进的提前护栏。
      throw new ForbiddenException(
        `今日该代理已使用的额度加上这笔预估已远超日限额 ${ctx.dailyLimitUsd} USD`,
      );
    }

    const order = await this.paperTrading.placeOrder(
      ctx.userId,
      {
        ticker,
        side: side as 'buy' | 'sell',
        quantity,
        orderType: 'market',
        reason: String(args.reason ?? `AI 代理 ${ctx.name} 下单`),
      },
      'agent',
      { sessionId: ctx.sessionId, agentName: ctx.name, approvalMode: ctx.approvalMode },
    );

    // placeOrder 返回的是原始数据库行；此处归一化为 MCP 输出。
    return {
      orderId: order.id,
      ticker: order.ticker,
      side: order.side,
      quantity: Number(order.quantity),
      status: order.status,
      filledPrice: order.filledPrice ? Number(order.filledPrice) : null,
      reason: order.reason,
      message:
        order.status === 'filled'
          ? `订单已成交 @ ${order.filledPrice}`
          : order.status === 'pending_approval'
            ? '订单已提交，等待用户审批'
            : `订单被风控拦截：${order.reason}`,
    };
  }

  /** list_orders：返回本会话属主最近的模拟盘订单（1–50 条，默认 10）。 */
  private async toolListOrders(ctx: McpSessionContext, args: Record<string, unknown>) {
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
    const rows = await this.db
      .select()
      .from(paperOrders)
      .where(eq(paperOrders.owner, ctx.userId))
      .orderBy(desc(paperOrders.createdAt))
      .limit(limit);
    return rows.map((o) => ({
      id: o.id,
      ticker: o.ticker,
      side: o.side,
      quantity: Number(o.quantity),
      status: o.status,
      filledPrice: o.filledPrice ? Number(o.filledPrice) : null,
      reason: o.reason,
      agentName: o.agentName,
      createdAt: o.createdAt.toISOString(),
    }));
  }

  /** import_holdings：把提取的持仓行写入真实持仓记录（委托 ImportService.commit）。 */
  private async toolImportHoldings(ctx: McpSessionContext, args: Record<string, unknown>) {
    const rows = Array.isArray(args.rows) ? args.rows : [];
    if (rows.length === 0) throw new BadRequestException('rows cannot be empty');
    const source = String(args.source ?? 'mcp');
    const result = await this.importService.commit(ctx.userId, {
      source: source as 'csv',
      rows: rows.map((r: Record<string, unknown>) => ({
        ticker: String(r.ticker ?? ''),
        shares: Number(r.shares ?? 0),
        avgCost: r.avgCost != null ? Number(r.avgCost) : null,
        company: r.company != null ? String(r.company) : null,
      })),
      filename: `mcp:${ctx.name}`,
    });
    return result;
  }

  // ------------------------------------------------------------------
  // 内部工具
  // ------------------------------------------------------------------

  /** 汇总某会话今日已成交买单的名义价值（美元，UTC 日界）。 */
  private async todaySessionSpend(sessionId: string): Promise<number> {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const rows = await this.db
      .select()
      .from(paperOrders)
      .where(and(eq(paperOrders.sessionId, sessionId), eq(paperOrders.status, 'filled')));
    return rows
      .filter((o) => o.createdAt >= dayStart && o.side === 'buy')
      .reduce((sum, o) => {
        const notional = Number(o.quantity) * Number(o.filledPrice ?? 0);
        return sum + notional;
      }, 0);
  }

  /** agentSessions 行 → API AgentSession DTO（token 仅在创建响应中透出）。 */
  private mapSession(row: typeof agentSessions.$inferSelect, token?: string): AgentSession {
    return {
      id: row.id,
      name: row.name,
      dailyLimitUsd: String(row.dailyLimitUsd),
      permission: row.permission as AgentPermission,
      approvalMode: row.approvalMode as AgentApprovalMode,
      status: row.status as 'active' | 'revoked',
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      ...(token ? { token } : {}),
    };
  }
}
