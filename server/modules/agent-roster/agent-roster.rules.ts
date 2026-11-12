import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentTemplate, AgentTemplateId, CreateAgentInput, AgentVersionConfig, AgentSelection, AgentCouncilMember } from '../../../shared/agent-roster.interface';
import type { ResearchSourceRef } from '../../../shared/team-workspace.interface';

export function rosterError(code: string, message = code, details: Record<string, unknown> = {}): never {
  const status = code === 'AGENT_NOT_FOUND' ? 404 : code === 'AGENT_INVALID_INPUT' ? 400
    : ['AGENT_SOURCE_UNAVAILABLE', 'AGENT_SCOPE_DENIED', 'AGENT_EXECUTOR_UNAVAILABLE', 'AGENT_ARCHIVED'].includes(code) ? 422 : 409;
  throw new HttpException({ code, message, ...details }, status);
}
export function parseRoster<T>(schema: z.ZodType<T>, input: unknown): T {
  if (Buffer.byteLength(JSON.stringify(input) ?? '') > 131072) rosterError('AGENT_INVALID_INPUT', 'Request exceeds the size limit');
  const result = schema.safeParse(input);
  if (!result.success) rosterError('AGENT_INVALID_INPUT', result.error.issues[0]?.message);
  return result.data;
}
export function rosterHash(input: unknown): string {
  function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable);
    if (value instanceof Date) return value.toISOString();
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
    return value;
  }
  return createHash('sha256').update(JSON.stringify(stable(input))).digest('hex');
}
export const uuid = z.string().uuid();
export const requestKey = z.string().trim().min(1).max(128);
export const revision = z.number().int().positive();
export const templateId = z.enum(['financials', 'valuation', 'bear', 'risk', 'moderator']);
const nativeSettings = z.object({ model: z.string().regex(/^[^\u0000-\u001f\u007f]*$/u).trim().min(1).max(160).optional(), reasoningEffort: z.string().regex(/^[^\u0000-\u001f\u007f]*$/u).trim().min(1).max(32).optional() }).strict();
export const executorSchema = z.discriminatedUnion('executionMode', [
  z.object({ executionMode: z.literal('model'), connectionId: uuid.optional(), model: z.enum(['fast', 'slow']) }).strict(),
  z.object({ executionMode: z.literal('local'), localAgentId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), settings: nativeSettings.optional() }).strict(),
  z.object({ executionMode: z.literal('a2a'), connectionId: uuid }).strict(),
]);
export const sourceSchema = z.object({ kind: z.enum(['report_version', 'thesis_version', 'document_version', 'data_snapshot']), id: uuid, revision: z.string().trim().min(1).max(128), availability: z.literal('available') }).strict();
const sources = z.array(sourceSchema).max(100).refine(refs => new Set(refs.map(sourceKey)).size === refs.length, 'Duplicate source reference');
const toolIds = z.array(z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/)).max(100).refine(ids => new Set(ids).size === ids.length, 'Duplicate tool');
const preferences = z.object({ language: z.enum(['zh-CN', 'en']).optional(), responseStyle: z.enum(['concise', 'detailed']).optional(), userPreferences: z.string().max(4000).optional() }).strict();
const editable = { templateId: templateId.optional(), name: z.string().trim().min(1).max(80).optional(), specialty: z.string().trim().min(1).max(300).optional(), description: z.string().trim().max(4000).optional(), instructions: z.string().trim().min(1).max(16000).optional(), executor: executorSchema.optional(), allowedToolIds: toolIds.optional(), allowedSources: sources.optional(), preferences: preferences.optional() };
const createSchema = z.object({ requestKey, ...editable, executor: executorSchema }).strict();
export const updateSchema = z.object({ requestKey, expectedRevision: revision, ...editable }).strict();
export const archiveSchema = z.object({ requestKey, expectedRevision: revision }).strict();
export const recommendedSchema = z.object({ requestKey, executor: executorSchema, templateIds: z.array(templateId).min(1).max(5).refine(ids => new Set(ids).size === ids.length).optional() }).strict();
export const scopeSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('personal') }).strict(), z.object({ kind: z.literal('team'), teamId: uuid }).strict(), z.object({ kind: z.literal('conversation'), conversationId: uuid }).strict()]);
export const writeMemorySchema = z.object({ requestKey, expectedRevision: revision, scope: scopeSchema, content: z.string().trim().min(1).max(16000), origin: z.enum(['user_note', 'source_summary']), sourceRefs: sources }).strict()
  .refine(value => value.origin !== 'source_summary' || value.sourceRefs.length > 0, 'A source summary needs exact source provenance');
