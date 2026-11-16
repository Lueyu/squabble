import type { NativeAgentConfiguration } from './local-agents.interface';
import type { ResearchEvent } from './research-events.interface';

/**
 * council.interface.ts — 委员会（Council）投资研究的公共契约。
 *
 * 职责边界：
 *  - 定义委员会研究的全部跨端数据形状：LLM 预算设置与用量、成员/角色/发言风格/研究
 *    方向等词汇类型、成员与会话配置、交易节奏、消息、报告、会话状态与人审结果。
 *  - 有界研究：研究范围与预算受 LlmBudgetSettings 约束，产出为 CouncilReport，
 *    一切决策最终回到用户（human decision）。
 * 上下游：
 *  - 上游：server/modules/council 等服务端模块与 client/src 委员会界面，共 41 个文件
 *    import 本契约（server 20、client 19、shared 内 2）。
 *  - 下游：import type { NativeAgentConfiguration }（local-agents.interface.ts，本地 CLI 成员
 *    的模型配置）与 import type { ResearchEvent }（research-events.interface.ts，研究事件流）。
 * 关键约定：
 *  - 金额/价格字段均为字符串形式的数值（避免浮点误差）；tokensUsed 为 token 个数。
 *  - CouncilPhase 为讨论阶段：opening → challenge → response → summary（progress 为进行中）。
 *  - researchStance 是研究倾向，不是下单建议。
 */

// ══════════ LLM 预算域 ══════════

/** LLM 预算设置：用户可配的用量上限与单价估计（有界研究的第一道闸）。 */
export interface LlmBudgetSettings {
  /** 预算开关。 */
  enabled: boolean;
  /** 每日 token 上限。 */
  dailyTokenLimit: number;
  /** 每月 token 上限。 */
  monthlyTokenLimit: number;
  /** 单个任务 token 上限。 */
  perTaskTokenLimit: number;
  /** 单次调用最大输入 token。 */
  maxInputTokens: number;
  /** 单次调用最大输出 token。 */
  maxOutputTokens: number;
  /** 单个任务最大调用次数。 */
  maxCallsPerTask: number;
  /** 每日最大调用次数。 */
  dailyCallLimit: number;
  /** 可选的用户自填保守单价（USD/百万 token）；仅为估算，不是账单数据。 */
  inputUsdPerMillion: number | null;
  /** 可选的用户自填保守单价（USD/百万 token）；仅为估算，不是账单数据。 */
  outputUsdPerMillion: number | null;
}

/** LLM 预算用量：当日/当月消耗、预留额度与最近调用记录。 */
export interface LlmBudgetUsage {
  /** 当前生效的预算设置。 */
  settings: LlmBudgetSettings;
  /** 当日已用 token。 */
  dayTokens: number;
  /** 当月已用 token。 */
  monthTokens: number;
  /** 当日调用次数。 */
  dayCalls: number;
  /** 进行中任务已预留的 token。 */
  reservedTokens: number;
  /** 估算成本（USD）；未配置单价时为 null。 */
  estimatedCostUsd: number | null;
  /** 最近调用记录（按时间倒序）。 */
  recent: Array<{
    /** 记录 id。 */
    id: string;
    /** 调用用途。 */
    purpose: string;
    /** 模型名。 */
    model: string;
    /** 关联任务 id。 */
    taskId: string;
    /** 输入 token。 */
    inputTokens: number;
    /** 输出 token。 */
    outputTokens: number;
    /** 提供商上报的调用总 token（prompt+completion，超出的部分计入输出）；未上报时按预留额度计。 */
    chargedTokens: number;
    /** 调用结局。 */
    status: string;
    /** 发生时间（ISO 字符串）。 */
    createdAt: string;
  }>;
}

// ══════════ 成员 / 会话配置域 ══════════

/** 委员会角色：研究员 / 质询者 / 主持人。 */
export type CouncilRole = 'researcher' | 'challenger' | 'manager';
/** 发言风格：简练 / 详细 / 苏格拉底式追问。 */
export type CouncilSpeakingStyle = 'concise' | 'detailed' | 'socratic';
/** 研究方向：财报 / 估值 / 新闻 / 价格 / 网络。 */
export type CouncilResearchKind = 'financials' | 'valuation' | 'news' | 'price' | 'web';
/** 讨论阶段：开场 → 质询 → 回应 → 总结（progress 表示进行中的过渡状态）。 */
export type CouncilPhase = 'opening' | 'challenge' | 'response' | 'summary' | 'progress';

