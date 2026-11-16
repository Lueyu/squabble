import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ANIMAL_AVATAR_IDS, type AnimalAvatarId } from '../../../shared/animal-avatar';
import { agentWorkingInstructions } from '../../../shared/agent-working-instructions';
import { AGENT_TEMPLATE_IDS } from '../../../shared/agent-roster.interface';
import type { AgentTemplate, AgentTemplateId, CreateAgentInput, AgentVersionConfig, AgentSelection, AgentCouncilMember } from '../../../shared/agent-roster.interface';
import { AGENT_SPECIALTY_CATALOG } from '../../../shared/agent-specialty-catalog';

export { LEGACY_AGENT_TEMPLATE_IDS } from '../../../shared/agent-roster.interface';
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
export const templateId = z.enum(AGENT_TEMPLATE_IDS);
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
const editable = { avatar: z.enum(ANIMAL_AVATAR_IDS).optional(), templateId: templateId.optional(), name: z.string().trim().min(1).max(80).optional(), specialty: z.string().trim().min(1).max(300).optional(), description: z.string().trim().max(4000).optional(), instructions: z.string().trim().min(1).max(16000).optional(), executor: executorSchema.optional(), allowedToolIds: toolIds.optional(), allowedSources: sources.optional(), preferences: preferences.optional() };
const createSchema = z.object({ requestKey, ...editable, executor: executorSchema }).strict();
export const updateSchema = z.object({ requestKey, expectedRevision: revision, ...editable }).strict();
export const archiveSchema = z.object({ requestKey, expectedRevision: revision }).strict();
export const recommendedSchema = z.object({ requestKey, executor: executorSchema, language: z.enum(['zh-CN', 'en']).optional(), templateIds: z.array(templateId).min(1).max(AGENT_TEMPLATE_IDS.length).refine(ids => new Set(ids).size === ids.length).optional() }).strict();
export const scopeSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('personal') }).strict(), z.object({ kind: z.literal('team'), teamId: uuid }).strict(), z.object({ kind: z.literal('conversation'), conversationId: uuid }).strict()]);
export const writeMemorySchema = z.object({ requestKey, expectedRevision: revision, scope: scopeSchema, content: z.string().trim().min(1).max(16000), origin: z.enum(['user_note', 'source_summary']), sourceRefs: sources }).strict()
  .refine(value => value.origin !== 'source_summary' || value.sourceRefs.length > 0, 'A source summary needs exact source provenance');
export const shareMemorySchema = z.object({ requestKey, expectedRevision: revision, targetAgentId: uuid, targetScope: scopeSchema }).strict();
export function parseCreate(input: unknown): CreateAgentInput { return parseRoster(createSchema, input) as CreateAgentInput; }

/**
 * The twelve-preset catalog lives in shared/agent-specialty-catalog.ts (single source:
 * identities, bilingual text, tool ceilings and guidance). Runtime derivation keeps one
 * authority; nothing here maintains a second copy of template bodies or avatars.
 */
export const AGENT_TEMPLATES: readonly AgentTemplate[] = AGENT_SPECIALTY_CATALOG;
export function prepareAgent(input: Omit<CreateAgentInput, 'requestKey'>) {
  const template = AGENT_TEMPLATES.find(t => t.id === (input.templateId ?? 'financials'))!;
  // This is a transparent editable template draft, not a model-generated capability claim.
  const english = input.preferences?.language === 'en';
  const description = input.description ?? (english ? template.descriptionEn : template.description);
  const config: AgentVersionConfig = { schemaVersion: 1, templateId: template.id, instructions: input.instructions ?? (english ? template.instructionsEn : template.instructions) + (input.description ? (english ? '\nUser-requested specialty: ' : '\n用户希望的专长：') + input.description : ''), executor: input.executor,
    allowedToolIds: (input.allowedToolIds ?? template.allowedToolIds).map(canonicalAgentToolId), allowedSources: input.allowedSources ?? [], preferences: { language: 'zh-CN', responseStyle: 'concise', userPreferences: '', ...input.preferences } };
  return { avatar: input.avatar ?? template.avatar, name: input.name ?? (english ? template.nameEn : template.name), specialty: input.specialty ?? (english ? template.specialtyEn : template.specialty), description, config };
}
export function sourceKey(ref: ResearchSourceRef): string { return `${ref.kind}:${ref.id}:${ref.revision}`; }
export function canonicalAgentToolId(id: string): string { return id.startsWith('builtin:') ? id.slice('builtin:'.length) : id; }
export function assertCeiling(sources: ResearchSourceRef[], tools: string[], requestedSources: ResearchSourceRef[], requestedTools: string[]): void {
  const allowedSources = new Set(sources.filter(r => r.availability === 'available').map(sourceKey));
  const allowedTools = new Set(tools.map(canonicalAgentToolId));
  if (requestedSources.some(r => r.availability !== 'available' || !allowedSources.has(sourceKey(r))) || requestedTools.some(id => !allowedTools.has(canonicalAgentToolId(id))))
    rosterError('AGENT_SCOPE_DENIED', 'This task exceeds the friend’s saved source or tool scope');
}
export function snapshotMember(profile: { id: string; name: string; currentVersionId: string; avatar?: AnimalAvatarId }, version: { id: string; config: AgentVersionConfig }, selection: AgentSelection): AgentCouncilMember {
  const executor = version.config.executor;
  const role = selection.role ?? (version.config.templateId === 'moderator' ? 'manager' : version.config.templateId === 'bear' ? 'challenger' : 'researcher');
  return { id: selection.memberId ?? 'agent-' + profile.id.replaceAll('-', '').slice(0, 24), role, name: profile.name, ...(profile.avatar ? { avatar: profile.avatar } : {}), instructions: agentWorkingInstructions(version.config),
    rosterAgentId: profile.id, rosterAgentVersionId: version.id, executionMode: executor.executionMode,
    model: executor.executionMode === 'model' ? executor.model : 'slow', ...(executor.executionMode === 'local'
      ? { agentId: executor.localAgentId, agentSettings: executor.settings } : { connectionId: executor.connectionId }) };
}
export function defaultRole(template: AgentTemplateId) { return template === 'moderator' ? 'manager' : template === 'bear' ? 'challenger' : 'researcher'; }
