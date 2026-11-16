/**
 * local-agents.requests.ts — 本地智能体对外输入的 zod 校验与解析。
 *
 * 职责边界：
 *  - 原生智能体配置（model/reasoningEffort）的解析与运行时校验。
 *  - companion 协议载荷：配对请求、研究工具调用/取消、心跳轮询（poll）。
 *  - 从 `${mode}-${provider}` 形态的 id 解析 provider。
 * 上下游：
 *  - 上游：LocalAgentsService、CompanionController、LocalAgentStore。
 *  - 下游：local-agents.types（LocalAgentError）、shared/local-agent-catalog。
 * 关键约定：
 *  - 研究工具 arguments 序列化后 ≤4096 字节；callId 匹配 [A-Za-z0-9_.:-]{1,128}；工具名匹配 [a-z_]{1,80}。
 *  - 配对码为 48 位十六进制；心跳中任务更新 ≤16 条、活动事件 ≤64 条、结果文本 ≤512KB。
 */
import { z } from 'zod';
import {
  LOCAL_AGENT_PROVIDERS,
  type CompanionPoll,
  type LocalAgentProvider,
  type NativeAgentConfiguration,
  type NativeAgentStatus,
} from '../../../shared/local-agents.interface';
import { providerCatalog } from '../../../shared/local-agent-catalog';
import { LocalAgentError } from './local-agents.types';

export { providerCatalog };
const provider = z.enum(LOCAL_AGENT_PROVIDERS);
const configurationText = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\u0000-\u001f\u007f]*$/u)
    .trim()
    .min(1);
const reasoningEfforts = z
  .array(configurationText(32))
  .max(16)
  .refine((items) => new Set(items).size === items.length);
const configuration = z
  .object({
    model: configurationText(160).optional(),
    reasoningEffort: configurationText(32).optional(),
  })
  .strict();
/** 解析原生智能体配置；字段超长/含控制字符/空值时抛 LOCAL_INVALID_CONFIGURATION。 */
export function parseNativeAgentConfiguration(
  input: unknown,
): NativeAgentConfiguration | undefined {
  if (input === undefined) return undefined;
  const result = configuration.safeParse(input);
  if (!result.success) throw new LocalAgentError('LOCAL_INVALID_CONFIGURATION');
  return result.data.model || result.data.reasoningEffort ? result.data : undefined;
}
/** 校验配置与智能体实际能力匹配：模型必须在 models 列表中、reasoningEffort 必须被支持。 */
export function validateNativeAgentConfiguration(
  input: unknown,
  status?: NativeAgentStatus,
): NativeAgentConfiguration | undefined {
  const settings = parseNativeAgentConfiguration(input);
  if (!settings) return undefined;
  // models 列表存在即表示支持手动覆盖模型；空列表表示探测未发现任何建议，
  // 并不代表所有模型标识都无效。
  const efforts =
    status?.models?.find((model) => model.id === settings.model)?.reasoningEfforts ??
    status?.reasoningEfforts;
  if (
    (settings.model && !status?.models) ||
    (settings.reasoningEffort && !efforts?.includes(settings.reasoningEffort))
  ) {
    throw new LocalAgentError('LOCAL_CONFIGURATION_UNSUPPORTED');
  }
  return settings;
}
/** companion 配对请求：48 位十六进制配对码 + 设备名（1–80 字符）。 */
export const pairRequest = z
  .object({ code: z.string().regex(/^[a-f0-9]{48}$/u), name: z.string().trim().min(1).max(80) })
  .strict();
/** companion 研究工具调用请求：taskId/callId/name/arguments（序列化后 ≤4096 字节）。 */
export const researchToolRequest = z
  .object({
    taskId: z.string().uuid(),
    callId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/u),
    name: z.string().regex(/^[a-z_]{1,80}$/u),
    arguments: z
      .record(z.string(), z.unknown())
      .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 4096),
  })
  .strict();
/** companion 研究工具取消请求（taskId + callId）。 */
export const researchToolCancelRequest = researchToolRequest.pick({ taskId: true, callId: true });
const activity = z
  .object({
    id: z.string().min(1).max(128),
    kind: z.enum(['task', 'tool', 'summary', 'capability']),
    status: z.enum([
      'queued',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'interrupted',
      'unavailable',
    ]),
    at: z
      .string()
      .max(40)
      .refine((value) => Number.isFinite(Date.parse(value))),
    summary: z.string().max(2000),
    toolName: z.string().max(101).optional(),
    callId: z.string().max(128).optional(),
    durationMs: z.number().finite().min(0).max(600_000).optional(),
    sources: z
      .array(
        z
          .object({
            title: z.string().max(160),
            url: z.string().max(2048).optional(),
            fetchedAt: z.string().max(40),
          })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict();
const pollRequest = z
  .object({
    agents: z
      .array(
        z.object({
          provider,
          state: z.enum(['not_installed', 'login_required', 'ready', 'error']),
          version: z.string().max(120).optional(),
          researchTools: z
            .object({
              mode: z.enum(['mcp', 'snapshot']),
              reason: z.enum(['supported', 'version_unsupported', 'runtime_unsupported']),
            })
            .strict()
            .optional(),
          models: z
            .array(
              z
                .object({
                  id: configurationText(160),
                  name: configurationText(160),
                  reasoningEfforts: reasoningEfforts.optional(),
                })
                .strict(),
            )
            .max(256)
            .refine((models) => new Set(models.map((model) => model.id)).size === models.length)
            .optional(),
          reasoningEfforts: reasoningEfforts.optional(),
          configurationHelp: z.string().max(1000).optional(),
        }),
      )
      .max(LOCAL_AGENT_PROVIDERS.length),
    updates: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            state: z.enum(['running', 'completed', 'failed', 'cancelled']),
            events: z.array(activity).max(64).optional(),
            error: z
              .enum([
                'LOCAL_INVALID_CONFIGURATION',
                'LOCAL_CONFIGURATION_UNSUPPORTED',
                'LOCAL_VERSION_UNSUPPORTED',
                'LOCAL_LOGIN_REQUIRED',
                'LOCAL_DISPATCH_UNCERTAIN',
                'LOCAL_TOOL_ISOLATION_FAILED',
              ])
              .optional(),
            progress: z.string().max(500).optional(),
            text: z
              .string()
              .max(512_000)
              .refine((value) => Buffer.byteLength(value) <= 512_000)
              .optional(),
            usageTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
/** companion 心跳轮询载荷：智能体状态上报（≤provider 数）+ 任务更新（≤16 条），provider 不得重复。 */
export function parseCompanionPoll(input: unknown): CompanionPoll {
  const value = pollRequest.parse(input);
  if (new Set(value.agents.map((agent) => agent.provider)).size !== value.agents.length)
    throw new Error('Duplicate provider');
  return {
    ...value,
    agents: value.agents.map((agent) => ({ ...providerCatalog[agent.provider], ...agent })),
  };
}
/** 从 `${mode}-${provider}` 形态的 id 解析 provider；格式不符抛 LOCAL_AGENT_NOT_FOUND。 */
export function providerFromId(id: string, mode: 'native' | 'companion'): LocalAgentProvider {
  const parsed = provider.safeParse(
    id.startsWith(`${mode}-`) ? id.slice(mode.length + 1) : undefined,
  );
  if (!parsed.success) throw new Error('LOCAL_AGENT_NOT_FOUND');
  return parsed.data;
}
