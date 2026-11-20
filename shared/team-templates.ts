import type { AgentTemplateId } from './agent-roster.interface';
import type { TeamDisplay, TeamLayout, TeamSemanticConfig } from './team-workspace.interface';
import type { TeamWorkBlueprint } from './team-work-blueprint.interface';

/** Template-local seat hints. roleId refers to a role id inside the template config. */
export interface TeamTemplateStaffingSlot {
  roleId: string;
  recommendedTemplateId: AgentTemplateId;
  required: boolean;
}

export interface TeamTemplate {
  id: string; category: 'professional' | 'playful';
  templateVersion: 2;
  staffing: TeamTemplateStaffingSlot[];
  name: { 'zh-CN': string; en: string }; description: { 'zh-CN': string; en: string };
  researchSources: { title: string; url: string; year: number; evidence: 'preprint' }[];
  config: TeamSemanticConfig; display: TeamDisplay; layout: TeamLayout;
}

type TemplateKind = TeamTemplate['category'];
type WorkKind = TeamWorkBlueprint['works'][number]['taskKind'];

interface DeptSpec { key: string; zh: string; en: string; parent: string | null; }
interface SeatSpec {
  key: string; zh: string; en: string; responsibility: string; expectedOutput: string;
  specialty: AgentTemplateId; dept?: string;
}
interface RelationSpec { from: string; to: string; kind: 'reports_to' | 'delegates_to' | 'reviews'; scope: string; }
interface WorkSpec {
  workId: string; seat: string; kind: WorkKind; objective: string; expectedOutput: string;
  deps: string[]; reviewer: string;
}

const SOURCES = {
  trading: { title: 'TradingAgents: Multi-Agents LLM Financial Trading Framework', url: 'https://arxiv.org/abs/2412.20138', year: 2025, evidence: 'preprint' as const },
  fincon: { title: 'FinCon: A Synthesized LLM Multi-Agent System with Conceptual Verbal Reinforcement', url: 'https://arxiv.org/abs/2407.06567', year: 2024, evidence: 'preprint' as const },
  alpha: { title: 'AlphaAgents: Large Language Model based Multi-Agents for Equity Portfolio Constructions', url: 'https://arxiv.org/abs/2508.11152', year: 2025, evidence: 'preprint' as const },
  expert: { title: 'Toward Expert Investment Teams: A Multi-Agent LLM System with Fine-Grained Trading Tasks', url: 'https://arxiv.org/abs/2602.23330', year: 2026, evidence: 'preprint' as const },
  contest: { title: 'ContestTrade: A Multi-Agent Trading System Based on Internal Contest Mechanism', url: 'https://arxiv.org/abs/2508.00554', year: 2025, evidence: 'preprint' as const },
  robot: { title: 'FinRobot: An Open-Source AI Agent Platform for Financial Applications', url: 'https://arxiv.org/abs/2405.14767', year: 2024, evidence: 'preprint' as const },
};

/**
 * Build one template from an explicit spec. Template-local UUIDs are stable per
 * template and remapped on creation (shared/team-template-instantiation.ts);
 * templates carry no credentials and no grants.
 */
