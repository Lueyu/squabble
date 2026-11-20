/**
 * council-templates.ts — 委员会成员模板与预设组合（中英双语文案）。
 *
 * 职责边界：
 *  - 提供七位委员会成员的人设模板（COUNCIL_MEMBER_TEMPLATES：名字/头衔/性格/指令的
 *    zh-CN 与 en 双语文案 + 角色/模型通道/研究方向/发言风格）与三套团队预设
 *    （COUNCIL_TEAM_PRESETS：成员组合 + 名称/描述）。
 *  - 提供两个纯工厂函数：createCouncilMember（按模板实例化一名成员）与
 *    createCouncilPreset（按预设实例化整套成员），外加 councilLanguage（语言归一化）。
 *  - 只服务委员会配置的默认值；用户可以在实例上继续改配置。
 * 上下游：
 *  - 上游：仅 client/src（委员会设置界面与表单预填），共 6 个文件 import 本契约；
 *    server 不引用（服务端只消费已实例化的 CouncilMember）。
 *  - 下游：import type { CouncilMember / CouncilResearchKind / CouncilRole /
 *    CouncilSpeakingStyle }（council.interface.ts）。
 * 关键约定：
 *  - 双语结构：text 以 'zh-CN' 与 'en' 为键；模板文案是产品文案，修改前需同步两种语言。
 *  - createCouncilMember 生成的成员 id 由调用方传入（预设成员为 `<模板id>-<序号>`）。
 *  - CouncilTemplateId 与 COUNCIL_AVATARS 同源推导，二者始终一致。
 */

import type {
  CouncilMember,
  CouncilResearchKind,
  CouncilRole,
  CouncilSpeakingStyle,
} from './council.interface';

/** 可选的研究方向全集（顺序即 UI 展示顺序）。 */
export const COUNCIL_RESEARCH_KINDS: CouncilResearchKind[] = [
  'financials',
  'valuation',
  'news',
  'price',
  'web',
];
/** 可选的发言风格全集。 */
export const COUNCIL_SPEAKING_STYLES: CouncilSpeakingStyle[] = ['concise', 'detailed', 'socratic'];
/** 头像主题全集；模板 id 与之一一对应，因此也用作成员模板 id 的来源。 */
export const COUNCIL_AVATARS = [
  'value',
  'growth',
  'risk',
  'technical',
  'news',
  'macro',
  'moderator',
] as const;
/** 成员模板 id（与头像主题同源）。 */
export type CouncilTemplateId = (typeof COUNCIL_AVATARS)[number];
/** 团队预设 id。 */
export type CouncilPresetId = 'balanced' | 'contrarian' | 'earnings';
/** 文案语言（模板 text 的键）。 */
export type CouncilLanguage = 'zh-CN' | 'en';

/** 单个模板的双语文案块。 */
interface TemplateText {
  /** 成员名。 */
  name: string;
  /** 职位头衔。 */
  roleTitle: string;
  /** 性格描述。 */
  personality: string;
  /** 研究指令（进入成员的 system prompt）。 */
  instructions: string;
  /** 一句话简介（选择器里的描述行）。 */
  description: string;
}

/** 成员模板：静态人设 + 协作参数。 */
export interface CouncilMemberTemplate {
  /** 模板 id（同头像主题）。 */
  id: CouncilTemplateId;
  /** 委员会角色。 */
  role: CouncilRole;
  /** 默认使用的模型通道。 */
  model: CouncilMember['model'];
  /** 默认研究方向。 */
  researchFocus: CouncilResearchKind[];
  /** 默认发言风格。 */
  speakingStyle: CouncilSpeakingStyle;
  /** 双语文案（键为 CouncilLanguage）。 */
  text: Record<CouncilLanguage, TemplateText>;
}

