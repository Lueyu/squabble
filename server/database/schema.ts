/* eslint-disable */
/**
 * Squabble 全库表/列定义（Drizzle ORM schema）。
 *
 * 职责边界：本文件自"去平台化"（de-platforming）起手工维护，是数据库结构的
 * 唯一事实来源（原平台代码生成已移除）。全新安装对应的 DDL 在
 * scripts/db/01_schema.sql，两者必须保持同步；增量结构见 scripts/db/ 下
 * 其余迁移脚本。本文件只声明表/列/索引/外键，不含查询与业务逻辑。
 *
 * 上下游：import drizzle-orm/drizzle-orm/pg-core；被几乎全部业务模块
 * （auth、journal、analysis、paper-trading、notifications 等）与其他
 * database/*.schema.ts 引用。
 *
 * 所有权模型：每张业务表都带 `owner` 列（text，存所属 users.id）。service
 * 层始终以已认证的 userId 过滤查询（行级隔离），并在插入时写入
 * owner/_created_by/_updated_by。
 *
 * 声明顺序与迁移脚本一致；个别表的外键引用了后文才声明的表（如 deep_report
 * 引用 agentRuns、holdings 引用 groups），由 Drizzle 的惰性求值保证可用。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
  customType,
} from 'drizzle-orm/pg-core';

/**
 * 自定义 timestamptz 列类型：可配置精度（precision，小数秒位数）。
 * toDriver 接受 number（毫秒时间戳）/string/Date，统一转成 ISO 字符串；
 * fromDriver 把驱动返回的 string/Date 统一还原为 Date。非法值抛
 * "Invalid timestamp value"。
 */
export const customTimestamptz = customType<{
  data: Date;
  driverData: string;
  config: { precision?: number };
}>({
  dataType(config) {
    const precision = typeof config?.precision !== 'undefined' ? ` (${config.precision})` : '';
    return `timestamptz${precision}`;
  },
  toDriver(value: Date | string | number) {
    if (value == null) return value as any;
    if (typeof value === 'number') return new Date(value).toISOString();
    if (typeof value === 'string') return value;
    if (value instanceof Date) return value.toISOString();
    throw new Error('Invalid timestamp value');
  },
  fromDriver(value: string | Date): Date {
    if (value instanceof Date) return value;
    return new Date(value);
  },
});

/**
 * owner 列类型。
 *
 * 历史上平台把行所有权存在 Postgres 复合类型 `user_profile` 中；去平台化后
 * 该列就是普通的 text（存所属用户 id）。导出名保留 userProfile 不变，使各
 * 表声明无需改动；两个方向都是透传转换。
 */
export const userProfile = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return 'text';
  },
  toDriver(value: string) {
    return value;
  },
  fromDriver(value: string): string {
    return value;
  },
});

/**
 * 一方用户账号表（登录逻辑见 server/modules/auth）。账号 = 用户名 + bcrypt
 * 密码哈希——没有手机号、没有邮箱验证；email_notify 是用户可选填的自由
 * 文本通知路由提示，从不做格式校验。session_version 用于吊销旧会话
 * （JWT 里带版本号，双校验见 platform/auth.guard.ts）。
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: varchar('username', { length: 32 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  recoveryCodeHash: text('recovery_code_hash'),
  sessionVersion: integer('session_version').default(0).notNull(),
  displayName: varchar('display_name', { length: 64 }),
  emailNotify: varchar('email_notify', { length: 255 }),
  createdAt: customTimestamptz('created_at', { precision: 3 })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: customTimestamptz('updated_at', { precision: 3 })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

/**
 * 深度报告表：一次 agent run 的最终结构化研究产出（评级/置信度/三情景目标
 * 价与概率、核心论点、行业与公司基本面各维度、估值、催化剂、风险、PM 行动
 * 建议等）。runId 唯一并外键关联 agent_runs.id，onDelete: 'cascade'
 * （run 删除则报告随之删除）。
 */
