import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AGENT_SPECIALTY_CATALOG } from '../../shared/agent-specialty-catalog';
import type { AgentTemplateId, AgentVersionConfig } from '../../shared/agent-roster.interface';
import { agentRosterProfiles, agentRosterVersions } from './agent-roster.schema';
import { lockAgentRosterOwner, type AgentRosterDatabase } from './agent-roster-context';

// The team runtime already supplies scope, authorization, citations and the delivery schema.
const teamInstructions: Record<AgentTemplateId, string> = {
  financials: '核对报表来源、版本和期间。比较收入、利润与经营现金流，解释营运资本和一次性项目。检查债务、偿付与会计口径。交付现金流桥、异常、缺口和待核实项。',
  valuation: '对齐币种、时点和每股口径。明确可比对象与估值假设，用基准和压力情景检验敏感度。交付估值区间、驱动项、可比限制和改变结论的条件。',
  bear: '找出最关键的乐观前提，寻找可核验的直接反证。分清已证实风险、待验证假设和否定条件。按影响排序列出反方论点、证据和再核查动作。',
  risk: '评估集中度、流动性、杠杆、现金和尾部损失。比较基准和压力情景，检验敞口与账户约束。交付主要风险、否决条件、缺口和监控指标。',
  moderator: '按实际完成情况汇总。合并同源引用，分别呈现事实共识、假设分歧、风险异议、缺失交付和待决定事项。',
  business: '说明客户、付费原因、收入和成本机制。用留存、定价、竞争与资本投入检验护城河。交付可检验假设、关键指标、脆弱环节和失效条件。',
  industry: '固定地域、产品和时间口径。核对产业链、需求、供给、库存和价格，区分周期与结构。说明公司暴露、可比性、竞争假设和观察指标。',
  growth: '拆解销量、价格、客户、并购和低基数贡献。核对留存、单位经济、产能和融资需求。交付阶段情景、反证、资本约束和较早证伪指标。',
  macro: '对齐经济体、数据期、发布日期和修订。分析利率、汇率、信用和需求的传导与滞后。交付有出处的时间线、情景和相反机制。',
  events: '先核对原始披露，区分事件、披露和采集时间。区分条款、媒体解读和推断。交付影响路径、兑现条件、下一节点和证伪情景。',
  quantitative: '核对完整数据、复权、样本、日历和费用。说明可复现方法，检查前视、幸存和过拟合风险。交付真实计算回执或未执行原因、限制和样本外条件。',
  portfolio: '核对冻结账户、目标、期限和约束。比较行动与等待，检验集中度、流动性、现金和费用。保留关键异议与证据版本，交付取舍、未知项和再核查条件。',
};

export function builtinTeamInstructions(config: AgentVersionConfig): string | undefined {
  if (config.origin === 'builtin') return config.teamInstructions ?? teamInstructions[config.templateId];
  return undefined;
}

export async function ensureBuiltinFriends(tx: AgentRosterDatabase, owner: string) {
  await lockAgentRosterOwner(tx, owner);
  const existing = await tx.select().from(agentRosterVersions).where(and(
    eq(agentRosterVersions.ownerId, owner),
    sql`${agentRosterVersions.config}->>'origin' = 'builtin'`,
  ));
  const bySpecialty = new Map(existing.map(version => [version.config.templateId, version]));
  for (const template of AGENT_SPECIALTY_CATALOG) {
    if (bySpecialty.has(template.id)) continue;
    const agentId = randomUUID();
    const id = randomUUID();
    const config: AgentVersionConfig = {
      schemaVersion: 1,
      origin: 'builtin',
      templateId: template.id,
      instructions: template.instructions,
      teamInstructions: teamInstructions[template.id],
      executor: { executionMode: 'model', model: 'slow' },
      allowedToolIds: [...template.allowedToolIds],
      allowedSources: [],
      preferences: { language: 'zh-CN', responseStyle: 'concise', userPreferences: '' },
    };
    await tx.insert(agentRosterProfiles).values({
      id: agentId, ownerId: owner, avatar: template.avatar, name: template.name,
      specialty: template.specialty, description: template.description, currentVersionId: id,
    });
    const [version] = await tx.insert(agentRosterVersions).values({
      id, ownerId: owner, agentId, version: 1, config,
    }).returning();
    bySpecialty.set(template.id, version);
  }
  return bySpecialty;
}