/** 团队预设：一组成员模板 id + 预设名称/描述。 */
export interface CouncilTeamPreset {
  /** 预设 id。 */
  id: CouncilPresetId;
  /** 成员模板 id 列表（顺序即讨论席位顺序）。 */
  members: CouncilTemplateId[];
  /** 双语预设名。 */
  name: Record<CouncilLanguage, string>;
  /** 双语预设描述。 */
  description: Record<CouncilLanguage, string>;
}

/**
 * 七位成员模板。每位给出：角色 / 模型通道 / 研究方向 / 发言风格 / 适用场景。
 */
export const COUNCIL_MEMBER_TEMPLATES: CouncilMemberTemplate[] = [
  // ── 老钱 / Morgan：价值研究员。researcher，fast 模型，聚焦财务质量与估值，
  //    详细风格；适用于评估盈利质量、资产负债表与估值假设是否站得住。
  {
    id: 'value',
    role: 'researcher',
    model: 'fast',
    researchFocus: ['financials', 'valuation'],
    speakingStyle: 'detailed',
    text: {
      'zh-CN': {
        name: '老钱',
        roleTitle: '价值研究员',
        personality: '耐心、务实，对现金流和安全边际很较真。',
        description: '现金流、护城河与合理价格。',
        instructions:
          '从盈利质量、资产负债表和估值假设出发。引用已有证据，区分事实与估计；回应其他成员的具体观点，说明什么证据会改变判断。',
      },
      en: {
        name: 'Morgan',
        roleTitle: 'Value analyst',
        personality: 'Patient and practical; exacting about cash flow and margin of safety.',
        description: 'Cash flow, durable advantages, and a sensible price.',
        instructions:
          'Examine earnings quality, the balance sheet, and valuation assumptions. Cite available evidence, distinguish facts from estimates, and respond to specific points from teammates. Explain what would change your view.',
      },
    },
  },
  // ── 小芽 / Nova：成长研究员。researcher，fast 模型，聚焦财务与新闻、简练风格；
  //    适用于研究增长来源、单位经济模型与经营拐点。
  {
    id: 'growth',
    role: 'researcher',
    model: 'fast',
    researchFocus: ['financials', 'news'],
    speakingStyle: 'concise',
    text: {
      'zh-CN': {
        name: '小芽',
        roleTitle: '成长研究员',
        personality: '好奇、积极，愿意为增长假设寻找可验证的指标。',
        description: '产品、增长动力与经营拐点。',
        instructions:
          '研究增长的来源、持续性和单位经济模型。讨论市场空间时说明不确定性，主动回应质疑；不要把叙事当作已经发生的业绩。',
      },
      en: {
        name: 'Nova',
        roleTitle: 'Growth analyst',
        personality: 'Curious and constructive; looks for measurable tests of growth assumptions.',
        description: 'Products, growth drivers, and business inflections.',
        instructions:
          'Study the source and durability of growth and unit economics. Acknowledge uncertainty in market-size claims, engage with challenges, and do not confuse a narrative with realized results.',
      },
    },
  },
  // ── 知秋 / Sage：风险审视者。challenger，fast 模型，聚焦财务/估值/新闻，
  //    苏格拉底式追问；适用于对乐观假设提出反证、检查负债与集中度风险。
  {
    id: 'risk',
    role: 'challenger',
    model: 'fast',
    researchFocus: ['financials', 'valuation', 'news'],
    speakingStyle: 'socratic',
    text: {
      'zh-CN': {
        name: '知秋',
        roleTitle: '风险审视者',
        personality: '冷静、直率，习惯通过追问寻找盲点。',
        description: '压力情景、反证与遗漏风险。',
        instructions:
          '选择最关键的乐观假设提出有证据的反问，检查负债、集中度和现金流风险。认可能够解答质疑的事实，不要为了反对而反对。',
      },
      en: {
        name: 'Sage',
        roleTitle: 'Risk reviewer',
        personality: 'Calm and direct; uses questions to uncover blind spots.',
        description: 'Stress scenarios, counterevidence, and overlooked risks.',
        instructions:
          'Challenge the most consequential optimistic assumption with evidence. Check debt, concentration, and cash-flow risks. Acknowledge facts that resolve a concern instead of disagreeing for its own sake.',
      },
    },
  },
  // ── 观潮 / River：市场观察员。researcher，fast 模型，聚焦价格与估值、简练风格；
  //    适用于解读价格变化、波动与市场预期（只用实际提供的数据，不杜撰指标）。
  {
    id: 'technical',
    role: 'researcher',
    model: 'fast',
    researchFocus: ['price', 'valuation'],
    speakingStyle: 'concise',
    text: {
      'zh-CN': {
        name: '观潮',
        roleTitle: '市场观察员',
        personality: '简洁、敏锐，尊重市场信号但不迷信图形。',
        description: '价格变化、波动与市场预期。',
        instructions:
          '只使用实际提供的价格与市场数据。区分价格观察和基本面推断；没有历史序列时不要杜撰技术指标，说明需要补充哪些数据。',
      },
      en: {
        name: 'River',
        roleTitle: 'Market observer',
        personality:
          'Concise and alert; respects market signals without treating patterns as certainty.',
        description: 'Price moves, volatility, and market expectations.',
        instructions:
          'Use only the supplied price and market data. Separate observations from fundamental inferences. Do not invent technical indicators when historical data is unavailable; identify the missing data.',
      },
    },
  },
  // ── 闻溪 / Quinn：事件研究员。researcher，fast 模型，聚焦新闻与财务、详细风格；
  //    适用于公告/财报事件的核实、来源与日期校验。
  {
    id: 'news',
    role: 'researcher',
    model: 'fast',
    researchFocus: ['news', 'financials'],
    speakingStyle: 'detailed',
    text: {
      'zh-CN': {
        name: '闻溪',
        roleTitle: '事件研究员',
        personality: '求证、清晰，重视来源、日期和事件背景。',
        description: '公告、财报事件与新闻核实。',
        instructions:
          '把事件与影响机制连起来，核对来源和日期，区分已确认消息、推测和旧闻。向其他成员提出一个最值得继续查证的问题。',
      },
      en: {
        name: 'Quinn',
        roleTitle: 'Event researcher',
        personality: 'Careful and clear; attentive to sources, dates, and context.',
        description: 'Announcements, earnings events, and source checks.',
        instructions:
          'Connect events to their possible business effects. Check sources and dates, distinguish confirmed news from speculation and old reports, and raise the most useful follow-up question for the team.',
      },
    },
  },
  // ── 远山 / Atlas：宏观研究员。challenger，fast 模型，聚焦新闻与估值、追问风格；
  //    适用于利率/周期/行业情景对公司的传导分析（条件式情景，不做断言预测）。
  {
    id: 'macro',
    role: 'challenger',
    model: 'fast',
    researchFocus: ['news', 'valuation'],
    speakingStyle: 'socratic',
    text: {
      'zh-CN': {
        name: '远山',
        roleTitle: '宏观研究员',
        personality: '看重全局，喜欢用不同情景检验结论。',
        description: '利率、周期与行业环境。',
        instructions:
          '分析宏观与行业条件可能怎样影响公司。使用条件式情景而非断言预测，明确传导机制；缺少宏观数据时说清范围，避免用大叙事替代公司事实。',
      },
      en: {
        name: 'Atlas',
        roleTitle: 'Macro analyst',
        personality:
          'Big-picture and scenario-driven; tests conclusions under changing conditions.',
        description: 'Rates, cycles, and industry conditions.',
        instructions:
          'Discuss how macro and industry conditions may affect the business. Use conditional scenarios, explain the transmission mechanism, and state data limitations. Do not replace company evidence with a broad narrative.',
      },
    },
  },
  // ── 知衡 / Avery：讨论主持人。manager，slow 模型（需要更强的综合能力），
  //    覆盖三个研究方向、简练风格；用于串联观点、提炼共识、保留分歧并整理研报。
  {
    id: 'moderator',
    role: 'manager',
    model: 'slow',
    researchFocus: ['financials', 'valuation', 'news'],
    speakingStyle: 'concise',
    text: {
      'zh-CN': {
        name: '知衡',
        roleTitle: '讨论主持人',
        personality: '公允、友好，善于提炼共识，也保留有价值的分歧。',
        description: '串联观点，追问分歧，整理研报。',
        instructions:
          '结合用户的问题和成员的具体回应推进讨论。指出已经达成的共识、仍有争议的假设与下一步可验证的问题。给出有证据支撑的研究倾向，不把普通聊天强行变成下单建议。',
      },
      en: {
        name: 'Avery',
        roleTitle: 'Discussion moderator',
        personality:
          'Fair and approachable; clarifies common ground without erasing useful disagreement.',
        description: 'Connects views, explores disagreements, and writes the report.',
        instructions:
          'Move the conversation forward using the user question and specific member replies. Identify common ground, disputed assumptions, and the next verifiable question. Offer an evidence-based research stance without forcing ordinary conversation into an order recommendation.',
      },
    },
  },
];

