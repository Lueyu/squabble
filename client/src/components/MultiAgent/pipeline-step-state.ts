/**
 * @file components/MultiAgent/pipeline-step-state.ts
 * @description 多 agent 分析流水线（fetching → debating → critiquing → risk_check →
 * completed）各步骤状态推导的纯逻辑模块。
 * 输入是 AgentRunDetail 的持久化产物切片（PipelineProgress），输出每一步的可视化
 * 状态（done/active/pending/skipped/partial），供 AgentRunDetailModal 的
 * Pipeline Timeline 渲染。类型上游来自 `@shared/api.interface`。
 */
import type { AgentRunDetail } from '@shared/api.interface';

/** 流水线步骤 key：与 AgentRunStatus 中的进行中状态一一对应（另含 completed）。 */
export type PipelineStepKey = 'fetching' | 'debating' | 'critiquing' | 'risk_check' | 'completed';

/** 步骤可视化状态：done 完成 / active 进行中 / pending 未开始 / skipped 跳过 / partial 部分完成。 */
export type PipelineStepState = 'done' | 'active' | 'pending' | 'skipped' | 'partial';

/** 判定所需的 run 产物切片：run 状态 + 各阶段的持久化输出。 */
type PipelineProgress = Pick<
  AgentRunDetail,
  'status' | 'evidence' | 'arguments' | 'debate' | 'riskGate' | 'rating'
>;

/**
 * 推导单个流水线步骤的状态。
 * 核心约定：持久化产物（evidence/arguments/debate/riskGate/rating 非空）才能证明
 * 对应 AI 阶段真正执行过；run 状态到达终态本身并不证明阶段跑过 —— 有产物记
 * partial，无产物记 skipped；pending 只在 run 未到终态时出现。
 */
export function getPipelineStepState(
  step: PipelineStepKey,
  run: PipelineProgress,
): PipelineStepState {
  // 步骤正是 run 的当前状态且尚未到 completed → 该步骤进行中。
  if (step === run.status && step !== 'completed') return 'active';
  // run 已到终态（completed/awaiting_human）或已越过 risk_check → 模型阶段视为"已越过"。
  const finished = run.status === 'completed' || run.status === 'awaiting_human';
  const modelPhasesPassed = finished || run.status === 'risk_check';
  // 是否留有任何模型产物（多空论点或辩论记录）。
  const hasModelRecords = run.arguments.length > 0 || run.debate.length > 0;

  // fetching：有 evidence 即完成；若其中含 "Data Unavailable" 占位源则记 partial。
  if (step === 'fetching' && run.evidence.length > 0) {
    return run.evidence.some((item) => item.sourceName === 'Data Unavailable') ? 'partial' : 'done';
  }
  // debating：收集多空双方来源（arguments 的 side + debate 中 bull/bear 的非空发言）。
  if (step === 'debating') {
    const sides = new Set([
      ...run.arguments.map((item) => item.side),
      ...run.debate
        .filter((item) => item.speaker === 'bull' || item.speaker === 'bear')
        .filter((item) => item.content.trim())
        .map((item) => item.speaker),
    ]);
    // 双方齐全 → done；仅一方 → partial；双方皆无 → 落到底部兜底判断。
    if (sides.has('bull') && sides.has('bear')) return 'done';
    if (sides.size > 0) return 'partial';
  }
  // critiquing：有非空的 critic 发言 → done；只有空的 critic 记录 → partial。
  if (step === 'critiquing') {
    const critics = run.debate.filter((item) => item.speaker === 'critic');
    if (critics.some((item) => item.content.trim())) return 'done';
    if (critics.length > 0) return 'partial';
  }
  // debating/critiquing 未留下产物但阶段已被越过：有产物记 partial，无产物记 skipped。
  if ((step === 'debating' || step === 'critiquing') && modelPhasesPassed) {
    return hasModelRecords ? 'partial' : 'skipped';
  }
  // risk_check：有 riskGate 结果 → done。
  if (step === 'risk_check' && run.riskGate.length > 0) return 'done';
  // completed：已有 rating → done。
  if (step === 'completed' && run.rating) return 'done';
  // 兜底：run 已到终态但该步骤无产物 → partial；否则 pending。
  return finished ? 'partial' : 'pending';
}