export const deepReport = pgTable(
  'deep_report',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull().unique(),
    ticker: varchar('ticker', { length: 20 }).notNull(),
    analysisTrace: jsonb('analysis_trace'),
    rating: varchar('rating', { length: 20 }),
    confidence: varchar('confidence', { length: 10 }),
    targetBear: numeric('target_bear'),
    targetBase: numeric('target_base'),
    targetBull: numeric('target_bull'),
    probBear: numeric('prob_bear'),
    probBase: numeric('prob_base'),
    probBull: numeric('prob_bull'),
    coreThesis: text('core_thesis'),
    viewChange: text('view_change'),
    prevRating: varchar('prev_rating', { length: 20 }),
    companyOverview: text('company_overview'),
    businessModel: text('business_model'),
    moat: text('moat'),
    revenueStructure: jsonb('revenue_structure'),
    financialAnnual: jsonb('financial_annual'),
    financialQuarterly: jsonb('financial_quarterly'),
    profitability: jsonb('profitability'),
    balanceSheet: jsonb('balance_sheet'),
    cashFlow: jsonb('cash_flow'),
    financialQuality: text('financial_quality'),
    segmentAnalysis: jsonb('segment_analysis'),
    valuationRelative: jsonb('valuation_relative'),
    valuationSotp: jsonb('valuation_sotp'),
    valuationMethodology: text('valuation_methodology'),
    industryOverview: text('industry_overview'),
    marketSize: text('market_size'),
    competitivePosition: text('competitive_position'),
    industryTrends: text('industry_trends'),
    bullPoints: jsonb('bull_points'),
    bearPoints: jsonb('bear_points'),
    criticPoints: jsonb('critic_points'),
    revisedAssumptions: text('revised_assumptions'),
    catalystsTimeline: jsonb('catalysts_timeline'),
    riskItems: jsonb('risk_items'),
    riskGateSnapshot: jsonb('risk_gate_snapshot'),
    pmAction: text('pm_action'),
    pmPriceRange: text('pm_price_range'),
    pmPositionSize: text('pm_position_size'),
    pmStopLoss: text('pm_stop_loss'),
    pmExecutionPlan: text('pm_execution_plan'),
    trackingMetrics: jsonb('tracking_metrics'),
    viewChangeTriggers: text('view_change_triggers'),
    owner: userProfile('owner').notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：创建时间（自动填充，请勿修改）
    createdAt: customTimestamptz('_created_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：创建者（自动填充，请勿修改）
    createdBy: userProfile('_created_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：更新时间（自动填充，请勿修改）
    updatedAt: customTimestamptz('_updated_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：更新者（自动填充，请勿修改）
    updatedBy: userProfile('_updated_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  },
  (table) => [
    uniqueIndex('idx_deep_report_run').on(table.runId),
    // 复合索引：CREATE INDEX idx_deep_report_owner ON deep_report USING btree (((owner).user_id)),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [agentRuns.id],
      name: 'deep_report_run_id_fkey',
    }).onDelete('cascade'),
  ],
);

/**
 * agent 审计日志表：记录 run 生命周期中的关键动作（action + 任意结构 JSON
 * detail），用于追溯与排障。runId 可空并外键关联 agent_runs.id，
 * onDelete: 'set null'（run 删除后日志保留，仅断开关联）。
 */
export const agentAuditLog = pgTable(
  'agent_audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id'),
    action: varchar('action', { length: 50 }).notNull(),
    /**
     * @type {Record<string, any>} 任意结构的事件详情
     */
    detail: jsonb('detail'),
    owner: userProfile('owner').notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：创建时间（自动填充，请勿修改）
    createdAt: customTimestamptz('_created_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：创建者（自动填充，请勿修改）
    createdBy: userProfile('_created_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  },
  (table) => [
    // 复合索引：CREATE INDEX idx_audit_owner_date ON agent_audit_log USING btree (((owner).user_id), _created_at),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [agentRuns.id],
      name: 'agent_audit_log_run_id_fkey',
    }).onDelete('set null'),
  ],
);

/**
 * 策略规则表：风险闸门（risk gate）用的规则配置（规则键/名称/类型、阈值与
 * 单位、启停、描述、分类/严重级别/排序）。severity 默认 'warning'。
 * (owner.user_id, rule_key) 上有唯一索引。
 */
export const strategyRules = pgTable(
  'strategy_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ruleKey: varchar('rule_key', { length: 50 }).notNull(),
    ruleName: varchar('rule_name', { length: 100 }).notNull(),
    ruleType: varchar('rule_type', { length: 20 }).notNull(),
    threshold: numeric('threshold'),
    unit: varchar('unit', { length: 20 }),
    enabled: boolean('enabled').notNull().default(true),
    description: text('description'),
    owner: userProfile('owner').notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    category: varchar('category', { length: 50 }),
    severity: varchar('severity', { length: 20 }).default('warning'),
    sort: integer('sort').default(0),
    // 系统字段：创建时间（自动填充，请勿修改）
    createdAt: customTimestamptz('_created_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：创建者（自动填充，请勿修改）
    createdBy: userProfile('_created_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：更新时间（自动填充，请勿修改）
    updatedAt: customTimestamptz('_updated_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：更新者（自动填充，请勿修改）
    updatedBy: userProfile('_updated_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  },
  (table) => [
    // 复合索引：CREATE UNIQUE INDEX idx_strategy_rules_owner_key ON strategy_rules USING btree (((owner).user_id), rule_key),
  ],
);

/**
 * 风险闸门结果表：一次 run 中每条规则的实际校验结果（是否通过、当前值/阈值
 * 值、明细与建议动作）。runId 外键关联 agent_runs.id，onDelete: 'cascade'。
 */
export const riskGateResults = pgTable(
  'risk_gate_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull(),
    ruleName: varchar('rule_name', { length: 50 }).notNull(),
    ruleType: varchar('rule_type', { length: 20 }).notNull(),
    passed: boolean('passed').notNull(),
    currentValue: numeric('current_value'),
    thresholdValue: numeric('threshold_value'),
    detail: text('detail'),
    suggestedAction: text('suggested_action'),
    owner: userProfile('owner').notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：创建时间（自动填充，请勿修改）
    createdAt: customTimestamptz('_created_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：创建者（自动填充，请勿修改）
    createdBy: userProfile('_created_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  },
  (table) => [
    index('idx_risk_gate_run').on(table.runId),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [agentRuns.id],
      name: 'risk_gate_results_run_id_fkey',
    }).onDelete('cascade'),
  ],
);

/**
 * agent 评级表：一次 run 对一只标的的最终评级（rating/confidence/目标价/
 * 建议动作、多空摘要、催化剂与风险、聚合逻辑与关键不确定性）。(owner.user_id,
 * run_id) 唯一、(owner.user_id, ticker) 建索引；runId 外键关联 agent_runs.id，
 * onDelete: 'cascade'。
 */
export const agentRatings = pgTable(
  'agent_ratings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull(),
    ticker: varchar('ticker', { length: 20 }).notNull(),
    rating: varchar('rating', { length: 20 }).notNull(),
    confidence: varchar('confidence', { length: 10 }).notNull(),
    targetPrice: numeric('target_price'),
    action: text('action').notNull(),
    aggregationLogic: text('aggregation_logic'),
    keyUncertainty: text('key_uncertainty'),
    bullSummary: text('bull_summary'),
    bearSummary: text('bear_summary'),
    catalysts: text('catalysts'),
    risks: text('risks'),
    owner: userProfile('owner').notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：创建时间（自动填充，请勿修改）
    createdAt: customTimestamptz('_created_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：创建者（自动填充，请勿修改）
    createdBy: userProfile('_created_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：更新时间（自动填充，请勿修改）
    updatedAt: customTimestamptz('_updated_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：更新者（自动填充，请勿修改）
    updatedBy: userProfile('_updated_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  },
  (table) => [
    // 复合索引：CREATE UNIQUE INDEX idx_agent_ratings_owner_run ON agent_ratings USING btree (((owner).user_id), run_id),
    // 复合索引：CREATE INDEX idx_agent_ratings_owner_ticker ON agent_ratings USING btree (((owner).user_id), ticker),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [agentRuns.id],
      name: 'agent_ratings_run_id_fkey',
    }).onDelete('cascade'),
  ],
);

/**
 * 辩论记录表：run 内多轮辩论（round + 发言者 + 内容），tokens_used 记录该
 * 轮消耗的 token 数。runId 外键关联 agent_runs.id，onDelete: 'cascade'。
 */
export const debateRecords = pgTable(
  'debate_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull(),
    round: integer('round').notNull(),
    speaker: varchar('speaker', { length: 30 }).notNull(),
    content: text('content').notNull(),
    tokensUsed: integer('tokens_used').default(0),
    owner: userProfile('owner').notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：创建时间（自动填充，请勿修改）
    createdAt: customTimestamptz('_created_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：创建者（自动填充，请勿修改）
    createdBy: userProfile('_created_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  },
  (table) => [
    index('idx_debate_run').on(table.runId),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [agentRuns.id],
      name: 'debate_records_run_id_fkey',
    }).onDelete('cascade'),
  ],
);

/**
 * 多空论点表：run 内按立场（side，如 bull/bear）分轮记录论点及其引用的
 * 证据 id 列表（evidence_ids，JSON 数组）；counteredBy 指向反驳它的论点。
 * runId 外键关联 agent_runs.id，onDelete: 'cascade'。
 */
export const bullBearArguments = pgTable(
  'bull_bear_arguments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull(),
    side: varchar('side', { length: 10 }).notNull(),
    round: integer('round').notNull().default(1),
    argument: text('argument').notNull(),
    /**
     * @type {string[]} 引用的证据 id 列表
     */
    evidenceIds: jsonb('evidence_ids'),
    counteredBy: uuid('countered_by'),
    owner: userProfile('owner').notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：创建时间（自动填充，请勿修改）
    createdAt: customTimestamptz('_created_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：创建者（自动填充，请勿修改）
    createdBy: userProfile('_created_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  },
  (table) => [
    index('idx_bull_bear_run').on(table.runId),
    index('idx_bull_bear_run_side').on(table.runId, table.side),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [agentRuns.id],
      name: 'bull_bear_arguments_run_id_fkey',
    }).onDelete('cascade'),
  ],
);

/**
 * agent 证据表：run 收集到的证据条目（角色、证据类型、标题/正文、来源 URL
 * 与来源名、抓取时间 fetched_at、相关性评分）。runId 外键关联
 * agent_runs.id，onDelete: 'cascade'。
 */
export const agentEvidence = pgTable(
  'agent_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull(),
    role: varchar('role', { length: 30 }).notNull(),
    evidenceType: varchar('evidence_type', { length: 30 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    content: text('content').notNull(),
    sourceUrl: text('source_url'),
    sourceName: varchar('source_name', { length: 100 }),
    fetchedAt: customTimestamptz('fetched_at', { precision: 3 }).notNull(),
    relevanceScore: numeric('relevance_score'),
    owner: userProfile('owner').notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：创建时间（自动填充，请勿修改）
    createdAt: customTimestamptz('_created_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：创建者（自动填充，请勿修改）
    createdBy: userProfile('_created_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  },
  (table) => [
    index('idx_agent_evidence_run').on(table.runId),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [agentRuns.id],
      name: 'agent_evidence_run_id_fkey',
    }).onDelete('cascade'),
  ],
);

/**
 * agent 运行主表：一次研究 run 的编排记录（标的/市场、触发方式、运行模式
 * run_mode 默认 'full'、语言默认 'zh-CN'、状态默认 'pending'、fast/slow 模型
 * 名、token 消耗与成本估算、起止时间、错误信息、人工决策 human_decision 与
 * 批注 human_note）。它是 deep_report/评级/辩论/证据等表的 runId 外键目标。
 * (owner.user_id) 与 ticker/status/_created_at 的三个复合索引见下。
 */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticker: varchar('ticker', { length: 20 }).notNull(),
    tickerName: varchar('ticker_name', { length: 100 }),
    market: varchar('market', { length: 10 }),
    triggerType: varchar('trigger_type', { length: 20 }).notNull(),
    runMode: varchar('run_mode', { length: 20 }).notNull().default('full'),
    language: varchar('language', { length: 10 }).notNull().default('zh-CN'),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    modelFast: varchar('model_fast', { length: 50 }),
    modelSlow: varchar('model_slow', { length: 50 }),
    tokensUsed: integer('tokens_used').default(0),
    costEstimate: numeric('cost_estimate').default('0'),
    startedAt: customTimestamptz('started_at', { precision: 3 }),
    completedAt: customTimestamptz('completed_at', { precision: 3 }),
    errorMessage: text('error_message'),
    humanDecision: varchar('human_decision', { length: 20 }),
    humanNote: text('human_note'),
    owner: userProfile('owner').notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：创建时间（自动填充，请勿修改）
    createdAt: customTimestamptz('_created_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：创建者（自动填充，请勿修改）
    createdBy: userProfile('_created_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：更新时间（自动填充，请勿修改）
    updatedAt: customTimestamptz('_updated_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：更新者（自动填充，请勿修改）
    updatedBy: userProfile('_updated_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  },
  (table) => [
    // 复合索引：CREATE INDEX idx_agent_runs_owner_ticker ON agent_runs USING btree (((owner).user_id), ticker),
    // 复合索引：CREATE INDEX idx_agent_runs_owner_status ON agent_runs USING btree (((owner).user_id), status),
    // 复合索引：CREATE INDEX idx_agent_runs_owner_date ON agent_runs USING btree (((owner).user_id), _created_at),
  ],
);

/**
 * 汇率表：按 (rate_date, base, quote) 唯一的一行汇率（1 base = rate quote），
 * 建表目的：组合多币种折算用历史汇率。无 owner 列（全站共享数据）。
 */
export const fxRates = pgTable(
  'fx_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rateDate: date('rate_date').notNull(),
    base: varchar('base', { length: 10 }).notNull(),
    quote: varchar('quote', { length: 10 }).notNull(),
    rate: numeric('rate').notNull(),
    // 系统字段：创建时间（自动填充，请勿修改）
    createdAt: customTimestamptz('_created_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex('idx_fx_rates_date_base_quote').on(table.rateDate, table.base, table.quote),
  ],
);

/**
 * 现金账户表：每属主每币种一条（(owner.user_id, currency) 唯一），balance
 * 为该币种现金余额（默认 '0'）。读写逻辑在 modules/cash-accounts。
 */
export const cashAccounts = pgTable(
  'cash_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    currency: varchar('currency', { length: 10 }).notNull(),
    balance: numeric('balance').notNull().default('0'),
    owner: userProfile('owner').notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：创建时间（自动填充，请勿修改）
    createdAt: customTimestamptz('_created_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：创建者（自动填充，请勿修改）
    createdBy: userProfile('_created_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：更新时间（自动填充，请勿修改）
    updatedAt: customTimestamptz('_updated_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：更新者（自动填充，请勿修改）
    updatedBy: userProfile('_updated_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  },
  (table) => [
    // 复合索引：CREATE UNIQUE INDEX idx_cash_owner_currency ON cash_accounts USING btree (((owner).user_id), currency),
  ],
);

/**
 * 精选（alpha picks）表：AI 精选股票的历史记录（标的/公司/行业、入选日期、
 * 评级与权重、累计收益率 return_pct），用于展示与复盘。按 date_picked 建索引。
 */
export const alphaPicks = pgTable(
  'alpha_picks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticker: varchar('ticker', { length: 20 }).notNull(),
    company: varchar('company', { length: 255 }),
    sector: varchar('sector', { length: 100 }),
    datePicked: date('date_picked'),
    returnPct: numeric('return_pct'),
    rating: varchar('rating', { length: 30 }),
    weightPct: numeric('weight_pct'),
    owner: userProfile('owner').notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：创建时间（自动填充，请勿修改）
    createdAt: customTimestamptz('_created_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：创建者（自动填充，请勿修改）
    createdBy: userProfile('_created_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：更新时间（自动填充，请勿修改）
    updatedAt: customTimestamptz('_updated_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：更新者（自动填充，请勿修改）
    updatedBy: userProfile('_updated_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  },
  (table) => [index('idx_alpha_picks_date').on(table.datePicked)],
);

/**
 * 组合每日快照表：每属主每天一条（(owner, snapshot_date) 唯一）——账户总值、
 * 总市值/成本/现金、总盈亏与当日盈亏（daily_pl/daily_pct）、净入金
 * net_deposit 与累计净入金 cumulative_net_deposit（默认 '0'），供资金曲线用。
 */
export const snapshots = pgTable(
  'snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    snapshotDate: date('snapshot_date').notNull(),
    accountValue: numeric('account_value'),
    totalMv: numeric('total_mv'),
    cost: numeric('cost'),
    cash: numeric('cash'),
    totalPl: numeric('total_pl'),
    dailyPl: numeric('daily_pl'),
    dailyPct: numeric('daily_pct'),
    owner: userProfile('owner').notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    netDeposit: numeric('net_deposit').default('0'),
    cumulativeNetDeposit: numeric('cumulative_net_deposit').default('0'),
    // 系统字段：创建时间（自动填充，请勿修改）
    createdAt: customTimestamptz('_created_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：创建者（自动填充，请勿修改）
    createdBy: userProfile('_created_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：更新时间（自动填充，请勿修改）
    updatedAt: customTimestamptz('_updated_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：更新者（自动填充，请勿修改）
    updatedBy: userProfile('_updated_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  },
  (table) => [uniqueIndex('idx_snapshots_owner_date').on(table.owner, table.snapshotDate)],
);

/**
 * 交易日志（journal）表：每属主每天一条（(owner, journal_date) 唯一）——
 * 市场小结、组合小结、当日操作、明日计划、经验教训五段自由文本。
 */
export const journal = pgTable(
  'journal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    journalDate: date('journal_date').notNull(),
    marketSummary: text('market_summary'),
    portfolioSummary: text('portfolio_summary'),
    actions: text('actions'),
    plan: text('plan'),
    lessons: text('lessons'),
    owner: userProfile('owner').notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：创建时间（自动填充，请勿修改）
    createdAt: customTimestamptz('_created_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：创建者（自动填充，请勿修改）
    createdBy: userProfile('_created_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：更新时间（自动填充，请勿修改）
    updatedAt: customTimestamptz('_updated_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：更新者（自动填充，请勿修改）
    updatedBy: userProfile('_updated_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  },
  (table) => [uniqueIndex('idx_journal_owner_date').on(table.owner, table.journalDate)],
);

/**
 * 已平仓（closed）表：清仓记录——开/平仓日期、买卖价、股数、已实现盈亏与
 * 收益率、备注。按 close_date 与 ticker 建索引（时间线与按标的查询）。
 */
export const closed = pgTable(
  'closed',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticker: varchar('ticker', { length: 20 }).notNull(),
    company: varchar('company', { length: 255 }),
    openDate: date('open_date'),
    closeDate: date('close_date'),
    buyPrice: numeric('buy_price'),
    sellPrice: numeric('sell_price'),
    shares: numeric('shares'),
    realizedPl: numeric('realized_pl'),
    returnPct: numeric('return_pct'),
    notes: text('notes'),
    owner: userProfile('owner').notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：创建时间（自动填充，请勿修改）
    createdAt: customTimestamptz('_created_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：创建者（自动填充，请勿修改）
    createdBy: userProfile('_created_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：更新时间（自动填充，请勿修改）
    updatedAt: customTimestamptz('_updated_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：更新者（自动填充，请勿修改）
    updatedBy: userProfile('_updated_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  },
  (table) => [
    index('idx_closed_close_date').on(table.closeDate),
    index('idx_closed_ticker').on(table.ticker),
  ],
);

/**
 * 成交流水（transactions）表：逐笔买卖记录——日期、标的、方向 tx_type
 * （buy/sell 等）、股数、价格、费用（默认 '0'）、币种（默认 'USD'）、备注。
 * 按 tx_date 与 ticker 建索引。
 */
export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    txDate: date('tx_date').notNull(),
    ticker: varchar('ticker', { length: 20 }).notNull(),
    txType: varchar('tx_type', { length: 10 }).notNull(),
    shares: numeric('shares').notNull(),
    price: numeric('price').notNull(),
    fees: numeric('fees').default('0'),
    notes: text('notes'),
    owner: userProfile('owner').notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    currency: varchar('currency', { length: 10 }).default('USD'),
    // 系统字段：创建时间（自动填充，请勿修改）
    createdAt: customTimestamptz('_created_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：创建者（自动填充，请勿修改）
    createdBy: userProfile('_created_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：更新时间（自动填充，请勿修改）
    updatedAt: customTimestamptz('_updated_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：更新者（自动填充，请勿修改）
    updatedBy: userProfile('_updated_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  },
  (table) => [
    index('idx_transactions_date').on(table.txDate),
    index('idx_transactions_ticker').on(table.ticker),
  ],
);

/**
 * 个股分析（analysis）表：按日期+标的的分析记录（评级/建议/正文/目标价/
 * 催化剂/风险）。(owner, analysis_date, ticker) 唯一：同属主同日同标的仅
 * 一条；另按 analysis_date 建索引。
 */
export const analysis = pgTable(
  'analysis',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    analysisDate: date('analysis_date').notNull(),
    ticker: varchar('ticker', { length: 20 }).notNull(),
    rating: varchar('rating', { length: 500 }),
    action: varchar('action', { length: 500 }),
    analysis: text('analysis'),
    targetPrice: numeric('target_price'),
    catalysts: text('catalysts'),
    risks: text('risks'),
    owner: userProfile('owner').notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：创建时间（自动填充，请勿修改）
    createdAt: customTimestamptz('_created_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：创建者（自动填充，请勿修改）
    createdBy: userProfile('_created_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：更新时间（自动填充，请勿修改）
    updatedAt: customTimestamptz('_updated_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：更新者（自动填充，请勿修改）
    updatedBy: userProfile('_updated_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  },
  (table) => [
    index('idx_analysis_date').on(table.analysisDate),
    uniqueIndex('idx_analysis_owner_date_ticker').on(table.owner, table.analysisDate, table.ticker),
  ],
);

/**
 * 自选（watchlist）表：观察清单——标的/公司/行业、加入日期、入场价与现价、
 * 评级与信号、目标买价、分析文字；market/currency 默认 'US'/'USD'。
 * (owner.user_id, ticker) 上有唯一索引（同属主同标的仅一条）。
 */
export const watchlist = pgTable(
  'watchlist',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticker: varchar('ticker', { length: 20 }).notNull(),
    company: varchar('company', { length: 255 }),
    sector: varchar('sector', { length: 100 }),
    dateAdded: date('date_added'),
    entryPrice: numeric('entry_price'),
    currentPrice: numeric('current_price'),
    rating: varchar('rating', { length: 30 }),
    signal: varchar('signal', { length: 20 }),
    targetBuy: numeric('target_buy'),
    analysis: text('analysis'),
    owner: userProfile('owner').notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    market: varchar('market', { length: 10 }).default('US'),
    currency: varchar('currency', { length: 10 }).default('USD'),
    // 系统字段：创建时间（自动填充，请勿修改）
    createdAt: customTimestamptz('_created_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：创建者（自动填充，请勿修改）
    createdBy: userProfile('_created_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：更新时间（自动填充，请勿修改）
    updatedAt: customTimestamptz('_updated_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：更新者（自动填充，请勿修改）
    updatedBy: userProfile('_updated_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  },
  (table) => [
    // 复合索引：CREATE UNIQUE INDEX idx_watchlist_owner_ticker ON watchlist USING btree (((owner).user_id), ticker),
  ],
);

/**
 * 持仓（holdings）表：当前持仓——标的/公司/行业、买入日期与买价、股数
 * （默认 '0'）、现价、评级/建议/分析、目标价；多币种字段 market/currency
 * （默认 'US'/'USD'）与本地代码 symbol_native/display_symbol。
 * groupId 关联 groups.id，onDelete: 'set null'（分组删除后持仓保留）。
 * (owner.user_id, ticker) 唯一。
 */
export const holdings = pgTable(
  'holdings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticker: varchar('ticker', { length: 20 }).notNull(),
    company: varchar('company', { length: 255 }),
    sector: varchar('sector', { length: 255 }),
    buyDate: date('buy_date'),
    buyPrice: numeric('buy_price'),
    shares: numeric('shares').notNull().default('0'),
    currentPrice: numeric('current_price'),
    rating: varchar('rating', { length: 500 }),
    action: varchar('action', { length: 500 }),
    analysis: text('analysis'),
    targetPrice: numeric('target_price'),
    groupId: uuid('group_id'),
    owner: userProfile('owner').notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    market: varchar('market', { length: 10 }).default('US'),
    currency: varchar('currency', { length: 10 }).default('USD'),
    symbolNative: varchar('symbol_native', { length: 40 }),
    displaySymbol: varchar('display_symbol', { length: 40 }),
    // 系统字段：创建时间（自动填充，请勿修改）
    createdAt: customTimestamptz('_created_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：创建者（自动填充，请勿修改）
    createdBy: userProfile('_created_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：更新时间（自动填充，请勿修改）
    updatedAt: customTimestamptz('_updated_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：更新者（自动填充，请勿修改）
    updatedBy: userProfile('_updated_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  },
  (table) => [
    // 复合索引：CREATE UNIQUE INDEX idx_holdings_owner_ticker ON holdings USING btree (((owner).user_id), ticker),
    index('idx_holdings_group').on(table.groupId),
    foreignKey({
      columns: [table.groupId],
      foreignColumns: [groups.id],
      name: 'holdings_group_id_fkey',
    }).onDelete('set null'),
  ],
);

/**
 * 持仓分组（groups）表：属主自定义的持仓分组（名称/颜色/排序，sort 默认
 * 0）。(owner.user_id, name) 唯一：同属主下分组名不重复；被 holdings.groupId
 * 引用。
 */
export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 100 }).notNull(),
    color: varchar('color', { length: 20 }),
    sort: integer('sort').default(0),
    owner: userProfile('owner').notNull().default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：创建时间（自动填充，请勿修改）
    createdAt: customTimestamptz('_created_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：创建者（自动填充，请勿修改）
    createdBy: userProfile('_created_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
    // 系统字段：更新时间（自动填充，请勿修改）
    updatedAt: customTimestamptz('_updated_at', { precision: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // 系统字段：更新者（自动填充，请勿修改）
    updatedBy: userProfile('_updated_by').default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  },
  (table) => [
    // 复合索引：CREATE UNIQUE INDEX idx_groups_owner_name ON groups USING btree (((owner).user_id), name),
  ],
);

// 表别名：同一表对象以 XxxTable 名称再导出（历史兼容，便于两种引用风格并存）。
export const agentAuditLogTable = agentAuditLog;
export const agentEvidenceTable = agentEvidence;
export const agentRatingsTable = agentRatings;
export const agentRunsTable = agentRuns;
export const alphaPicksTable = alphaPicks;
export const analysisTable = analysis;
export const bullBearArgumentsTable = bullBearArguments;
export const cashAccountsTable = cashAccounts;
export const closedTable = closed;
export const debateRecordsTable = debateRecords;
export const deepReportTable = deepReport;
export const fxRatesTable = fxRates;
export const groupsTable = groups;
export const holdingsTable = holdings;
export const journalTable = journal;
export const riskGateResultsTable = riskGateResults;
export const snapshotsTable = snapshots;
export const strategyRulesTable = strategyRules;
export const transactionsTable = transactions;
export const watchlistTable = watchlist;

/**
 * AI 模拟盘（paper trading）——与真实记录完全隔离。broker 适配器从构造上就
 * 只做模拟：本节任何表都不连接真实券商账户。
 */

/** 每个用户一个模拟账户；风控阈值（guardrails）以 JSON 内联存储。 */
export const paperAccounts = pgTable('paper_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  owner: userProfile('owner').notNull(),
  baseCurrency: varchar('base_currency', { length: 10 }).default('USD').notNull(),
  initialCash: numeric('initial_cash').default('1000000').notNull(),
  cashBalance: numeric('cash_balance').default('1000000').notNull(),
  botEnabled: boolean('bot_enabled').default(false).notNull(),
  guardrails: jsonb('guardrails')
    .default(sql`'{"dailyLossLimitPct":3,"maxOrderPct":5,"maxOrdersPerDay":10}'::jsonb`)
    .notNull(),
  createdAt: customTimestamptz('created_at', { precision: 3 })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: customTimestamptz('updated_at', { precision: 3 })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});
export const paperAccountsTable = paperAccounts;

/** 模拟持仓：按 (account_id, ticker) 唯一定位；股数与平均成本默认 '0'。 */
export const paperPositions = pgTable('paper_positions', {
  id: uuid('id').primaryKey().defaultRandom(),
  owner: userProfile('owner').notNull(),
  accountId: uuid('account_id').notNull(),
  ticker: varchar('ticker', { length: 20 }).notNull(),
  market: varchar('market', { length: 10 }).default('US').notNull(),
  currency: varchar('currency', { length: 10 }).default('USD').notNull(),
  company: varchar('company', { length: 255 }),
  shares: numeric('shares').default('0').notNull(),
  avgCost: numeric('avg_cost').default('0').notNull(),
  openedAt: customTimestamptz('opened_at', { precision: 3 })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: customTimestamptz('updated_at', { precision: 3 })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});
export const paperPositionsTable = paperPositions;

/** 订单全生命周期，含被风控拒绝的单（status='rejected_risk'）。 */
export const paperOrders = pgTable('paper_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  owner: userProfile('owner').notNull(),
  accountId: uuid('account_id').notNull(),
  ticker: varchar('ticker', { length: 20 }).notNull(),
  market: varchar('market', { length: 10 }).default('US').notNull(),
  currency: varchar('currency', { length: 10 }).default('USD').notNull(),
  company: varchar('company', { length: 255 }),
  side: varchar('side', { length: 10 }).notNull(),
  orderType: varchar('order_type', { length: 10 }).default('market').notNull(),
  quantity: numeric('quantity').notNull(),
  limitPrice: numeric('limit_price'),
  status: varchar('status', { length: 20 }).default('pending').notNull(),
  source: varchar('source', { length: 10 }).default('agent').notNull(),
  reason: text('reason'),
  strategyNote: text('strategy_note'),
  riskCheck: jsonb('risk_check'),
  filledPrice: numeric('filled_price'),
  filledAt: customTimestamptz('filled_at', { precision: 3 }),
  sessionId: uuid('session_id'),
  agentName: varchar('agent_name', { length: 64 }),
  createdAt: customTimestamptz('created_at', { precision: 3 })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});
export const paperOrdersTable = paperOrders;

/** 成交台账：记录已实现盈亏（realized_pl）与成交后现金（cash_after）。 */
export const paperTrades = pgTable('paper_trades', {
  id: uuid('id').primaryKey().defaultRandom(),
  owner: userProfile('owner').notNull(),
  accountId: uuid('account_id').notNull(),
  orderId: uuid('order_id').notNull(),
  ticker: varchar('ticker', { length: 20 }).notNull(),
  market: varchar('market', { length: 10 }).default('US').notNull(),
  side: varchar('side', { length: 10 }).notNull(),
  quantity: numeric('quantity').notNull(),
  price: numeric('price').notNull(),
  fee: numeric('fee').default('0').notNull(),
  realizedPl: numeric('realized_pl'),
  cashAfter: numeric('cash_after').notNull(),
  createdAt: customTimestamptz('created_at', { precision: 3 })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});
export const paperTradesTable = paperTrades;

/** 活动时间线：bot 运行、成交、风控阈值触发等事件（event_type + JSON detail）。 */
export const paperEvents = pgTable('paper_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  owner: userProfile('owner').notNull(),
  accountId: uuid('account_id').notNull(),
  eventType: varchar('event_type', { length: 30 }).notNull(),
  detail: jsonb('detail'),
  createdAt: customTimestamptz('created_at', { precision: 3 })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});
export const paperEventsTable = paperEvents;

/** 每日权益快照：驱动模拟账户的资金曲线（equity/cash/持仓市值/当日盈亏）。 */
export const paperSnapshots = pgTable('paper_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  owner: userProfile('owner').notNull(),
  accountId: uuid('account_id').notNull(),
  snapshotDate: date('snapshot_date').notNull(),
  equity: numeric('equity').notNull(),
  cash: numeric('cash').notNull(),
  positionsValue: numeric('positions_value').default('0').notNull(),
  dailyPl: numeric('daily_pl').default('0').notNull(),
  createdAt: customTimestamptz('created_at', { precision: 3 })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});
export const paperSnapshotsTable = paperSnapshots;

/**
 * 通知渠道表（自托管推送路由）。config 保存各渠道的机密（bark key、
 * serverchan sendkey、telegram token、smtp 凭据、webhook url）——这些数据
 * 永远只留在用户自己的数据库里。
 */
export const notificationChannels = pgTable('notification_channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  owner: userProfile('owner').notNull(),
  channelType: varchar('channel_type', { length: 20 }).notNull(),
  label: varchar('label', { length: 100 }),
  config: jsonb('config').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  createdAt: customTimestamptz('created_at', { precision: 3 })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: customTimestamptz('updated_at', { precision: 3 })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});
export const notificationChannelsTable = notificationChannels;

/**
 * 组合导入历史：每次提交的导入记一行（source：'csv' | 'robinhood' | 'ocr'），
 * 逐行错误保存在 errors（JSON）里；rows_total/rows_imported 统计导入规模。
 */
export const importLogs = pgTable('import_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  owner: userProfile('owner').notNull(),
  source: varchar('source', { length: 20 }).notNull(),
  filename: varchar('filename', { length: 255 }),
  rowsTotal: integer('rows_total').default(0).notNull(),
  rowsImported: integer('rows_imported').default(0).notNull(),
  errors: jsonb('errors'),
  createdAt: customTimestamptz('created_at', { precision: 3 })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});
export const importLogsTable = importLogs;

/**
 * AI agent 会话表（Robinhood 式的 agent 接入）。每个外部 AI 助手一个独立
 * token、每日消费上限（daily_limit_usd，默认 '500'，单位 USD/天）、权限范围
 * （permission，默认 'trade'）与审批模式（approval_mode，默认
 * 'require_approval'）；status 默认 'active'。
 */
export const agentSessions = pgTable('agent_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  owner: userProfile('owner').notNull(),
  name: varchar('name', { length: 64 }).notNull(),
  token: varchar('token', { length: 128 }).notNull(),
  dailyLimitUsd: numeric('daily_limit_usd').default('500').notNull(),
  permission: varchar('permission', { length: 10 }).default('trade').notNull(),
  approvalMode: varchar('approval_mode', { length: 20 }).default('require_approval').notNull(),
  status: varchar('status', { length: 10 }).default('active').notNull(),
  lastUsedAt: customTimestamptz('last_used_at', { precision: 3 }),
  createdAt: customTimestamptz('created_at', { precision: 3 })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: customTimestamptz('updated_at', { precision: 3 })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});
export const agentSessionsTable = agentSessions;

/** 用户配置的新手 agent（builder profile）；每属主仅一个生效 profile。 */
export const builderProfiles = pgTable(
  'builder_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    owner: userProfile('owner').notNull(),
    config: jsonb('config').notNull(),
    status: varchar('status', { length: 12 }).default('draft').notNull(),
    version: integer('version').default(1).notNull(),
    createdAt: customTimestamptz('created_at', { precision: 3 })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: customTimestamptz('updated_at', { precision: 3 })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [index('idx_builder_profiles_owner').on(table.owner)],
);

/** 一条模拟信号 + 投资者独立记录的真实执行结果（用于对照复盘）。 */
export const builderProposals = pgTable(
  'builder_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    owner: userProfile('owner').notNull(),
    profileId: uuid('profile_id').notNull(),
    profileVersion: integer('profile_version').notNull(),
    signalDate: date('signal_date').notNull(),
    ticker: varchar('ticker', { length: 20 }).notNull(),
    market: varchar('market', { length: 10 }).notNull(),
    currency: varchar('currency', { length: 10 }).notNull(),
    side: varchar('side', { length: 10 }).notNull(),
    quantity: numeric('quantity').notNull(),
    referencePrice: numeric('reference_price').notNull(),
    reason: text('reason').notNull(),
    status: varchar('status', { length: 12 }).default('pending').notNull(),
    paperOrderId: uuid('paper_order_id'),
    executedAt: customTimestamptz('executed_at', { precision: 3 }),
    executedQuantity: numeric('executed_quantity'),
    executedPrice: numeric('executed_price'),
    executedFees: numeric('executed_fees'),
    notes: text('notes'),
    expiresAt: customTimestamptz('expires_at', { precision: 3 }).notNull(),
    createdAt: customTimestamptz('created_at', { precision: 3 })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    // 同一 profile 同一信号日同一标的同一方向仅一条提案（防重复发信号）。
    uniqueIndex('idx_builder_proposal_daily').on(
      table.profileId,
      table.signalDate,
      table.ticker,
      table.side,
    ),
    index('idx_builder_proposals_owner_created').on(table.owner, table.createdAt),
  ],
);

/** 用户自有的集成密钥（加密存储）；公开端点永不 select 该表。 */
export const userApiSettings = pgTable('user_api_settings', {
  owner: userProfile('owner').primaryKey(),
  llmBaseUrl: text('llm_base_url'),
  llmFastModel: varchar('llm_fast_model', { length: 120 }),
  llmSlowModel: varchar('llm_slow_model', { length: 120 }),
  llmApiKeyEnc: text('llm_api_key_enc'),
  finnhubApiKeyEnc: text('finnhub_api_key_enc'),
  createdAt: customTimestamptz('created_at', { precision: 3 })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  updatedAt: customTimestamptz('updated_at', { precision: 3 })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});