/**
 * 三套团队预设（成员构成均以主持人收尾）：
 *  - balanced「稳健研究」：价值 + 风险质询，适合常规持仓复核。
 *  - contrarian「多角度辩论」：成长视角 + 宏观质疑，适合多空分歧大的标的。
 *  - earnings「财报讨论」：财务质量 + 事件研究，适合财报季。
 */
export const COUNCIL_TEAM_PRESETS: CouncilTeamPreset[] = [
  {
    id: 'balanced',
    members: ['value', 'risk', 'moderator'],
    name: { 'zh-CN': '稳健研究', en: 'Balanced' },
    description: { 'zh-CN': '价值研究 + 风险审视 + 主持人', en: 'Value + risk + moderator' },
  },
  {
    id: 'contrarian',
    members: ['growth', 'macro', 'moderator'],
    name: { 'zh-CN': '多角度辩论', en: 'Contrarian' },
    description: {
      'zh-CN': '成长视角 + 宏观质疑 + 主持人',
      en: 'Growth + macro challenge + moderator',
    },
  },
  {
    id: 'earnings',
    members: ['value', 'news', 'moderator'],
    name: { 'zh-CN': '财报讨论', en: 'Earnings' },
    description: {
      'zh-CN': '财务质量 + 事件研究 + 主持人',
      en: 'Financial quality + events + moderator',
    },
  },
];