/** 一次数据获取的记录（谁、以什么方式、结果如何），随消息附带给前端展示。 */
export interface ResearchAcquisition {
  /** 获取来源标识。 */
  source: string;
  /** 结局：开始 / 成功 / 部分 / 失败 / 缓存命中 / 跳过。 */
  status: 'started' | 'succeeded' | 'partial' | 'failed' | 'cache_hit' | 'skipped';
  /** 结果说明。 */
  detail: string;
  /** 研究方向（见 CouncilResearchKind）；可省略。 */
  kind?: CouncilResearchKind;
}

/** 委员会成员配置：既支持应用内置模型，也支持本地 CLI 成员。 */
export interface CouncilMember {
  /** 执行模式：local=复用已连接的本地 CLI 账号；model=使用应用 API 设置。 */
  executionMode?: 'model' | 'local';
  /** 本地 CLI 成员的连接条目 id（对应 LocalAgentConnection.id）。 */
  agentId?: string;
  /** 本地 CLI 成员的模型配置。 */
  agentSettings?: NativeAgentConfiguration;
  /** 成员 id。 */
  id: string;
  /** 角色（见 CouncilRole）。 */
  role: CouncilRole;
  /** 成员名。 */
  name: string;
  /** 研究指令（system prompt 的一部分）。 */
  instructions: string;
  /** 使用快/慢哪条模型通道。 */
  model: 'fast' | 'slow';
  /** 关联的模型连接 id；留空使用账户现有默认连接，凭据绝不进入成员配置。 */
  connectionId?: string;
  /** 职位头衔（展示用）。 */
  roleTitle?: string;
  /** 性格描述（展示与提示词用）。 */
  personality?: string;
  /** 研究方向列表。 */
  researchFocus?: CouncilResearchKind[];
  /** 发言风格。 */
  speakingStyle?: CouncilSpeakingStyle;
  /** 头像主题。 */
  avatar?: 'value' | 'growth' | 'risk' | 'technical' | 'news' | 'macro' | 'moderator';
}

/** 委员会总配置：是否启用 + 成员列表 + 是否允许联网研究。 */
export interface CouncilConfig {
  /** 是否启用委员会评审。 */
  enabled: boolean;
  /** 成员列表。 */
  members: CouncilMember[];
  /** 是否允许联网研究。 */
  webResearch?: boolean;
}

/** 创建委员会会话的请求体。 */
export interface CreateCouncilSession {
  /** 关联的新手建仓代理档案 id；可省略。 */
  profileId?: string;
  /** 研究标的代码。 */
  ticker: string;
  /** 会话语言；缺省由服务端决定。 */
  language?: 'zh-CN' | 'en';
  /** 成员列表；省略时使用模板/预设。 */
  members?: CouncilMember[];
  /** 是否允许联网研究。 */
  webResearch?: boolean;
}

// ══════════ 交易节奏 / 消息 / 报告 / 会话域 ══════════

/** 交易节奏约束（模拟盘/委员会遵循的纪律）。 */
export interface TradingCadence {
  /** 每隔多少个交易日复审一次。 */
  reviewEveryTradingDays: number;
  /** 每周最多下单数。 */
  maxOrdersPerWeek: number;
  /** 冷却期（交易日）。 */
  cooldownTradingDays: number;
  /** 单周最大换手比例（%）。 */
  maxWeeklyTurnoverPct: number;
}

/** 委员会提出的交易候选（模拟盘订单的前身）。 */
export interface CouncilCandidate {
  /** 标的代码。 */
  ticker: string;
  /** 方向：买入 / 卖出。 */
  side: 'buy' | 'sell';
  /** 股数。 */
  quantity: number;
  /** 参考价格。 */
  price: number;
  /** 理由。 */
  reason: string;
}

/** 一条委员会发言（成员或用户），可携带证据与质疑链。 */
export interface CouncilMessage {
  /** 关联的研究任务 id。 */
  taskId?: string;
  /** 是否来自外部代理（本地 CLI / companion）。 */
  externalAgent?: boolean;
  /** 外部代理用量未知时置位（token 统计口径不完整）。 */
  externalUsageUnknown?: boolean;
  /** 消息 id。 */
  id: string;
  /** 发言者角色：委员会成员角色 / 用户 / 系统。 */
  role: CouncilRole | 'user' | 'system';
  /** 发言者名。 */
  memberName: string;
  /** 消息正文。 */
  content: string;
  /** 会话修订号。 */
  revision: number;
  /** 该消息消耗的 token 数。 */
  tokensUsed: number;
  /** 发言时间（ISO 字符串）。 */
  createdAt: string;
  /** 发言成员 id；系统/用户消息为 null。 */
  memberId?: string | null;
  /** 所属讨论阶段。 */
  phase?: CouncilPhase;
  /** 回复的目标消息 id。 */
  replyToMessageId?: string | null;
  /** 引用的证据 id 列表。 */
  evidenceIds?: string[];
  /** 简短的公开推理摘要与证据核对；绝不包含模型的原始 reasoning_content。 */
  reasoningSummary?: string[];
  /** 向团队提出的问题。 */
  questions?: string[];
  /** 本次发言伴随的数据获取记录。 */
  acquisition?: ResearchAcquisition | null;
}