export const shareMemorySchema = z.object({ requestKey, expectedRevision: revision, targetAgentId: uuid, targetScope: scopeSchema }).strict();
export function parseCreate(input: unknown): CreateAgentInput { return parseRoster(createSchema, input) as CreateAgentInput; }

const baseToolIds = ['get_discussion_context', 'get_research_memory', 'search_data_library', 'read_dataset_summary'];
const templateTools: Record<AgentTemplateId, string[]> = {
  financials: [...baseToolIds, 'get_financials', 'get_financial_source_data', 'get_portfolio_financials', 'get_quotes', 'get_portfolio_quotes'],
  valuation: [...baseToolIds, 'get_financials', 'get_valuation', 'get_peer_comparison', 'get_valuation_scenarios', 'get_financial_source_data', 'get_portfolio_financials', 'get_quotes', 'get_portfolio_quotes'],
  bear: [...baseToolIds, 'get_financials', 'get_valuation', 'get_news', 'get_quotes', 'get_portfolio_quotes'],
  risk: [...baseToolIds, 'get_quotes', 'get_portfolio_quotes', 'get_financials', 'get_portfolio_financials', 'get_news'],
  moderator: ['get_discussion_context', 'get_research_memory'],
};
export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  { id: 'financials', name: '财报股友', specialty: '核对财报和现金流', description: '查看盈利质量、资产负债和现金流，指出需要核实的数据。', delivery: '财务事实、异常和待核对事项', nameEn: 'Financials friend', specialtyEn: 'Check accounts and cash flow', descriptionEn: 'Review earnings quality, balance sheets and cash flow, and identify facts to verify.', deliveryEn: 'Financial facts, exceptions and checks', instructions: '核对财务报表、盈利质量、资产负债和现金流。清楚区分事实、推断和未知项，引用获准的精确来源；资料不足时说明缺口。' },
  { id: 'valuation', name: '估值股友', specialty: '估算价值和检验假设', description: '用明确假设比较估值情景，解释价格对经营变化的敏感性。', delivery: '估值区间、关键假设和敏感因素', nameEn: 'Valuation friend', specialtyEn: 'Estimate value and test assumptions', descriptionEn: 'Compare valuation scenarios with explicit assumptions and explain sensitivity.', deliveryEn: 'Value ranges, assumptions and sensitivities', instructions: '分析公司估值，给出清楚的假设、情景、价值区间和敏感性。将可验证的事实与主观估计分开，不伪造现价或财务数据。' },
  { id: 'bear', name: '反方股友', specialty: '寻找反证和遗漏风险', description: '挑战看似合理的观点，寻找会推翻结论的事实。', delivery: '主要反证、失败条件和验证办法', nameEn: 'Counterpoint friend', specialtyEn: 'Find counterevidence and blind spots', descriptionEn: 'Challenge plausible views and identify facts that could overturn them.', deliveryEn: 'Counterevidence, failure conditions and checks', instructions: '独立寻找反证、错误假设、周期风险和遗漏信息。对最有力的论点进行公平检验；明确哪些事实会推翻原结论，不为反对而反对。' },
  { id: 'risk', name: '风险股友', specialty: '复核组合风险和行动边界', description: '检查集中度、流动性和不利情景，说明仍不确定的风险。', delivery: '风险清单、压力情景和约束建议', nameEn: 'Risk friend', specialtyEn: 'Review portfolio risk and limits', descriptionEn: 'Review concentration, liquidity and adverse scenarios, including unknown risks.', deliveryEn: 'Risks, stress scenarios and suggested limits', instructions: '复核组合集中度、流动性、不利情景和行动边界。提出可解释的风险约束；确定性的账户和交易检查由系统执行，不宣称有真实交易权限。' },
  { id: 'moderator', name: '主持股友', specialty: '梳理共识、分歧和下一步', description: '整合已完成的研究，保留分歧和未知项，不伪造全员共识。', delivery: '结论、证据、分歧和下一步', nameEn: 'Moderator friend', specialtyEn: 'Clarify agreement and next steps', descriptionEn: 'Combine completed research while preserving disagreement and unknowns.', deliveryEn: 'Conclusions, evidence, disagreements and next steps', instructions: '整合已完成的研究并主持有限讨论。保留证据、分歧、假设和未知项；缺少必要工作时说明部分完成，不将趋同包装成正确，不创建隐藏参与者。' },
].map(template => ({ ...template, id: template.id as AgentTemplateId, allowedToolIds: templateTools[template.id] }));
export function prepareAgent(input: Omit<CreateAgentInput, 'requestKey'>) {
  const template = AGENT_TEMPLATES.find(t => t.id === (input.templateId ?? 'financials'))!;
  // This is a transparent editable template draft, not a model-generated capability claim.
  const description = input.description ?? template.description;
  const config: AgentVersionConfig = { schemaVersion: 1, templateId: template.id, instructions: input.instructions ?? template.instructions + (input.description ? '\n用户希望的专长：' + input.description : ''), executor: input.executor,
    allowedToolIds: (input.allowedToolIds ?? template.allowedToolIds).map(canonicalAgentToolId), allowedSources: input.allowedSources ?? [], preferences: { language: 'zh-CN', responseStyle: 'concise', userPreferences: '', ...input.preferences } };
  return { name: input.name ?? template.name, specialty: input.specialty ?? template.specialty, description, config };
}
export function sourceKey(ref: ResearchSourceRef): string { return `${ref.kind}:${ref.id}:${ref.revision}`; }
export function canonicalAgentToolId(id: string): string { return id.startsWith('builtin:') ? id.slice('builtin:'.length) : id; }
export function assertCeiling(sources: ResearchSourceRef[], tools: string[], requestedSources: ResearchSourceRef[], requestedTools: string[]): void {
  const allowedSources = new Set(sources.filter(r => r.availability === 'available').map(sourceKey));
  const allowedTools = new Set(tools.map(canonicalAgentToolId));
  if (requestedSources.some(r => r.availability !== 'available' || !allowedSources.has(sourceKey(r))) || requestedTools.some(id => !allowedTools.has(canonicalAgentToolId(id))))
    rosterError('AGENT_SCOPE_DENIED', 'This task exceeds the friend’s saved source or tool scope');
}
export function snapshotMember(profile: { id: string; name: string; currentVersionId: string }, version: { id: string; config: AgentVersionConfig }, selection: AgentSelection): AgentCouncilMember {
  const executor = version.config.executor;
  const role = selection.role ?? (version.config.templateId === 'moderator' ? 'manager' : version.config.templateId === 'bear' ? 'challenger' : 'researcher');
  return { id: selection.memberId ?? 'agent-' + profile.id.replaceAll('-', '').slice(0, 24), role, name: profile.name, instructions: version.config.instructions + (version.config.preferences.userPreferences ? '\n用户明确设置的通用偏好：' + version.config.preferences.userPreferences : ''),
    rosterAgentId: profile.id, rosterAgentVersionId: version.id, executionMode: executor.executionMode,
    model: executor.executionMode === 'model' ? executor.model : 'slow', ...(executor.executionMode === 'local'
      ? { agentId: executor.localAgentId, agentSettings: executor.settings } : { connectionId: executor.connectionId }) };
}
export function defaultRole(template: AgentTemplateId) { return template === 'moderator' ? 'manager' : template === 'bear' ? 'challenger' : 'researcher'; }
