/**
 * @file utils/council-state.ts
 * @description Council 会话状态判定与配置校验的纯函数集合。
 *
 * 职责边界：
 *  - 只做"给定输入 → 布尔/错误码"的判定；不发请求、不碰缓存
 * 上下游：
 *  - 上游（谁调用这里）：shouldSendCouncilMessage / shouldStartCouncilAfterMessage /
 *    councilMessageDisplayContent → Council/CouncilConversation；
 *    councilMessageDisplayContent → Council/CouncilChatMessage；
 *    isCurrentCouncilReport → CouncilReportCard、CouncilReports；
 *    validateCouncilSettings → CouncilTeamEditor、CouncilNewDialog、
 *    AgentBuilder/BuilderWizard（后者搭配 DEFAULT_CADENCE）；
 *    budgetPercent / validateBudget → Settings/BudgetPanel
 *  - 下游（本文件调用谁）：@shared/council-templates 的常量（头像/研究类型/
 *    发言风格白名单，供成员校验）
 * 关键约定：
 *  - 校验函数返回固定错误码（'teamInvalid' | 'cadenceInvalid' | 'invalid' |
 *    'priceInvalid' | 'inconsistent' | null），调用方据此展示文案
 */
import type {
  CouncilConfig,
  CouncilMessage,
  CouncilReport,
  CouncilSession,
  LlmBudgetSettings,
  TradingCadence,
} from '@shared/council.interface';
import {
  COUNCIL_AVATARS,
  COUNCIL_RESEARCH_KINDS,
  COUNCIL_SPEAKING_STYLES,
} from '@shared/council-templates';

/** 默认交易节奏：每 5 个交易日复盘、每周最多 2 单、冷却 3 天、周换手 ≤10%。 */
export const DEFAULT_CADENCE: TradingCadence = {
  reviewEveryTradingDays: 5,
  maxOrdersPerWeek: 2,
  cooldownTradingDays: 3,
  maxWeeklyTurnoverPct: 10,
};

/**
 * 判断保存消息后是否应自动触发一轮发言。
 * 一条消息绝不会唤醒已暂停/失败的会话，也不会叠加第二个进行中的运行：
 * 仅当前次状态为 idle/completed 且保存后仍为 idle 时才自动启动。
 */
export function shouldStartCouncilAfterMessage(
  previousStatus: CouncilSession['status'],
  savedStatus: CouncilSession['status'],
): boolean {
  return (previousStatus === 'idle' || previousStatus === 'completed') && savedStatus === 'idle';
}

/**
 * 判断一次键盘事件是否意味着"发送 Council 消息"。
 * 规则：Enter 且未按 Shift、不在输入法组词中、keyCode 非 229（IME 确认键）。
 */
export function shouldSendCouncilMessage(event: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
}): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

// 证据行的 UUID 片段与"整行只有一串内联证据 ID"的匹配正则。
const EVIDENCE_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const INTERNAL_EVIDENCE_LINE = new RegExp(
  `^\\s*\\[\\s*${EVIDENCE_UUID}(?:\\s*,\\s*${EVIDENCE_UUID})*\\s*\\]\\s*$`,
  'iu',
);

/**
 * 过滤 Council 消息的展示内容。
 * 旧版 AI 回复里混入了内部证据 ID 行；来源明细保留在报告中，这里把
 * "整行只有内联证据 ID"的行从展示里剔除。用户/系统消息原样返回。
 */
export function councilMessageDisplayContent(
  message: Pick<CouncilMessage, 'role' | 'content'>,
): string {
  // 用户/系统消息不过滤。
  if (message.role === 'user' || message.role === 'system') return message.content;
  // 逐行剔除内联证据 ID 行后重新拼接。
  return message.content
    .split('\n')
    .filter((line: string) => !INTERNAL_EVIDENCE_LINE.test(line))
    .join('\n');
}

/**
 * 判断一份报告是否仍是当前版本（可展示的"最新结论"）。
 * 条件：revision 与会话一致、（给了 profileVersion 时）成员配置版本一致、
 * 且会话里没有 version 更高的报告。
 */
export function isCurrentCouncilReport(
  report: CouncilReport,
  session: CouncilSession,
  profileVersion?: number,
): boolean {
  return (
    report.revision === session.revision &&
    (profileVersion === undefined || session.profileVersion === profileVersion) &&
    !session.reports.some((item: CouncilReport) => item.version > report.version)
  );
}

/**
 * 计算 LLM 预算已用百分比。
 * limit ≤ 0 视为未设预算返回 0；结果收敛到 [0, 100]。
 */
export function budgetPercent(used: number, limit: number): number {
  return limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : 0;
}

/**
 * 校验 Council 团队配置与交易节奏。
 * @returns 配置非法返回 'teamInvalid'，节奏非法返回 'cadenceInvalid'，
 *          全部通过返回 null。
 */