/** 委员会研究报告：结论 + 分歧 + 证据 + 关联的模拟盘订单。 */
export interface CouncilReport {
  /** 报告 id。 */
  id: string;
  /** 报告版本号。 */
  version: number;
  /** 会话修订号。 */
  revision: number;
  /** 结论：批准 / 观望 / 否决。 */
  decision: 'approve' | 'wait' | 'reject';
  /** 结论摘要。 */
  summary: string;
  /** 保留的异议（各成员的不同意见）。 */
  dissent: string[];
  /** 下次复审的条件。 */
  nextReviewCondition: string;
  /** 报告引用的证据列表。 */
  evidence: Array<{
    /** 证据 id。 */
    id: string;
    /** 证据标题。 */
    title: string;
    /** 证据内容。 */
    content: string;
    /** 来源 URL；离线证据为 null。 */
    sourceUrl: string | null;
    /** 抓取时间（ISO 字符串）。 */
    fetchedAt: string;
  }>;
  /** 关联的多智能体运行 id；无则 null。 */
  sourceRunId: string | null;
  /** 报告产出的交易候选；无则 null。 */
  candidate: CouncilCandidate | null;
  /** 已执行的模拟盘订单 id；未下单为 null。 */
  paperOrderId: string | null;
  /** 本次报告消耗的 token 数。 */
  tokensUsed: number;
  /** 生成引擎；a2a 仅保留给历史报告。 */
  engine: 'basic' | 'llm' | 'local' | 'a2a' | 'mixed';
  /** 外部代理用量未知时置位。 */
  externalUsageUnknown?: boolean;
  /** 报告生成时间（ISO 字符串）。 */
  createdAt: string;
  /** 研究倾向：积极 / 中性 / 谨慎；不是下单建议。 */
  researchStance?: 'positive' | 'balanced' | 'cautious' | null;
}

/** 委员会会话聚合：配置、消息、报告、研究事件与进度。 */
export interface CouncilSession {
  /** 本会话的研究事件流（就地内嵌，可能被截断）。 */
  researchEvents?: ResearchEvent[];
  /** 研究事件是否被截断。 */
  researchEventsTruncated?: boolean;
  /** 会话 id。 */
  id: string;
  /** 关联的新手建仓代理档案 id；无则 null。 */
  profileId: string | null;
  /** 档案版本号（会话按该版本的配置运行）。 */
  profileVersion: number;
  /** 研究标的代码。 */
  ticker: string;
  /** 会话语言。 */
  language: 'zh-CN' | 'en';
  /** 会话状态：空闲 / 运行中 / 完成 / 暂停 / 失败。 */
  status: 'idle' | 'running' | 'completed' | 'paused' | 'failed';
  /** 会话修订号。 */
  revision: number;
  /** 全部消息。 */
  messages: CouncilMessage[];
  /** 全部报告。 */
  reports: CouncilReport[];
  /** 会话级错误信息；无则 null。 */
  error: string | null;
  /** 创建时间（ISO 字符串）。 */
  createdAt: string;
  /** 最后更新时间（ISO 字符串）。 */
  updatedAt: string;
  /** 本会话使用的成员列表。 */
  members?: CouncilMember[];
  /** 是否允许联网研究。 */
  webResearch?: boolean;
  /** 进行中的讨论进度（按回合计划指向下一回合；无进行中回合为 null）。 */
  progress?: {
    /** 下一回合的阶段。 */
    phase: CouncilPhase;
    /** 下一回合的发言成员 id（回合计划指定）。 */
    memberId: string | null;
    /** 下一回合序号（从 1 起）。 */
    turn: number;
    /** 回合计划的总轮数。 */
    totalTurns: number;
  } | null;
}

/** 人审结论：是否批准委员会的候选订单。 */
export interface CouncilReviewResult {
  /** 是否批准。 */
  approved: boolean;
  /** 理由。 */
  reason: string;
  /** 会话 id。 */
  sessionId: string;
  /** 关联报告 id；无则 null。 */
  reportId: string | null;
}
