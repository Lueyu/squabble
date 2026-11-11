import type { TeamDisplay, TeamLayout, TeamSemanticConfig } from './team-workspace.interface';

export interface TeamTemplate {
  id: string; category: 'professional' | 'playful';
  name: { 'zh-CN': string; en: string }; description: { 'zh-CN': string; en: string };
  researchSources: { title: string; url: string; year: number; evidence: 'preprint' }[];
  config: TeamSemanticConfig; display: TeamDisplay; layout: TeamLayout;
}
type RoleSeed = [name: string, responsibility: string, expectedOutput: string];
const SOURCES = {
  trading: { title: 'TradingAgents: Multi-Agents LLM Financial Trading Framework', url: 'https://arxiv.org/abs/2412.20138', year: 2025, evidence: 'preprint' as const },
  fincon: { title: 'FinCon: A Synthesized LLM Multi-Agent System with Conceptual Verbal Reinforcement', url: 'https://arxiv.org/abs/2407.06567', year: 2024, evidence: 'preprint' as const },
  alpha: { title: 'AlphaAgents: Large Language Model based Multi-Agents for Equity Portfolio Constructions', url: 'https://arxiv.org/abs/2508.11152', year: 2025, evidence: 'preprint' as const },
  expert: { title: 'Toward Expert Investment Teams: A Multi-Agent LLM System with Fine-Grained Trading Tasks', url: 'https://arxiv.org/abs/2602.23330', year: 2026, evidence: 'preprint' as const },
  contest: { title: 'ContestTrade: A Multi-Agent Trading System Based on Internal Contest Mechanism', url: 'https://arxiv.org/abs/2508.00554', year: 2025, evidence: 'preprint' as const },
  robot: { title: 'FinRobot: An Open-Source AI Agent Platform for Financial Applications', url: 'https://arxiv.org/abs/2405.14767', year: 2024, evidence: 'preprint' as const },
};
// Stable template-local UUIDs are remapped on creation; templates convey no credentials or grants.
function build(index: number, id: string, category: TeamTemplate['category'], zh: string, en: string,
  description: string, englishDescription: string, roles: RoleSeed[], sources: (keyof typeof SOURCES)[], matrix = false): TeamTemplate {
  const uuid = (n: number) => `b0000000-${String(index).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;
  const departments = [
    { id: uuid(1), parentDepartmentId: null, purpose: '研究与综合判断 / Research and synthesis' },
    { id: uuid(2), parentDepartmentId: null, purpose: '反证与风险复核 / Challenge and risk review' },
  ];
  const nodes = roles.map(([name, responsibility, expectedOutput], i) => ({
    id: uuid(10 + i), departmentId: departments[i === roles.length - 1 ? 1 : 0].id,
    participation: 'placeholder' as const, responsibility, expectedOutput, executor: null,
    allowedToolIds: [] as string[], sourceGrantIds: [] as string[],
  }));
  const relations: TeamSemanticConfig['relations'] = nodes.slice(1).map((role, i) => ({
    id: uuid(100 + i), fromRoleId: role.id, toRoleId: nodes[0].id,
    kind: 'reports_to', responsibilityScope: roles[i + 1][1],
  }));
  if (matrix) relations.push({ id: uuid(200), fromRoleId: nodes[2].id, toRoleId: nodes[1].id,
    kind: 'reports_to', responsibilityScope: '财务口径与流动性专项 / Accounting and liquidity' });
  relations.push({ id: uuid(201), fromRoleId: nodes.at(-1)!.id, toRoleId: nodes[0].id,
    kind: 'reviews', responsibilityScope: '最强反证、来源独立性、未知项与风险边界 / Counterevidence and limits' });
  const positions: TeamLayout['positions'] = {
    [departments[0].id]: { x: 20, y: 20, width: 940, height: 590 },
    [departments[1].id]: { x: 1000, y: 20, width: 350, height: 590 },
  };
  nodes.forEach((role, i) => { positions[role.id] = i === nodes.length - 1
    ? { x: 35, y: 160 } : { x: 30 + (i % 3) * 295, y: 85 + Math.floor(i / 3) * 215 }; });
  return { id, category, name: { 'zh-CN': zh, en }, description: { 'zh-CN': description, en: englishDescription },
    researchSources: sources.map(key => SOURCES[key]),
    config: { schemaVersion: 1, departments, roles: nodes, relations, defaults: { leadRoleId: nodes[0].id, parallelism: 1 } },
    display: { name: zh, avatar: null, departmentLabels: { [uuid(1)]: '研究组 / Research', [uuid(2)]: '独立复核 / Review' },
      roleLabels: Object.fromEntries(nodes.map((role, i) => [role.id, roles[i][0]])) },
    layout: { schemaVersion: 1, positions, collapsedDepartmentIds: [], viewport: { x: 0, y: 0, zoom: 0.8 } } };
}

/** Research-inspired starting points, not reproductions of paper results or performance claims. */
export const TEAM_TEMPLATES: readonly TeamTemplate[] = [
  build(1, 'bull-bear-committee', 'professional', '多空辩论投委会', 'Bull–bear committee',
    '以专业分析、多空论证和风险复核构成有限辩论。适合检验单一投资命题；结构受 TradingAgents 启发，未复现其回测。',
    'Specialists, opposing theses and risk review for a bounded investment debate; inspired by TradingAgents.', [
      ['投委会主席 / Chair', '综合证据与反证，记录分歧，形成唯一最终判断', '判断、分歧、行动建议及再核查条件'],
      ['基本面研究员 / Fundamentals', '核查业务质量、财报口径与现金流', '可比数据、来源版本及一次性因素'],
      ['估值研究员 / Valuation', '评估合理价值区间和关键假设敏感性', '估值区间、假设表与不确定性'],
      ['多方研究员 / Bull', '建立有证据的最强正面情景，写清失效条件', '正面论据、催化剂与失效条件'],
      ['空方研究员 / Bear', '寻找最强反证，独立检查共识中的脆弱前提', '反证、替代解释与证据缺口'],
      ['风险复核员 / Risk', '复核集中度、流动性、费用与下行情景', '风险边界、反证与待人工确认事项'],
    ], ['trading']),
  build(2, 'reflective-manager', 'professional', '判断记忆与复盘团队', 'Reflective investment team',
    '经理—分析员分工，将当时判断与后续证据对照，保留修正原因。受 FinCon 启发；不自动修改策略或付费重跑。',
    'A manager–analyst hierarchy with explicit belief revisions, inspired by FinCon.', [
      ['投资经理 / Manager', '综合当前研究与历史判断，区分事实变化和观点变化', '判断版本、修订原因与决策提案'],
      ['公司分析员 / Company', '核查经营与财务变化', '基本面变化表和原始出处'],
      ['宏观分析员 / Macro', '核查利率、需求、汇率对本次命题的影响', '传导机制、范围及未知项'],
      ['市场分析员 / Market', '核查价格、成交与预期变化，不用价格倒推事实', '市场证据及替代解释'],
      ['复盘记录员 / Reflection', '对照原始判断与新证据，禁止事后改写原假设', '支持、削弱、无法确认的前提清单'],
      ['风险挑战员 / Challenger', '复核记忆引用、来源独立性和下行风险', '反证、风险与复核条件'],
    ], ['fincon']),
  build(3, 'portfolio-specialists', 'professional', '多视角组合研究组', 'Portfolio specialists',
    '分别研究基本面、情绪与技术信号，再核查组合层面的相关性和风险。受 AlphaAgents 启发；不把个股信号直接当最优组合。',
    'Role-based equity research with portfolio-level risk checks, inspired by AlphaAgents.', [
      ['组合经理 / Portfolio lead', '综合不同视角，解释资产之间的相关性与取舍', '组合理由、权重提案及等待条件'],
      ['基本面分析 / Fundamental', '研究经营、现金流和估值基础', '财务事实及估值前提'],
      ['预期与情绪 / Sentiment', '区分事件事实、市场叙事与情绪噪声', '事件来源、预期差与证据等级'],
      ['价格与技术 / Technical', '验证价格与成交信号的样本范围和失效条件', '信号定义、数据范围和限制'],
      ['组合风险 / Portfolio risk', '复核相关性、集中度、流动性与交易费用', '组合风险、反证与约束'],
    ], ['alpha']),
  build(4, 'fine-grained-diligence', 'professional', '细粒度财报尽调组', 'Fine-grained diligence',
    '将宽泛观点拆为可验证的财务、行业、估值与反证任务。借鉴 2026 年细粒度投资团队研究，强调精确输入与交付。',
    'Fine-grained, verifiable research assignments inspired by 2026 expert-team research.', [
      ['尽调负责人 / Diligence lead', '拆清本次投资命题，综合专项交付', '结论、依据、未知项和下一步'],
      ['口径核对员 / Accounting', '核查跨期会计口径、合并范围与一次性因素', '口径差异和可比数据表'],
      ['现金流专家 / Cash flow', '核查订单到回款的转化，排除营运资本和融资影响', '现金流桥接、来源及反证'],
      ['行业研究员 / Industry', '检验需求、竞争与行业传导机制', '行业事实、竞争假设与范围'],
      ['估值建模员 / Valuation', '列明关键假设并进行情景敏感性分析', '情景估值与关键假设'],
      ['反证审查员 / Review', '检查数据身份、结论跳跃和最强反证', '问题清单及复核意见'],
    ], ['expert', 'robot']),
  build(5, 'competing-hypotheses', 'professional', '竞争假设研究组', 'Competing hypotheses',
    '让不同小组独立构造解释，再按同一证据清单比较，不以多数票认定正确。受 ContestTrade 启发，保留无法确认。',
    'Independent competing hypotheses compared on shared evidence, inspired by ContestTrade.', [
      ['裁决负责人 / Synthesis', '按证据质量比较竞争解释，保留少数意见', '取舍记录、未知项和最终提案'],
      ['增长假设组 / Growth', '解释增长、需求与现金流转化', '增长假设、来源与可证伪条件'],
      ['周期假设组 / Cycle', '检查周期、库存与基数效应的替代解释', '替代情景及验证指标'],
      ['执行条件员 / Execution', '核查费用、流动性和实际行动条件', '执行限制、成本与等待条件'],
      ['独立审查 / Independent review', '复核样本、证据独立性和风险，不把共享来源计多次', '证据去重、风险及反证'],
    ], ['contest']),
  build(6, 'matrix-specialists', 'professional', '矩阵专项研究团队', 'Matrix specialist team',
    '财务专家同时向研究与风险负责人汇报，每次研究只指定一名最终负责人。结合 FinRobot 专业工具链与 FinCon 层级协作作产品化改编。',
    'A product adaptation of specialized financial toolchains and manager–analyst collaboration, with matrix reporting.', [
      ['研究负责人 / Research lead', '确定本次问题并形成最终综合判断', '综合判断和决策依据'],
      ['风险负责人 / Risk lead', '提出跨组风险核查要求，不扩张本次授权', '风险问题和约束'],
      ['共享财务专家 / Finance', '核查财务口径、经营现金流与流动性反证', '一份可被多主管引用的专项交付'],
      ['估值专家 / Valuation', '验证估值与资本配置假设', '估值区间与失效条件'],
      ['复核委员 / Reviewer', '独立复核关键前提和跨主管指令冲突', '反证、未知项和取舍建议'],
    ], ['robot', 'fincon'], true),
  build(7, 'huawei-style', 'playful', '华为系 · 投研铁三角', 'Huawei-style research triangle',
    '虚构趣味模板：命题、方案、交付协同，蓝军专挑漏洞。借用组织梗，不代表华为真实架构或背书。',
    'A fictional playful triangle of thesis, solution and delivery with a challenger; no company affiliation.', [
      ['轮值投委主席 / Chair', '综合各组证据，对本次最终判断负责', '结论、取舍和行动提案'],
      ['命题客户经理 / Thesis owner', '把投资需求翻译为可验证命题，拒绝空洞口号', '命题、成功指标和失效条件'],
      ['估值解决方案 / Solution', '设计估值情景与可检验方案', '估值框架和情景比较'],
      ['财报交付经理 / Delivery', '核查原始资料、口径和现金流交付质量', '可追溯数据与缺口'],
      ['蓝军研究室 / Red team', '提出最强反证，检查共识中的逻辑漏洞', '反证报告和替代解释'],
      ['风险与合规哨 / Risk', '复核本次权限、预算、集中度与风险边界', '风险限制和待核查事项'],
    ], []),
  build(8, 'bytedance-style', 'playful', '字节系 · 指标与反实验室', 'ByteDance-style metric lab',
    '虚构趣味模板：先写指标和证伪条件，再让实验组与反实验组交叉核查。不代表字节真实组织。',
    'A fictional playful metric lab with experiments and falsification; no company affiliation.', [
      ['投研 Owner / Owner', '对投资问题与最终判断负责，避免指标替代目标', '目标、判断和取舍'],
      ['指标口径组 / Metrics', '核查增长指标、分母与时间窗口', '指标定义、口径和来源'],
      ['实验研究组 / Experiment', '验证增长与现金流假设，写清样本范围', '实验设计式证据表'],
      ['反实验研究组 / Counter', '寻找幸存者偏差、选择偏差与替代解释', '反证和证伪条件'],
      ['风险复核 / Risk', '复核样本外适用性、成本、流动性与风险', '风险意见与不能确认的部分'],
    ], []),
  build(9, 'alibaba-style', 'playful', '阿里系 · 现金流生意参谋', 'Alibaba-style business council',
    '虚构趣味模板：行业小二、财务 BP 与数据中台一起算生意账，风控巡检专查“故事很好、回款没有”。不代表阿里真实组织。',
    'A fictional playful business council of industry, finance and data specialists; no company affiliation.', [
      ['投资掌柜 / Lead', '综合生意质量、现金流与估值，记录取舍', '最终判断和资金使用理由'],
      ['行业小二 / Industry', '核查商业模式、客户与竞争格局', '商业事实和竞争证据'],
      ['财务 BP / Finance', '检验利润含金量、回款和一次性项目', '现金流桥接与财务反证'],
      ['数据中台 / Data', '整理可比数据、版本和口径，不重复计证据', '可追溯数据表及未知项'],
      ['风控巡检 / Risk', '复核流动性、集中度、叙事漏洞与风险', '风险清单和等待条件'],
    ], []),
  build(10, 'tencent-style', 'playful', '腾讯系 · 双工作室赛马', 'Tencent-style twin studios',
    '虚构趣味模板：两工作室对同一命题独立研究，产品负责人综合，风控保留否定意见。不代表腾讯真实架构，不按声量选赢家。',
    'A fictional playful two-studio research contest with independent risk review; no company affiliation.', [
      ['投研产品负责人 / Lead', '按证据质量综合两组判断，不以多数或声量裁决', '最终结论、分歧与取舍'],
      ['稳健工作室 / Quality', '研究现金流、资本回报和安全边际', '稳健情景与失效条件'],
      ['成长工作室 / Growth', '研究增长空间、竞争和催化剂', '成长情景及可证伪条件'],
      ['生态观察员 / Ecosystem', '核查生态依赖、监管和竞争外部性', '生态证据和未知项'],
      ['独立风控 / Risk', '复核共同来源、相关性、估值风险与最强反证', '风险意见与反证'],
    ], []),
];