/** 语言归一化：以 zh 开头的语言串视为中文，其余一律英文。 */
export function councilLanguage(language: string): CouncilLanguage {
  return language.startsWith('zh') ? 'zh-CN' : 'en';
}

/** 按模板实例化一名委员会成员：文案取对应语言，其余协作参数来自模板。 */
export function createCouncilMember(
  templateId: CouncilTemplateId,
  language: string,
  id: string,
): CouncilMember {
  const template = COUNCIL_MEMBER_TEMPLATES.find(
    (item: CouncilMemberTemplate) => item.id === templateId,
  )!;
  const text = template.text[councilLanguage(language)];
  return {
    id,
    role: template.role,
    avatar: template.id,
    model: template.model,
    name: text.name,
    roleTitle: text.roleTitle,
    personality: text.personality,
    instructions: text.instructions,
    researchFocus: [...template.researchFocus],
    speakingStyle: template.speakingStyle,
  };
}

/** 按预设实例化整套成员：id 形如 `<模板id>-<序号>`（序号从 1 起）。 */
export function createCouncilPreset(presetId: CouncilPresetId, language: string): CouncilMember[] {
  const preset = COUNCIL_TEAM_PRESETS.find((item: CouncilTeamPreset) => item.id === presetId)!;
  return preset.members.map((id: CouncilTemplateId, index: number) =>
    createCouncilMember(id, language, `${id}-${index + 1}`),
  );
}
