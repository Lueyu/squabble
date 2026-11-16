/**
 * RunProgressBar - 多 agent 分析流水线的横向步骤条（获取证据 → 多空辩论 →
 * 批评者复核 → 风控闸门检查 → 最终评级）。
 *
 * 每一步渲染为一个圆点，其视觉状态由 run 当前状态经 getStepState() 推导：
 *   done     -> 翡翠绿圆点 + 对勾图标
 *   active   -> 主色脉冲圆点（当前正在执行的阶段）
 *   failed   -> 玫红圆点 + 叉号图标（run 失败/取消）
 *   awaiting -> 琥珀圆点（流水线跑完，等待人工决策）
 *   pending  -> 弱化灰圆点（尚未到达）
 */
import { Check, X } from 'lucide-react';
import type { AgentRunStatus } from '@shared/api.interface';
import { useTranslation } from 'react-i18next';

interface RunProgressBarProps {
  /** 所可视化 agent run 的当前流水线状态 */
  status: AgentRunStatus;
}

/** 步骤条中展示的单个流水线步骤 */
interface StepDef {
  /** 唯一步骤 key */
  key: string;
  /** 圆点下方渲染的短标签 */
  labelKey: string;
  /** 表示"本步骤正在执行"的 AgentRunStatus 值 */
  statusKey: AgentRunStatus;
}

/** 按顺序（自左向右）渲染为步骤圆点的流水线阶段 */
const steps: StepDef[] = [
  { key: 'fetching', labelKey: 'ui.agent.stepEvidence', statusKey: 'fetching' },
  { key: 'debating', labelKey: 'ui.agent.stepDebate', statusKey: 'debating' },
  { key: 'critiquing', labelKey: 'ui.agent.stepCritic', statusKey: 'critiquing' },
  { key: 'risk_check', labelKey: 'ui.agent.stepRisk', statusKey: 'risk_check' },
  { key: 'completed', labelKey: 'ui.agent.stepRating', statusKey: 'completed' },
];

/**
 * 流水线上各状态的规范顺序。run 的状态在本列表中越过了某步骤自身的
 * statusKey 之后，该步骤即视为"已完成"。
 * 注意：'failed'/'cancelled' 是终态，在下方单独处理。
 */
const statusOrder: AgentRunStatus[] = [
  'pending',
  'fetching',
  'debating',
  'critiquing',
  'risk_check',
  'awaiting_human',
  'completed',
];

/**
 * 由 run 当前状态推导单个步骤圆点的视觉状态。
 * 'awaiting_human' 表示全部分析阶段已完成，但评级须人工批准后才能发布。
 */
function getStepState(
  stepIndex: number,
  status: AgentRunStatus,
): 'done' | 'active' | 'pending' | 'failed' | 'awaiting' {
  const currentIdx = statusOrder.indexOf(status);
  const stepStatusIdx = statusOrder.indexOf(steps[stepIndex].statusKey);

  if (status === 'failed' || status === 'cancelled') {
    // 已越过的步骤按完成渲染，失败步骤显示 failed；
    // 需要知道失败时正在执行哪一步 —— 近似处理：参考前一步的索引。
    const stepKeys: AgentRunStatus[] = [
      'fetching',
      'debating',
      'critiquing',
      'risk_check',
      'completed',
    ];
    // 由于缺少"失败步骤"字段，近似处理为把第一步显示为失败
    if (stepIndex === 0) return 'failed';
    return 'pending';
  }

  if (status === 'pending') return 'pending';

  if (stepStatusIdx < currentIdx) return 'done';
  if (stepStatusIdx === currentIdx) return 'active';

  // awaiting_human：五个步骤全部完成，仅等待人工决策
  if (status === 'awaiting_human' && stepIndex === steps.length - 1) {
    return 'awaiting';
  }

  return 'pending';
}

/** 渲染五个步骤圆点及其间的连接线。 */
function RunProgressBar({ status }: RunProgressBarProps) {
  const { t } = useTranslation();
  return (
    <div className="w-full">
      <div className="flex items-center justify-between">
        {steps.map((step, idx) => {
          // 由 run 状态推导本步骤的视觉状态。
          const state = getStepState(idx, status);
          return (
            <div key={step.key} className="flex flex-1 flex-col items-center last:flex-none">
              <div
                className={[
                  'relative z-10 flex h-6 w-6 items-center justify-center rounded-full border-2 text-[10px] font-semibold transition-colors',
                  state === 'done'
                    ? 'border-emerald-500 bg-emerald-500 text-white'
                    : state === 'active'
                      ? 'border-primary bg-primary text-primary-foreground animate-pulse'
                      : state === 'failed'
                        ? 'border-rose-500 bg-rose-500 text-white'
                        : state === 'awaiting'
                          ? 'border-amber-500 bg-amber-500 text-white'
                          : 'border-slate-300 bg-white text-slate-400 dark:border-slate-600 dark:bg-slate-800',
                ].join(' ')}
              >
                {state === 'done' ? (
                  <Check size={12} strokeWidth={3} />
                ) : state === 'failed' ? (
                  <X size={12} strokeWidth={3} />
                ) : state === 'awaiting' ? (
                  <span className="text-[9px]">{t('ui.agent.stepAwaiting')}</span>
                ) : (
                  <span>{idx + 1}</span>
                )}
              </div>
              <span
                className={[
                  'mt-1 text-[10px] font-medium',
                  state === 'done'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : state === 'active'
                      ? 'text-primary'
                      : state === 'failed'
                        ? 'text-rose-600 dark:text-rose-400'
                        : state === 'awaiting'
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-slate-400',
                ].join(' ')}
              >
                {t(step.labelKey)}
              </span>
              {idx < steps.length - 1 && (
                <div className="absolute top-3 left-full h-0.5 w-full -translate-y-1/2">
                  {/* 连接线由父级 flex 行绘制（见下方 -mt-9 区域） */}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {/* 连接线行：用 -mt-9 上移，落在两排圆点之间；
          当第 idx 步到第 idx+1 步的过渡已开始或完成时，该线呈翡翠绿 */}
      <div className="-mt-9 flex">
        {steps.slice(0, -1).map((_step, idx) => {
          const state = getStepState(idx, status);
          const nextState = getStepState(idx + 1, status);
          const done =
            state === 'done' &&
            (nextState === 'done' || nextState === 'active' || nextState === 'awaiting');
          return (
            <div
              key={`line-${idx}`}
              className={[
                'mt-0 flex-1 border-t-2',
                done ? 'border-emerald-500' : 'border-slate-200 dark:border-slate-700',
              ].join(' ')}
              style={{ marginLeft: '1.25rem', marginRight: '1.25rem' }}
            />
          );
        })}
      </div>
    </div>
  );
}

export default RunProgressBar;