function buildTemplate(
  index: number, id: string, category: TemplateKind, zh: string, en: string,
  description: string, englishDescription: string,
  depts: DeptSpec[], seats: SeatSpec[], relations: RelationSpec[], works: WorkSpec[],
  summaryReviewer: string, sources: (keyof typeof SOURCES)[],
): TeamTemplate {
  const uuid = (n: number) => `b0000000-${String(index).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;
  const departments: TeamSemanticConfig['departments'] = depts.map((dept, i) => ({
    id: uuid(1 + i), parentDepartmentId: dept.parent ? uuid(1 + depts.findIndex(d => d.key === dept.parent)) : null,
    purpose: `${dept.zh} / ${dept.en}`,
  }));
  const deptId = (key: string | undefined) => key ? departments.find(d => d.purpose.startsWith(depts.find(x => x.key === key)!.zh))!.id : null;
  const roles: TeamSemanticConfig['roles'] = seats.map((seat, j) => ({
    id: uuid(20 + j), departmentId: deptId(seat.dept), participation: 'placeholder' as const,
    responsibility: seat.responsibility, expectedOutput: seat.expectedOutput, executor: null,
    allowedToolIds: [] as string[], sourceGrantIds: [] as string[],
  }));
  const roleByKey = new Map(seats.map((seat, j) => [seat.key, roles[j]]));
  const roleRelations: TeamSemanticConfig['relations'] = relations.map((r, k) => ({
    id: uuid(100 + k), fromRoleId: roleByKey.get(r.from)!.id, toRoleId: roleByKey.get(r.to)!.id,
    kind: r.kind, responsibilityScope: r.scope,
  }));
  const blueprint: TeamWorkBlueprint = {
    schemaVersion: 1,
    works: works.map(w => ({
      workId: w.workId, roleId: roleByKey.get(w.seat)!.id, taskKind: w.kind,
      objective: w.objective, expectedOutput: w.expectedOutput,
      dependencyWorkIds: [...w.deps], reviewerRoleId: roleByKey.get(w.reviewer)!.id, reviewMode: 'independent',
    })),
    summary: {
      reviewerRoleId: roleByKey.get(summaryReviewer)!.id,
      reviewMode: summaryReviewer === 'lead' ? 'self_check' : 'independent',
      expectedOutput: '综合结论、分歧、行动或等待理由及再核查条件',
    },
  };
  // New templates store child coordinates relative to their semantic parent,
  // matching React Flow and the explicit auto-layout command. Stored team
  // layouts are never converted when a template definition changes.
  const cardWidth = 220; const cardHeight = 154; const gap = 24; const padding = 24;
  const positions: TeamLayout['positions'] = {};
  const sizes = new Map<string, { width: number; height: number }>();
  const measure = (departmentId: string): { width: number; height: number } => {
    const members = roles.filter(role => role.departmentId === departmentId);
    const children = departments.filter(department => department.parentDepartmentId === departmentId);
    const childSizes = children.map(child => measure(child.id));
    const roleRows = Math.ceil(members.length / 2);
    const roleHeight = roleRows ? roleRows * cardHeight + (roleRows - 1) * gap : 0;
    const roleWidth = members.length ? Math.min(members.length, 2) * cardWidth + (members.length > 1 ? gap : 0) : 0;
    let childrenWidth = 0; let childrenHeight = 0;
    for (let i = 0; i < childSizes.length; i += 2) {
      const pair = childSizes.slice(i, i + 2);
      childrenWidth = Math.max(childrenWidth, pair.reduce((total, child, index) => total + child.width + (index ? gap : 0), 0));
      childrenHeight += Math.max(...pair.map(child => child.height)) + (i ? gap : 0);
    }
    const size = { width: Math.max(280, padding * 2 + Math.max(roleWidth, childrenWidth)), height: Math.max(180, 72 + roleHeight + (roleHeight && childrenHeight ? gap : 0) + childrenHeight + padding) };
    sizes.set(departmentId, size);
    return size;
  };
  departments.filter(department => !department.parentDepartmentId).forEach(department => measure(department.id));
  const place = (parentId: string | null, startY: number): void => {
    const members = roles.filter(role => role.departmentId === parentId);
    const children = departments.filter(department => department.parentDepartmentId === parentId);
    members.forEach((role, index) => {
      positions[role.id] = { x: padding + (index % 2) * (cardWidth + gap), y: startY + Math.floor(index / 2) * (cardHeight + gap) };
    });
    let rowY = startY + (members.length ? Math.ceil(members.length / 2) * cardHeight + (Math.ceil(members.length / 2) - 1) * gap + (parentId ? gap : 40) : 0);
    for (let i = 0; i < children.length; i += 2) {
      const pair = children.slice(i, i + 2);
      let rowX = padding;
      pair.forEach(child => {
        const size = sizes.get(child.id)!;
        positions[child.id] = { x: rowX, y: rowY, ...size };
        place(child.id, 72);
        rowX += size.width + gap;
      });
      rowY += Math.max(...pair.map(child => sizes.get(child.id)!.height)) + gap;
    }
  };
  place(null, 24);
  return {
    id, category, templateVersion: 2,
    staffing: seats.map(seat => ({ roleId: roleByKey.get(seat.key)!.id, recommendedTemplateId: seat.specialty, required: true })),
    name: { 'zh-CN': zh, en }, description: { 'zh-CN': description, en: englishDescription },
    researchSources: sources.map(key => SOURCES[key]),
    config: { schemaVersion: 1, departments, roles, relations: roleRelations, defaults: { leadRoleId: roleByKey.get('lead')!.id, parallelism: 1 }, workBlueprint: blueprint },
    display: { name: zh, avatar: null, departmentLabels: Object.fromEntries(departments.map(d => [d.id, d.purpose])),
      roleLabels: Object.fromEntries(roles.map((role, j) => [role.id, `${seats[j].zh} / ${seats[j].en}`])) },
    layout: { schemaVersion: 1, positions, collapsedDepartmentIds: [], viewport: { x: 0, y: 0, zoom: 1 } },
  };
}

/** Research-inspired starting points, not reproductions of paper results or performance claims. */
export const TEAM_TEMPLATES: readonly TeamTemplate[] = [
  buildTemplate(11, 'classic', 'professional', '经典投研团队', 'Classic research team',
    'Squabble 默认模板：投资负责人统筹，基本面研究员与财报专家组成研究部，反方研究员独立核查关键前提并复核最终结论。产品化设计，不引用论文。',
    'The Squabble default: a portfolio lead with a business analyst and a financials expert in the research department, and a counterpoint researcher independently checking key premises and the final conclusion.',
    [
      { key: 'research', zh: '投资研究部', en: 'Research', parent: null },
      { key: 'review', zh: '风险检查部', en: 'Challenge & risk', parent: null },
    ],
    [
      { key: 'lead', zh: '投资负责人', en: 'Portfolio lead', specialty: 'portfolio', dept: undefined,
        responsibility: '综合全部研究、分歧与复核结论，形成唯一最终判断', expectedOutput: '最终结论、分歧、行动或等待理由及再核查条件' },
      { key: 'business', zh: '基本面研究员', en: 'Business analyst', specialty: 'business', dept: 'research',
        responsibility: '解释商业模式、竞争优势与资本回报', expectedOutput: '可比数据、来源版本及一次性因素' },
      { key: 'financials', zh: '财报专家', en: 'Financials expert', specialty: 'financials', dept: 'research',
        responsibility: '核对财务口径、盈利质量和现金流', expectedOutput: '口径对照、现金流桥接与来源版本' },
      { key: 'counterpoint', zh: '反方研究员', en: 'Counterpoint analyst', specialty: 'bear', dept: 'review',
        responsibility: '公平检验最强论点和替代解释', expectedOutput: '最强反证、证据缺口与再核查条件' },
    ],
    [
      { from: 'financials', to: 'lead', kind: 'reports_to', scope: '财务口径与关键财务风险' },
      { from: 'financials', to: 'business', kind: 'reports_to', scope: '财务口径核对' },
      { from: 'business', to: 'lead', kind: 'reports_to', scope: '基本面判断' },
      { from: 'counterpoint', to: 'lead', kind: 'reports_to', scope: '反证结论' },
      { from: 'lead', to: 'financials', kind: 'delegates_to', scope: '本次财务核查请求' },
      { from: 'lead', to: 'business', kind: 'delegates_to', scope: '本次基本面研究请求' },
      { from: 'lead', to: 'counterpoint', kind: 'delegates_to', scope: '本次反证研究请求' },
      { from: 'counterpoint', to: 'financials', kind: 'reviews', scope: '核查财报专家关键前提' },
      { from: 'lead', to: 'business', kind: 'reviews', scope: '复核基本面判断' },
      { from: 'lead', to: 'counterpoint', kind: 'reviews', scope: '复核反证结论' },
      { from: 'counterpoint', to: 'lead', kind: 'reviews', scope: '复核最终综合结论' },
    ],
    [
      { workId: 'financials', seat: 'financials', kind: 'financials', objective: '核对财务口径、盈利质量和现金流', expectedOutput: '口径对照、现金流桥接与来源版本', deps: [], reviewer: 'counterpoint' },
      { workId: 'business', seat: 'business', kind: 'business', objective: '解释商业模式、竞争优势与资本回报', expectedOutput: '可比数据、来源版本及一次性因素', deps: ['financials'], reviewer: 'lead' },
      { workId: 'challenge', seat: 'counterpoint', kind: 'challenge', objective: '公平检验最强论点和替代解释', expectedOutput: '最强反证、证据缺口与再核查条件', deps: ['financials', 'business'], reviewer: 'lead' },
    ], 'counterpoint', []),
  buildTemplate(1, 'bull-bear-committee', 'professional', '多空辩论投委会', 'Bull–bear committee',
    '以专业分析、多空论证和风险复核构成有限辩论。适合检验单一投资命题；结构受 TradingAgents 启发，未复现其回测。',
    'Specialists, opposing theses and risk review for a bounded investment debate; inspired by TradingAgents.',
    [
      { key: 'research', zh: '基础研究部', en: 'Fundamentals', parent: null },
      { key: 'debate', zh: '观点辩论部', en: 'Debate', parent: null },
      { key: 'risk', zh: '独立风险部', en: 'Independent risk', parent: null },
    ],
    [
      { key: 'lead', zh: '投委会主席', en: 'Chair', specialty: 'portfolio', dept: undefined,
        responsibility: '综合证据与反证，记录分歧，形成唯一最终判断', expectedOutput: '判断、分歧、行动建议及再核查条件' },
      { key: 'business', zh: '基本面研究员', en: 'Fundamentals', specialty: 'business', dept: 'research',
        responsibility: '核查业务质量、财报口径与现金流', expectedOutput: '可比数据、来源版本及一次性因素' },
      { key: 'valuation', zh: '估值研究员', en: 'Valuation', specialty: 'valuation', dept: 'research',
        responsibility: '评估合理价值区间和关键假设敏感性', expectedOutput: '估值区间、假设表与不确定性' },
      { key: 'bull', zh: '多方研究员', en: 'Bull', specialty: 'growth', dept: 'debate',
        responsibility: '建立有证据的最强正面情景，写清失效条件', expectedOutput: '正面论据、催化剂与失效条件' },
      { key: 'bear', zh: '空方研究员', en: 'Bear', specialty: 'bear', dept: 'debate',
        responsibility: '寻找最强反证，独立检查共识中的脆弱前提', expectedOutput: '反证、替代解释与证据缺口' },
      { key: 'risk', zh: '风险复核员', en: 'Risk reviewer', specialty: 'risk', dept: 'risk',
        responsibility: '复核集中度、流动性、费用与下行情景', expectedOutput: '风险边界、反证与待人工确认事项' },
    ],
    [
      { from: 'business', to: 'lead', kind: 'reports_to', scope: '基本面判断' },
      { from: 'valuation', to: 'lead', kind: 'reports_to', scope: '估值判断' },
      { from: 'bull', to: 'lead', kind: 'reports_to', scope: '正面情景' },
      { from: 'bear', to: 'lead', kind: 'reports_to', scope: '反证结论' },
      { from: 'risk', to: 'lead', kind: 'reports_to', scope: '风险边界' },
      { from: 'lead', to: 'business', kind: 'delegates_to', scope: '本次基本面研究请求' },
      { from: 'lead', to: 'valuation', kind: 'delegates_to', scope: '本次估值研究请求' },
      { from: 'lead', to: 'bull', kind: 'delegates_to', scope: '本次多方研究请求' },
      { from: 'lead', to: 'bear', kind: 'delegates_to', scope: '本次空方研究请求' },
      { from: 'lead', to: 'risk', kind: 'delegates_to', scope: '本次风险复核请求' },
      { from: 'risk', to: 'business', kind: 'reviews', scope: '复核基本面判断' },
      { from: 'risk', to: 'valuation', kind: 'reviews', scope: '复核估值假设' },
      { from: 'risk', to: 'bull', kind: 'reviews', scope: '复核正面情景' },
      { from: 'risk', to: 'bear', kind: 'reviews', scope: '复核反证' },
      { from: 'lead', to: 'risk', kind: 'reviews', scope: '复核风险边界' },
      { from: 'risk', to: 'lead', kind: 'reviews', scope: '复核最终综合结论' },
    ],
    [
      { workId: 'business', seat: 'business', kind: 'business', objective: '核查业务质量、财报口径与现金流', expectedOutput: '可比数据、来源版本及一次性因素', deps: [], reviewer: 'risk' },
      { workId: 'valuation', seat: 'valuation', kind: 'valuation', objective: '评估合理价值区间和关键假设敏感性', expectedOutput: '估值区间、假设表与不确定性', deps: ['business'], reviewer: 'risk' },
      { workId: 'bull', seat: 'bull', kind: 'specialist', objective: '建立有证据的最强正面情景', expectedOutput: '正面论据、催化剂与失效条件', deps: ['business', 'valuation'], reviewer: 'risk' },
      { workId: 'bear', seat: 'bear', kind: 'challenge', objective: '寻找最强反证，独立检查脆弱前提', expectedOutput: '反证、替代解释与证据缺口', deps: ['business', 'valuation'], reviewer: 'risk' },
      { workId: 'risk', seat: 'risk', kind: 'specialist', objective: '复核集中度、流动性、费用与下行情景', expectedOutput: '风险边界、反证与待人工确认事项', deps: ['bull', 'bear'], reviewer: 'lead' },
    ], 'risk', ['trading']),
  buildTemplate(2, 'reflective-manager', 'professional', '判断记忆与复盘团队', 'Reflective investment team',
    '经理—分析员分工，将当时判断与后续证据对照，保留修正原因。受 FinCon 启发；不自动修改策略或付费重跑。',
    'A manager–analyst hierarchy with explicit belief revisions, inspired by FinCon.',
    [
      { key: 'research', zh: '专项研究部', en: 'Specialist research', parent: null },
      { key: 'reflection', zh: '复盘组', en: 'Reflection', parent: null },
      { key: 'risk', zh: '风险组', en: 'Risk', parent: null },
    ],
    [
      { key: 'lead', zh: '投资经理', en: 'Manager', specialty: 'portfolio', dept: undefined,
        responsibility: '综合当前研究与历史判断，区分事实变化和观点变化', expectedOutput: '判断版本、修订原因与决策提案' },
      { key: 'company', zh: '公司分析员', en: 'Company analyst', specialty: 'financials', dept: 'research',
        responsibility: '核查经营与财务变化', expectedOutput: '基本面变化表和原始出处' },
      { key: 'macro', zh: '宏观分析员', en: 'Macro analyst', specialty: 'macro', dept: 'research',
        responsibility: '核查利率、需求、汇率对本次命题的影响', expectedOutput: '传导机制、范围及未知项' },
      { key: 'market', zh: '市场分析员', en: 'Market analyst', specialty: 'events', dept: 'research',
        responsibility: '核查价格、成交与预期变化，不用价格倒推事实', expectedOutput: '市场证据及替代解释' },
      { key: 'reflection', zh: '复盘记录员', en: 'Reflection recorder', specialty: 'moderator', dept: 'reflection',
        responsibility: '对照原始判断与新证据，禁止事后改写原假设', expectedOutput: '支持、削弱、无法确认的前提清单' },
      { key: 'risk', zh: '风险挑战员', en: 'Risk challenger', specialty: 'risk', dept: 'risk',
        responsibility: '复核记忆引用、来源独立性和下行风险', expectedOutput: '反证、风险与复核条件' },
    ],
    [
      { from: 'company', to: 'lead', kind: 'reports_to', scope: '经营与财务变化' },
      { from: 'macro', to: 'lead', kind: 'reports_to', scope: '宏观传导' },
      { from: 'market', to: 'lead', kind: 'reports_to', scope: '市场证据' },
      { from: 'reflection', to: 'lead', kind: 'reports_to', scope: '复盘对照' },
      { from: 'risk', to: 'lead', kind: 'reports_to', scope: '风险边界' },
      { from: 'lead', to: 'company', kind: 'delegates_to', scope: '本次公司研究请求' },
      { from: 'lead', to: 'macro', kind: 'delegates_to', scope: '本次宏观研究请求' },
      { from: 'lead', to: 'market', kind: 'delegates_to', scope: '本次市场研究请求' },
      { from: 'lead', to: 'reflection', kind: 'delegates_to', scope: '本次复盘请求' },
      { from: 'lead', to: 'risk', kind: 'delegates_to', scope: '本次风险复核请求' },
      { from: 'risk', to: 'company', kind: 'reviews', scope: '复核公司研究' },
      { from: 'risk', to: 'macro', kind: 'reviews', scope: '复核宏观研究' },
      { from: 'risk', to: 'market', kind: 'reviews', scope: '复核市场研究' },
      { from: 'risk', to: 'reflection', kind: 'reviews', scope: '复核复盘对照' },
      { from: 'lead', to: 'risk', kind: 'reviews', scope: '复核风险边界' },
      { from: 'risk', to: 'lead', kind: 'reviews', scope: '复核最终综合结论' },
    ],
    [
      { workId: 'company', seat: 'company', kind: 'financials', objective: '核查经营与财务变化', expectedOutput: '基本面变化表和原始出处', deps: [], reviewer: 'risk' },
      { workId: 'macro', seat: 'macro', kind: 'specialist', objective: '核查利率、需求、汇率传导', expectedOutput: '传导机制、范围及未知项', deps: [], reviewer: 'risk' },
      { workId: 'market', seat: 'market', kind: 'specialist', objective: '核查价格、成交与预期变化', expectedOutput: '市场证据及替代解释', deps: [], reviewer: 'risk' },
      { workId: 'reflection', seat: 'reflection', kind: 'specialist', objective: '对照原始判断与新证据', expectedOutput: '支持、削弱、无法确认的前提清单', deps: ['company', 'macro', 'market'], reviewer: 'risk' },
      { workId: 'risk', seat: 'risk', kind: 'specialist', objective: '复核记忆引用、来源独立性和下行风险', expectedOutput: '反证、风险与复核条件', deps: ['reflection'], reviewer: 'lead' },
    ], 'risk', ['fincon']),
  buildTemplate(3, 'portfolio-specialists', 'professional', '多视角组合研究组', 'Portfolio specialists',
    '分别研究基本面、情绪与技术信号，再核查组合层面的相关性和风险。受 AlphaAgents 启发；不把个股信号直接当最优组合。',
    'Role-based equity research with portfolio-level risk checks, inspired by AlphaAgents.',
    [
      { key: 'fundamental', zh: '基本面组', en: 'Fundamentals', parent: null },
      { key: 'market', zh: '市场证据组', en: 'Market evidence', parent: null },
      { key: 'risk', zh: '风险组', en: 'Portfolio risk', parent: null },
    ],
    [
      { key: 'lead', zh: '组合经理', en: 'Portfolio lead', specialty: 'portfolio', dept: undefined,
        responsibility: '综合不同视角，解释资产之间的相关性与取舍', expectedOutput: '组合理由、权重提案及等待条件' },
      { key: 'business', zh: '基本面分析', en: 'Fundamental analyst', specialty: 'business', dept: 'fundamental',
        responsibility: '研究经营、现金流和估值基础', expectedOutput: '财务事实及估值前提' },
      { key: 'events', zh: '预期与情绪', en: 'Events & sentiment', specialty: 'events', dept: 'market',
        responsibility: '区分事件事实、市场叙事与情绪噪声', expectedOutput: '事件来源、预期差与证据等级' },
      { key: 'technical', zh: '价格与技术', en: 'Price & technicals', specialty: 'quantitative', dept: 'market',
        responsibility: '验证价格与成交信号的样本范围和失效条件', expectedOutput: '信号定义、数据范围和限制' },
      { key: 'risk', zh: '组合风险', en: 'Portfolio risk', specialty: 'risk', dept: 'risk',
        responsibility: '复核相关性、集中度、流动性与交易费用', expectedOutput: '组合风险、反证与约束' },
    ],
    [
      { from: 'business', to: 'lead', kind: 'reports_to', scope: '基本面判断' },
      { from: 'events', to: 'lead', kind: 'reports_to', scope: '事件与情绪' },
      { from: 'technical', to: 'lead', kind: 'reports_to', scope: '价格与技术信号' },
      { from: 'risk', to: 'lead', kind: 'reports_to', scope: '组合风险' },
      { from: 'lead', to: 'business', kind: 'delegates_to', scope: '本次基本面研究请求' },
      { from: 'lead', to: 'events', kind: 'delegates_to', scope: '本次事件研究请求' },
      { from: 'lead', to: 'technical', kind: 'delegates_to', scope: '本次技术研究请求' },
      { from: 'lead', to: 'risk', kind: 'delegates_to', scope: '本次风险复核请求' },
      { from: 'risk', to: 'business', kind: 'reviews', scope: '复核基本面判断' },
      { from: 'risk', to: 'events', kind: 'reviews', scope: '复核事件证据' },
      { from: 'risk', to: 'technical', kind: 'reviews', scope: '复核技术信号' },
      { from: 'lead', to: 'risk', kind: 'reviews', scope: '复核组合风险' },
      { from: 'risk', to: 'lead', kind: 'reviews', scope: '复核最终综合结论' },
    ],
    [
      { workId: 'business', seat: 'business', kind: 'business', objective: '研究经营、现金流和估值基础', expectedOutput: '财务事实及估值前提', deps: [], reviewer: 'risk' },
      { workId: 'events', seat: 'events', kind: 'specialist', objective: '区分事件事实、市场叙事与情绪噪声', expectedOutput: '事件来源、预期差与证据等级', deps: [], reviewer: 'risk' },
      { workId: 'technical', seat: 'technical', kind: 'specialist', objective: '验证价格与成交信号的样本范围和失效条件', expectedOutput: '信号定义、数据范围和限制', deps: [], reviewer: 'risk' },
      { workId: 'risk', seat: 'risk', kind: 'specialist', objective: '复核相关性、集中度、流动性与交易费用', expectedOutput: '组合风险、反证与约束', deps: ['business', 'events', 'technical'], reviewer: 'lead' },
    ], 'risk', ['alpha']),
  buildTemplate(4, 'fine-grained-diligence', 'professional', '细粒度财报尽调组', 'Fine-grained diligence',
    '将宽泛观点拆为可验证的财务、行业、估值与反证任务。借鉴 2026 年细粒度投资团队研究，强调精确输入与交付。',
    'Fine-grained, verifiable research assignments inspired by 2026 expert-team research.',
    [
      { key: 'accounting', zh: '财务核验部', en: 'Financial verification', parent: null },
      { key: 'industry', zh: '行业估值部', en: 'Industry & valuation', parent: null },
      { key: 'review', zh: '独立审查部', en: 'Independent review', parent: null },
    ],
    [
      { key: 'lead', zh: '尽调负责人', en: 'Diligence lead', specialty: 'portfolio', dept: undefined,
        responsibility: '拆清本次投资命题，综合专项交付', expectedOutput: '结论、依据、未知项和下一步' },
      { key: 'accounting', zh: '口径核对员', en: 'Accounting analyst', specialty: 'financials', dept: 'accounting',
        responsibility: '核查跨期会计口径、合并范围与一次性因素', expectedOutput: '口径对照表与可比数据' },
      { key: 'cashflow', zh: '现金流专家', en: 'Cash-flow analyst', specialty: 'business', dept: 'accounting',
        responsibility: '核查订单到回款的转化，排除营运资本和融资影响', expectedOutput: '现金流桥接表、来源及反证' },
      { key: 'industry', zh: '行业研究员', en: 'Industry analyst', specialty: 'industry', dept: 'industry',
        responsibility: '检验需求、竞争与行业传导机制', expectedOutput: '行业事实、竞争假设与范围' },
      { key: 'valuation', zh: '估值建模员', en: 'Valuation modeler', specialty: 'valuation', dept: 'industry',
        responsibility: '列明关键假设并进行情景敏感性分析', expectedOutput: '情景估值与关键假设' },
      { key: 'review', zh: '反证审查员', en: 'Counterpoint reviewer', specialty: 'bear', dept: 'review',
        responsibility: '检查数据身份、结论跳跃和最强反证', expectedOutput: '问题清单及复核意见' },
    ],
    [
      { from: 'accounting', to: 'lead', kind: 'reports_to', scope: '会计口径' },
      { from: 'cashflow', to: 'lead', kind: 'reports_to', scope: '现金流核查' },
      { from: 'industry', to: 'lead', kind: 'reports_to', scope: '行业判断' },
      { from: 'valuation', to: 'lead', kind: 'reports_to', scope: '估值判断' },
      { from: 'review', to: 'lead', kind: 'reports_to', scope: '反证结论' },
      { from: 'lead', to: 'accounting', kind: 'delegates_to', scope: '本次口径核查请求' },
      { from: 'lead', to: 'cashflow', kind: 'delegates_to', scope: '本次现金流核查请求' },
      { from: 'lead', to: 'industry', kind: 'delegates_to', scope: '本次行业研究请求' },
      { from: 'lead', to: 'valuation', kind: 'delegates_to', scope: '本次估值请求' },
      { from: 'lead', to: 'review', kind: 'delegates_to', scope: '本次反证审查请求' },
      { from: 'review', to: 'accounting', kind: 'reviews', scope: '复核口径对照' },
      { from: 'review', to: 'cashflow', kind: 'reviews', scope: '复核现金流桥接' },
      { from: 'review', to: 'industry', kind: 'reviews', scope: '复核行业判断' },
      { from: 'review', to: 'valuation', kind: 'reviews', scope: '复核估值假设' },
      { from: 'lead', to: 'review', kind: 'reviews', scope: '复核反证结论' },
      { from: 'review', to: 'lead', kind: 'reviews', scope: '复核最终综合结论' },
    ],
    [
      { workId: 'accounting', seat: 'accounting', kind: 'financials', objective: '核查跨期会计口径、合并范围与一次性因素', expectedOutput: '口径对照表与可比数据', deps: [], reviewer: 'review' },
      { workId: 'cashflow', seat: 'cashflow', kind: 'financials', objective: '核查订单到回款的转化，排除营运资本和融资影响', expectedOutput: '现金流桥接表、来源及反证', deps: ['accounting'], reviewer: 'review' },
      { workId: 'industry', seat: 'industry', kind: 'specialist', objective: '检验需求、竞争与行业传导机制', expectedOutput: '行业事实、竞争假设与范围', deps: [], reviewer: 'review' },
      { workId: 'valuation', seat: 'valuation', kind: 'valuation', objective: '列明关键假设并进行情景敏感性分析', expectedOutput: '情景估值与关键假设', deps: ['accounting', 'cashflow', 'industry'], reviewer: 'review' },
      { workId: 'challenge', seat: 'review', kind: 'challenge', objective: '检查数据身份、结论跳跃和最强反证', expectedOutput: '问题清单及复核意见', deps: ['valuation'], reviewer: 'lead' },
    ], 'review', ['expert', 'robot']),
  buildTemplate(5, 'competing-hypotheses', 'professional', '竞争假设研究组', 'Competing hypotheses',
    '让不同小组独立构造解释，再按同一证据清单比较，不以多数票认定正确。受 ContestTrade 启发，保留无法确认。',
    'Independent competing hypotheses compared on shared evidence, inspired by ContestTrade.',
    [
      { key: 'growth', zh: '增长组', en: 'Growth', parent: null },
      { key: 'cycle', zh: '周期组', en: 'Cycle', parent: null },
      { key: 'verification', zh: '公共核验组', en: 'Verification', parent: null },
    ],
    [
      { key: 'lead', zh: '裁决负责人', en: 'Synthesis lead', specialty: 'portfolio', dept: undefined,
        responsibility: '按证据质量比较竞争解释，保留少数意见', expectedOutput: '取舍记录、未知项和最终提案' },
      { key: 'growth', zh: '增长假设组', en: 'Growth hypothesis', specialty: 'growth', dept: 'growth',
        responsibility: '解释增长、需求与现金流转化', expectedOutput: '增长假设、来源与可证伪条件' },
      { key: 'macro', zh: '周期假设组', en: 'Cycle hypothesis', specialty: 'macro', dept: 'cycle',
        responsibility: '检查周期、库存与基数效应的替代解释', expectedOutput: '替代情景及验证指标' },
      { key: 'execution', zh: '执行条件员', en: 'Execution analyst', specialty: 'quantitative', dept: 'verification',
        responsibility: '核查费用、流动性和实际行动条件', expectedOutput: '执行限制、成本与等待条件' },
      { key: 'review', zh: '独立审查', en: 'Independent review', specialty: 'bear', dept: 'verification',
        responsibility: '复核样本、证据独立性和风险，不把共享来源计多次', expectedOutput: '证据去重、风险及反证' },
    ],
    [
      { from: 'growth', to: 'lead', kind: 'reports_to', scope: '增长假设' },
      { from: 'macro', to: 'lead', kind: 'reports_to', scope: '周期假设' },
      { from: 'execution', to: 'lead', kind: 'reports_to', scope: '执行条件' },
      { from: 'review', to: 'lead', kind: 'reports_to', scope: '反证结论' },
      { from: 'lead', to: 'growth', kind: 'delegates_to', scope: '本次增长研究请求' },
      { from: 'lead', to: 'macro', kind: 'delegates_to', scope: '本次周期研究请求' },
      { from: 'lead', to: 'execution', kind: 'delegates_to', scope: '本次执行研究请求' },
      { from: 'lead', to: 'review', kind: 'delegates_to', scope: '本次独立审查请求' },
      { from: 'review', to: 'growth', kind: 'reviews', scope: '复核增长假设' },
      { from: 'review', to: 'macro', kind: 'reviews', scope: '复核周期假设' },
      { from: 'review', to: 'execution', kind: 'reviews', scope: '复核执行条件' },
      { from: 'lead', to: 'review', kind: 'reviews', scope: '复核反证结论' },
      { from: 'review', to: 'lead', kind: 'reviews', scope: '复核最终综合结论' },
    ],
    [
      { workId: 'growth', seat: 'growth', kind: 'specialist', objective: '解释增长、需求与现金流转化', expectedOutput: '增长假设、来源与可证伪条件', deps: [], reviewer: 'review' },
      { workId: 'macro', seat: 'macro', kind: 'specialist', objective: '检查周期、库存与基数效应的替代解释', expectedOutput: '替代情景及验证指标', deps: [], reviewer: 'review' },
      { workId: 'execution', seat: 'execution', kind: 'specialist', objective: '核查费用、流动性和实际行动条件', expectedOutput: '执行限制、成本与等待条件', deps: ['growth', 'macro'], reviewer: 'review' },
      { workId: 'challenge', seat: 'review', kind: 'challenge', objective: '复核样本、证据独立性和风险', expectedOutput: '证据去重、风险及反证', deps: ['growth', 'macro', 'execution'], reviewer: 'lead' },
    ], 'review', ['contest']),
  buildTemplate(6, 'matrix-specialists', 'professional', '矩阵专项研究团队', 'Matrix specialist team',
    '财务专家同时向研究与风险负责人汇报，每次研究只指定一名最终负责人。结合 FinRobot 专业工具链与 FinCon 层级协作作产品化改编。',
    'A product adaptation of specialized financial toolchains and manager–analyst collaboration, with matrix reporting.',
    [
      { key: 'research', zh: '研究部', en: 'Research', parent: null },
      { key: 'risk', zh: '风险部', en: 'Risk', parent: null },
    ],
    [
      { key: 'lead', zh: '研究负责人', en: 'Research lead', specialty: 'portfolio', dept: undefined,
        responsibility: '确定本次问题并形成最终综合判断', expectedOutput: '综合判断和决策依据' },
      { key: 'risk', zh: '风险负责人', en: 'Risk lead', specialty: 'risk', dept: 'risk',
        responsibility: '提出跨组风险核查要求，不扩张本次授权', expectedOutput: '风险问题和约束' },
      { key: 'financials', zh: '共享财务专家', en: 'Shared financials', specialty: 'financials', dept: 'research',
        responsibility: '核查财务口径、经营现金流与流动性反证', expectedOutput: '一份可被多主管引用的专项交付' },
      { key: 'valuation', zh: '估值专家', en: 'Valuation specialist', specialty: 'valuation', dept: 'research',
        responsibility: '验证估值与资本配置假设', expectedOutput: '估值区间与失效条件' },
      { key: 'review', zh: '复核委员', en: 'Reviewer', specialty: 'bear', dept: 'risk',
        responsibility: '独立复核关键前提和跨主管指令冲突', expectedOutput: '反证、未知项和取舍建议' },
    ],
    [
      { from: 'financials', to: 'lead', kind: 'reports_to', scope: '财务口径' },
      { from: 'financials', to: 'risk', kind: 'reports_to', scope: '财务口径与流动性专项' },
      { from: 'valuation', to: 'lead', kind: 'reports_to', scope: '估值判断' },
      { from: 'risk', to: 'lead', kind: 'reports_to', scope: '风险要求' },
      { from: 'review', to: 'lead', kind: 'reports_to', scope: '反证结论' },
      { from: 'lead', to: 'financials', kind: 'delegates_to', scope: '本次财务研究请求' },
      { from: 'lead', to: 'valuation', kind: 'delegates_to', scope: '本次估值请求' },
      { from: 'lead', to: 'risk', kind: 'delegates_to', scope: '本次风险复核请求' },
      { from: 'lead', to: 'review', kind: 'delegates_to', scope: '本次复核请求' },
      { from: 'risk', to: 'financials', kind: 'delegates_to', scope: '财务口径专项请求' },
      { from: 'review', to: 'financials', kind: 'reviews', scope: '复核财务专项交付' },
      { from: 'review', to: 'valuation', kind: 'reviews', scope: '复核估值假设' },
      { from: 'review', to: 'risk', kind: 'reviews', scope: '复核风险要求' },
      { from: 'lead', to: 'review', kind: 'reviews', scope: '复核反证结论' },
      { from: 'review', to: 'lead', kind: 'reviews', scope: '复核最终综合结论' },
    ],
    [
      { workId: 'financials', seat: 'financials', kind: 'financials', objective: '核查财务口径、经营现金流与流动性反证', expectedOutput: '一份可被多主管引用的专项交付', deps: [], reviewer: 'review' },
      { workId: 'valuation', seat: 'valuation', kind: 'valuation', objective: '验证估值与资本配置假设', expectedOutput: '估值区间与失效条件', deps: ['financials'], reviewer: 'review' },
      { workId: 'risk', seat: 'risk', kind: 'specialist', objective: '提出跨组风险核查要求', expectedOutput: '风险问题和约束', deps: ['financials', 'valuation'], reviewer: 'review' },
      { workId: 'challenge', seat: 'review', kind: 'challenge', objective: '独立复核关键前提和跨主管指令冲突', expectedOutput: '反证、未知项和取舍建议', deps: ['risk'], reviewer: 'lead' },
    ], 'review', ['robot', 'fincon']),
  buildTemplate(7, 'huawei-style', 'playful', '华为系 · 投研铁三角', 'Huawei-style research triangle',
    '虚构趣味模板：命题、方案、交付协同，蓝军专挑漏洞。借用组织梗，不代表华为真实架构或背书。',
    'A fictional playful triangle of thesis, solution and delivery with a challenger; no company affiliation.',
    [
      { key: 'triangle', zh: '铁三角组', en: 'Triangle', parent: null },
      { key: 'blue', zh: '蓝军组', en: 'Red team', parent: null },
      { key: 'risk', zh: '风险组', en: 'Risk', parent: null },
    ],
    [
      { key: 'lead', zh: '轮值投委主席', en: 'Chair', specialty: 'portfolio', dept: undefined,
        responsibility: '综合各组证据，对本次最终判断负责', expectedOutput: '结论、取舍和行动提案' },
      { key: 'thesis', zh: '命题客户经理', en: 'Thesis owner', specialty: 'business', dept: 'triangle',
        responsibility: '把投资需求翻译为可验证命题，拒绝空洞口号', expectedOutput: '命题、成功指标和失效条件' },
      { key: 'solution', zh: '估值解决方案', en: 'Valuation solution', specialty: 'valuation', dept: 'triangle',
        responsibility: '设计估值情景与可检验方案', expectedOutput: '估值框架和情景比较' },
      { key: 'delivery', zh: '财报交付经理', en: 'Delivery manager', specialty: 'financials', dept: 'triangle',
        responsibility: '核查原始资料、口径和现金流交付质量', expectedOutput: '可追溯数据与缺口' },
      { key: 'redteam', zh: '蓝军研究室', en: 'Red team lab', specialty: 'bear', dept: 'blue',
        responsibility: '提出最强反证，检查共识中的逻辑漏洞', expectedOutput: '反证报告和替代解释' },
      { key: 'risk', zh: '风险与合规哨', en: 'Risk & compliance', specialty: 'risk', dept: 'risk',
        responsibility: '复核本次权限、预算、集中度与风险边界', expectedOutput: '风险限制和待核查事项' },
    ],
    [
      { from: 'thesis', to: 'lead', kind: 'reports_to', scope: '命题定义' },
      { from: 'solution', to: 'lead', kind: 'reports_to', scope: '估值方案' },
      { from: 'delivery', to: 'lead', kind: 'reports_to', scope: '交付质量' },
      { from: 'redteam', to: 'lead', kind: 'reports_to', scope: '反证结论' },
      { from: 'risk', to: 'lead', kind: 'reports_to', scope: '风险边界' },
      { from: 'lead', to: 'thesis', kind: 'delegates_to', scope: '本次命题请求' },
      { from: 'lead', to: 'solution', kind: 'delegates_to', scope: '本次估值方案请求' },
      { from: 'lead', to: 'delivery', kind: 'delegates_to', scope: '本次交付请求' },
      { from: 'lead', to: 'redteam', kind: 'delegates_to', scope: '本次反证请求' },
      { from: 'lead', to: 'risk', kind: 'delegates_to', scope: '本次风险复核请求' },
      { from: 'risk', to: 'thesis', kind: 'reviews', scope: '复核命题定义' },
      { from: 'risk', to: 'delivery', kind: 'reviews', scope: '复核交付质量' },
      { from: 'risk', to: 'solution', kind: 'reviews', scope: '复核估值方案' },
      { from: 'risk', to: 'redteam', kind: 'reviews', scope: '复核反证' },
      { from: 'lead', to: 'risk', kind: 'reviews', scope: '复核风险边界' },
      { from: 'risk', to: 'lead', kind: 'reviews', scope: '复核最终综合结论' },
    ],
    [
      { workId: 'thesis', seat: 'thesis', kind: 'business', objective: '把投资需求翻译为可验证命题', expectedOutput: '命题、成功指标和失效条件', deps: [], reviewer: 'risk' },
      { workId: 'delivery', seat: 'delivery', kind: 'financials', objective: '核查原始资料、口径和现金流交付质量', expectedOutput: '可追溯数据与缺口', deps: [], reviewer: 'risk' },
      { workId: 'solution', seat: 'solution', kind: 'valuation', objective: '设计估值情景与可检验方案', expectedOutput: '估值框架和情景比较', deps: ['thesis', 'delivery'], reviewer: 'risk' },
      { workId: 'challenge', seat: 'redteam', kind: 'challenge', objective: '提出最强反证，检查共识中的逻辑漏洞', expectedOutput: '反证报告和替代解释', deps: ['solution'], reviewer: 'risk' },
      { workId: 'risk', seat: 'risk', kind: 'specialist', objective: '复核本次权限、预算、集中度与风险边界', expectedOutput: '风险限制和待核查事项', deps: ['challenge'], reviewer: 'lead' },
    ], 'risk', []),
  buildTemplate(8, 'bytedance-style', 'playful', '字节系 · 指标与反实验室', 'ByteDance-style metric lab',
    '虚构趣味模板：先写指标和证伪条件，再让实验组与反实验组交叉核查。不代表字节真实组织。',
    'A fictional playful metric lab with experiments and falsification; no company affiliation.',
    [
      { key: 'metrics', zh: '指标组', en: 'Metrics', parent: null },
      { key: 'experiment', zh: '实验组', en: 'Experiment', parent: null },
      { key: 'counter', zh: '反实验组', en: 'Counter-experiment', parent: null },
      { key: 'risk', zh: '风险组', en: 'Risk', parent: null },
    ],
    [
      { key: 'lead', zh: '投研 Owner', en: 'Owner', specialty: 'portfolio', dept: undefined,
        responsibility: '对投资问题与最终判断负责，避免指标替代目标', expectedOutput: '目标、判断和取舍' },
      { key: 'metrics', zh: '指标口径组', en: 'Metrics analyst', specialty: 'quantitative', dept: 'metrics',
        responsibility: '核查增长指标、分母与时间窗口', expectedOutput: '指标定义、口径和来源' },
      { key: 'experiment', zh: '实验研究组', en: 'Experiment analyst', specialty: 'growth', dept: 'experiment',
        responsibility: '验证增长与现金流假设，写清样本范围', expectedOutput: '实验设计式证据表' },
      { key: 'counter', zh: '反实验研究组', en: 'Counter-experiment', specialty: 'bear', dept: 'counter',
        responsibility: '寻找幸存者偏差、选择偏差与替代解释', expectedOutput: '反证和证伪条件' },
      { key: 'risk', zh: '风险复核', en: 'Risk review', specialty: 'risk', dept: 'risk',
        responsibility: '复核样本外适用性、成本、流动性与风险', expectedOutput: '风险意见与不能确认的部分' },
    ],
    [
      { from: 'metrics', to: 'lead', kind: 'reports_to', scope: '指标口径' },
      { from: 'experiment', to: 'lead', kind: 'reports_to', scope: '实验证据' },
      { from: 'counter', to: 'lead', kind: 'reports_to', scope: '反证结论' },
      { from: 'risk', to: 'lead', kind: 'reports_to', scope: '风险边界' },
      { from: 'lead', to: 'metrics', kind: 'delegates_to', scope: '本次指标核查请求' },
      { from: 'lead', to: 'experiment', kind: 'delegates_to', scope: '本次实验请求' },
      { from: 'lead', to: 'counter', kind: 'delegates_to', scope: '本次反实验请求' },
      { from: 'lead', to: 'risk', kind: 'delegates_to', scope: '本次风险复核请求' },
      { from: 'risk', to: 'metrics', kind: 'reviews', scope: '复核指标口径' },
      { from: 'risk', to: 'experiment', kind: 'reviews', scope: '复核实验证据' },
      { from: 'risk', to: 'counter', kind: 'reviews', scope: '复核反证' },
      { from: 'lead', to: 'risk', kind: 'reviews', scope: '复核风险边界' },
      { from: 'risk', to: 'lead', kind: 'reviews', scope: '复核最终综合结论' },
    ],
    [
      { workId: 'metrics', seat: 'metrics', kind: 'specialist', objective: '核查增长指标、分母与时间窗口', expectedOutput: '指标定义、口径和来源', deps: [], reviewer: 'risk' },
      { workId: 'experiment', seat: 'experiment', kind: 'specialist', objective: '验证增长与现金流假设，写清样本范围', expectedOutput: '实验设计式证据表', deps: ['metrics'], reviewer: 'risk' },
      { workId: 'challenge', seat: 'counter', kind: 'challenge', objective: '寻找幸存者偏差、选择偏差与替代解释', expectedOutput: '反证和证伪条件', deps: ['experiment'], reviewer: 'risk' },
      { workId: 'risk', seat: 'risk', kind: 'specialist', objective: '复核样本外适用性、成本、流动性与风险', expectedOutput: '风险意见与不能确认的部分', deps: ['challenge'], reviewer: 'lead' },
    ], 'risk', []),
  buildTemplate(9, 'alibaba-style', 'playful', '阿里系 · 现金流生意参谋', 'Alibaba-style business council',
    '虚构趣味模板：行业小二、财务 BP 与数据中台一起算生意账，风控巡检专查“故事很好、回款没有”。不代表阿里真实组织。',
    'A fictional playful business council of industry, finance and data specialists; no company affiliation.',
    [
      { key: 'business', zh: '业务组', en: 'Business', parent: null },
      { key: 'finance', zh: '财务组', en: 'Finance', parent: null },
      { key: 'data', zh: '数据组', en: 'Data', parent: null },
      { key: 'risk', zh: '风控组', en: 'Risk', parent: null },
    ],
    [
      { key: 'lead', zh: '投资掌柜', en: 'Lead', specialty: 'portfolio', dept: undefined,
        responsibility: '综合生意质量、现金流与估值，记录取舍', expectedOutput: '最终判断和资金使用理由' },
      { key: 'industry', zh: '行业小二', en: 'Industry specialist', specialty: 'industry', dept: 'business',
        responsibility: '核查商业模式、客户与竞争格局', expectedOutput: '商业事实和竞争证据' },
      { key: 'finance', zh: '财务 BP', en: 'Finance BP', specialty: 'financials', dept: 'finance',
        responsibility: '检验利润含金量、回款和一次性项目', expectedOutput: '现金流桥接与财务反证' },
      { key: 'data', zh: '数据中台', en: 'Data platform', specialty: 'quantitative', dept: 'data',
        responsibility: '整理可比数据、版本和口径，不重复计证据', expectedOutput: '可追溯数据表及未知项' },
      { key: 'risk', zh: '风控巡检', en: 'Risk patrol', specialty: 'risk', dept: 'risk',
        responsibility: '复核流动性、集中度、叙事漏洞与风险', expectedOutput: '风险清单和等待条件' },
    ],
    [
      { from: 'industry', to: 'lead', kind: 'reports_to', scope: '商业模式' },
      { from: 'finance', to: 'lead', kind: 'reports_to', scope: '财务判断' },
      { from: 'data', to: 'lead', kind: 'reports_to', scope: '数据口径' },
      { from: 'risk', to: 'lead', kind: 'reports_to', scope: '风险边界' },
      { from: 'lead', to: 'industry', kind: 'delegates_to', scope: '本次行业研究请求' },
      { from: 'lead', to: 'finance', kind: 'delegates_to', scope: '本次财务核查请求' },
      { from: 'lead', to: 'data', kind: 'delegates_to', scope: '本次数据请求' },
      { from: 'lead', to: 'risk', kind: 'delegates_to', scope: '本次风险复核请求' },
      { from: 'risk', to: 'industry', kind: 'reviews', scope: '复核商业模式' },
      { from: 'risk', to: 'finance', kind: 'reviews', scope: '复核财务判断' },
      { from: 'risk', to: 'data', kind: 'reviews', scope: '复核数据口径' },
      { from: 'lead', to: 'risk', kind: 'reviews', scope: '复核风险边界' },
      { from: 'risk', to: 'lead', kind: 'reviews', scope: '复核最终综合结论' },
    ],
    [
      { workId: 'industry', seat: 'industry', kind: 'specialist', objective: '核查商业模式、客户与竞争格局', expectedOutput: '商业事实和竞争证据', deps: [], reviewer: 'risk' },
      { workId: 'finance', seat: 'finance', kind: 'financials', objective: '检验利润含金量、回款和一次性项目', expectedOutput: '现金流桥接与财务反证', deps: [], reviewer: 'risk' },
      { workId: 'data', seat: 'data', kind: 'specialist', objective: '整理可比数据、版本和口径', expectedOutput: '可追溯数据表及未知项', deps: ['industry', 'finance'], reviewer: 'risk' },
      { workId: 'risk', seat: 'risk', kind: 'specialist', objective: '复核流动性、集中度、叙事漏洞与风险', expectedOutput: '风险清单和等待条件', deps: ['data'], reviewer: 'lead' },
    ], 'risk', []),
  buildTemplate(10, 'tencent-style', 'playful', '腾讯系 · 双工作室赛马', 'Tencent-style twin studios',
    '虚构趣味模板：两工作室对同一命题独立研究，产品负责人综合，风控保留否定意见。不代表腾讯真实架构，不按声量选赢家。',
    'A fictional playful two-studio research contest with independent risk review; no company affiliation.',
    [
      { key: 'quality', zh: '稳健工作室', en: 'Quality studio', parent: null },
      { key: 'growth', zh: '成长工作室', en: 'Growth studio', parent: null },
      { key: 'ecosystem', zh: '生态组', en: 'Ecosystem', parent: null },
      { key: 'risk', zh: '独立风控', en: 'Independent risk', parent: null },
    ],
    [
      { key: 'lead', zh: '投研产品负责人', en: 'Lead', specialty: 'portfolio', dept: undefined,
        responsibility: '按证据质量综合两组判断，不以多数或声量裁决', expectedOutput: '最终结论、分歧与取舍' },
      { key: 'quality', zh: '稳健工作室', en: 'Quality analyst', specialty: 'business', dept: 'quality',
        responsibility: '研究现金流、资本回报和安全边际', expectedOutput: '稳健情景与失效条件' },
      { key: 'growth', zh: '成长工作室', en: 'Growth analyst', specialty: 'growth', dept: 'growth',
        responsibility: '研究增长空间、竞争和催化剂', expectedOutput: '成长情景及可证伪条件' },
      { key: 'ecosystem', zh: '生态观察员', en: 'Ecosystem observer', specialty: 'industry', dept: 'ecosystem',
        responsibility: '核查生态依赖、监管和竞争外部性', expectedOutput: '生态证据和未知项' },
      { key: 'risk', zh: '独立风控', en: 'Independent risk', specialty: 'risk', dept: 'risk',
        responsibility: '复核共同来源、相关性、估值风险与最强反证', expectedOutput: '风险意见与反证' },
    ],
    [
      { from: 'quality', to: 'lead', kind: 'reports_to', scope: '稳健情景' },
      { from: 'growth', to: 'lead', kind: 'reports_to', scope: '成长情景' },
      { from: 'ecosystem', to: 'lead', kind: 'reports_to', scope: '生态证据' },
      { from: 'risk', to: 'lead', kind: 'reports_to', scope: '风险边界' },
      { from: 'lead', to: 'quality', kind: 'delegates_to', scope: '本次稳健研究请求' },
      { from: 'lead', to: 'growth', kind: 'delegates_to', scope: '本次成长研究请求' },
      { from: 'lead', to: 'ecosystem', kind: 'delegates_to', scope: '本次生态研究请求' },
      { from: 'lead', to: 'risk', kind: 'delegates_to', scope: '本次风险复核请求' },
      { from: 'risk', to: 'quality', kind: 'reviews', scope: '复核稳健情景' },
      { from: 'risk', to: 'growth', kind: 'reviews', scope: '复核成长情景' },
      { from: 'risk', to: 'ecosystem', kind: 'reviews', scope: '复核生态证据' },
      { from: 'lead', to: 'risk', kind: 'reviews', scope: '复核风险边界' },
      { from: 'risk', to: 'lead', kind: 'reviews', scope: '复核最终综合结论' },
    ],
    [
      { workId: 'quality', seat: 'quality', kind: 'business', objective: '研究现金流、资本回报和安全边际', expectedOutput: '稳健情景与失效条件', deps: [], reviewer: 'risk' },
      { workId: 'growth', seat: 'growth', kind: 'specialist', objective: '研究增长空间、竞争和催化剂', expectedOutput: '成长情景及可证伪条件', deps: [], reviewer: 'risk' },
      { workId: 'ecosystem', seat: 'ecosystem', kind: 'specialist', objective: '核查生态依赖、监管和竞争外部性', expectedOutput: '生态证据和未知项', deps: [], reviewer: 'risk' },
      { workId: 'risk', seat: 'risk', kind: 'specialist', objective: '复核共同来源、相关性、估值风险与最强反证', expectedOutput: '风险意见与反证', deps: ['quality', 'growth', 'ecosystem'], reviewer: 'lead' },
    ], 'risk', []),
];