export function validateCouncilSettings(
  council: CouncilConfig | undefined,
  cadence: TradingCadence | undefined,
): 'teamInvalid' | 'cadenceInvalid' | null {
  // 团队校验：数量 2-6、恰好一名 manager、id 唯一，以及逐成员的
  // id/名称/角色/模型/指令长度/执行模式/agentId 格式/头衔/性格/连接 UUID/
  // 头像与发言风格白名单/研究焦点（去重、≤5 个、web 焦点需开 webResearch）。
  if (council?.enabled) {
    const members = council.members;
    if (
      members.length < 2 ||
      members.length > 6 ||
      members.filter((member) => member.role === 'manager').length !== 1 ||
      new Set(members.map((member) => member.id)).size !== members.length ||
      members.some(
        (member) =>
          !member.id.trim() ||
          member.id.length > 32 ||
          !member.name.trim() ||
          member.name.length > 40 ||
          !['researcher', 'challenger', 'manager'].includes(member.role) ||
          !['fast', 'slow'].includes(member.model) ||
          member.instructions.length > 1000 ||
          (member.executionMode !== undefined &&
            !['model', 'local'].includes(member.executionMode)) ||
          (member.executionMode === 'local' &&
            !/^[a-zA-Z0-9_-]{1,64}$/.test(member.agentId ?? '')) ||
          (member.roleTitle?.length ?? 0) > 60 ||
          (member.personality?.length ?? 0) > 240 ||
          (member.connectionId &&
            !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(member.connectionId)) ||
          (member.avatar && !COUNCIL_AVATARS.includes(member.avatar)) ||
          (member.speakingStyle && !COUNCIL_SPEAKING_STYLES.includes(member.speakingStyle)) ||
          (member.researchFocus &&
            (member.researchFocus.length > 5 ||
              new Set(member.researchFocus).size !== member.researchFocus.length ||
              member.researchFocus.some(
                (focus) =>
                  !COUNCIL_RESEARCH_KINDS.includes(focus) ||
                  (focus === 'web' && member.executionMode !== 'local' && !council.webResearch),
              ))),
      )
    )
      return 'teamInvalid';
  }
  // 节奏校验：四个字段均为整数且落在各自区间（复盘 1-60 天、每周 1-20 单、
  // 冷却 0-60 天、周换手 0.1-100%）。
  if (
    cadence &&
    (!Number.isInteger(cadence.reviewEveryTradingDays) ||
      cadence.reviewEveryTradingDays < 1 ||
      cadence.reviewEveryTradingDays > 60 ||
      !Number.isInteger(cadence.maxOrdersPerWeek) ||
      cadence.maxOrdersPerWeek < 1 ||
      cadence.maxOrdersPerWeek > 20 ||
      !Number.isInteger(cadence.cooldownTradingDays) ||
      cadence.cooldownTradingDays < 0 ||
      cadence.cooldownTradingDays > 60 ||
      !Number.isFinite(cadence.maxWeeklyTurnoverPct) ||
      cadence.maxWeeklyTurnoverPct < 0.1 ||
      cadence.maxWeeklyTurnoverPct > 100)
  ) {
    return 'cadenceInvalid';
  }
  return null;
}

/**
 * 校验 LLM 预算设置的合法性与一致性。
 * @returns 'invalid'（数值非法/超上限）、'priceInvalid'（单价非法）、
 *          'inconsistent'（上下限互相矛盾）或 null（通过）。
 */
export function validateBudget(settings: LlmBudgetSettings): string | null {
  // 步骤 1：七个上限字段都必须是正的安全整数。
  const caps: number[] = [
    settings.dailyTokenLimit,
    settings.monthlyTokenLimit,
    settings.perTaskTokenLimit,
    settings.maxInputTokens,
    settings.maxOutputTokens,
    settings.maxCallsPerTask,
    settings.dailyCallLimit,
  ];
  if (caps.some((value: number) => !Number.isSafeInteger(value) || value <= 0)) return 'invalid';
  // 步骤 2：各上限不得越过绝对天花板（token 1e9 / 输入输出 1e6 /
  // 每任务 1 万次 / 每日 10 万次）。
  if (
    Math.max(settings.dailyTokenLimit, settings.monthlyTokenLimit, settings.perTaskTokenLimit) >
      1e9 ||
    Math.max(settings.maxInputTokens, settings.maxOutputTokens) > 1e6 ||
    settings.maxCallsPerTask > 10000 ||
    settings.dailyCallLimit > 100000
  )
    return 'invalid';
  // 步骤 3：单价（每百万 token 美元）为 null 表示未填；填了则须非负且 ≤100000。
  if (
    [settings.inputUsdPerMillion, settings.outputUsdPerMillion].some(
      (value: number | null) =>
        value !== null && (!Number.isFinite(value) || value < 0 || value > 100000),
    )
  )
    return 'priceInvalid';
  // 步骤 4：层级一致性 —— 输入+输出 ≤ 每任务 ≤ 每日 ≤ 每月；每任务次数 ≤ 每日次数。
  if (
    settings.maxInputTokens + settings.maxOutputTokens > settings.perTaskTokenLimit ||
    settings.perTaskTokenLimit > settings.dailyTokenLimit ||
    settings.dailyTokenLimit > settings.monthlyTokenLimit ||
    settings.maxCallsPerTask > settings.dailyCallLimit
  )
    return 'inconsistent';
  return null;
}
