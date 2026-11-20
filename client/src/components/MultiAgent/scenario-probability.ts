/**
 * @file components/MultiAgent/scenario-probability.ts
 * @description 深度报告三情景概率（probBear/probBase/probBull）展示格式化的纯逻辑模块。
 * 类型上游来自 `@shared/api.interface` 的 DeepReport；下游被 DeepReportView 的
 * 三情景目标价卡片调用。
 */
import type { DeepReport } from '@shared/api.interface';

/** 三情景概率字段切片：值为字符串形式，可能是小数、百分比或 null。 */
type ScenarioProbabilities = Pick<DeepReport, 'probBear' | 'probBase' | 'probBull'>;

/**
 * 内置报告使用小数，但外部报告没有强约束的单位。
 * 只缩放"总和与 1 的偏差在 1e-6 内的完整小数分布"（浮点容差，而非缺项概率归一化）。
 * 百分比风格、不完整或含糊的输入一律按原样保留。
 */
export function formatScenarioProbabilities(values: ScenarioProbabilities): ScenarioProbabilities {
  const raw: Array<string | null> = [values.probBear, values.probBase, values.probBull];
  // 第 1 步：任一值为 null 或空白 → 直接原样返回（不猜测缺项）。
  if (raw.some((value: string | null) => value == null || value.trim() === '')) return values;
  // 第 2 步：全部可转数字后，判定是否为完整小数分布：
  //   每项 ∈ [0,1]，且三项之和与 1 的偏差 ≤ 1e-6（浮点容差）。
  const numbers: number[] = raw.map((value: string | null) => Number(value));
  const isFraction: boolean =
    numbers.every((value: number) => Number.isFinite(value) && value >= 0 && value <= 1) &&
    Math.abs(numbers.reduce((sum: number, value: number) => sum + value, 0) - 1) <= 1e-6;
  if (!isFraction) return values;

  // 第 3 步：小数 → 百分比字符串（toFixed(2) 后经 Number 去掉无意义的尾零）。
  const percent = (value: number): string => String(Number((value * 100).toFixed(2)));
  return {
    probBear: percent(numbers[0]),
    probBase: percent(numbers[1]),
    probBull: percent(numbers[2]),
  };
}
