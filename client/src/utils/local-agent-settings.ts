/**
 * @file utils/local-agent-settings.ts
 * @description 本地智能体（native agent）配置的校验与清洗。
 *
 * 职责边界：
 *  - 只做"配置 → 错误码/清洗后的配置"的纯判定；不发请求
 * 上下游：
 *  - 上游（谁调用这里）：Council/CouncilMemberEditor（agentReasoningEfforts /
 *    agentSettingsProblem / cleanAgentSettings）
 *  - 下游（本文件调用谁）：@shared/local-agents.interface 的类型
 * 关键约定：
 *  - AGENT_MODEL_MAX_LENGTH = 160 是模型标识的长度上限
 */
import type { NativeAgentConfiguration, NativeAgentStatus } from '@shared/local-agents.interface';

/** 模型标识的最大长度。 */
export const AGENT_MODEL_MAX_LENGTH = 160;

/**
 * 检查字符串是否含有控制字符（ASCII < 32 或 DEL 127）。
 */
function hasControlCharacters(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

/**
 * 取指定模型可用的推理档位列表。
 * 优先返回该 agent 对此模型单独声明的 reasoningEfforts，
 * 未单独声明时回退到 agent 级别的默认列表。
 */
export function agentReasoningEfforts(
  agent: NativeAgentStatus | undefined,
  model?: string,
): string[] | undefined {
  return (
    agent?.models?.find((item) => item.id === model?.trim())?.reasoningEfforts ??
    agent?.reasoningEfforts
  );
}

/**
 * 校验本地智能体配置。
 * @returns 'modelInvalid'（模型标识超长或含控制字符）、
 *          'modelUnsupported'（agent 未声明任何模型清单）、
 *          'reasoningInvalid'（推理档位非法：超长/控制字符/不在可选列表），
 *          通过返回 null。
 */
export function agentSettingsProblem(
  settings: NativeAgentConfiguration | undefined,
  agent: NativeAgentStatus | undefined,
): 'modelInvalid' | 'modelUnsupported' | 'reasoningInvalid' | null {
  // 步骤 1：模型标识检查（长度上限 + 控制字符）。
  const model = settings?.model;
  if (model !== undefined && (model.length > AGENT_MODEL_MAX_LENGTH || hasControlCharacters(model)))
    return 'modelInvalid';
  // 步骤 2：填了模型但 agent 未下发模型清单 → 无法验证支持性。
  if (model?.trim() && agent?.models === undefined) return 'modelUnsupported';
  // 步骤 3：推理档位检查（长度、控制字符、必须在该 agent/模型的可选列表里）。
  const effort = settings?.reasoningEffort;
  if (
    effort &&
    (effort.length > 32 ||
      hasControlCharacters(effort) ||
      !agentReasoningEfforts(agent, model)?.includes(effort))
  )
    return 'reasoningInvalid';
  return null;
}

/**
 * 清洗配置：trim 模型标识，丢弃空字段。
 * @returns 两个拼接字段都为空时返回 undefined（表示"无智能体配置"）。
 */
export function cleanAgentSettings(
  settings?: NativeAgentConfiguration,
): NativeAgentConfiguration | undefined {
  // trim 后的模型与原样的推理档位。
  const model = settings?.model?.trim();
  const reasoningEffort = settings?.reasoningEffort;
  // 有任一字段才产出对象；字段级条件展开避免写入空值。
  return model || reasoningEffort
    ? { ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) }
    : undefined;
}
