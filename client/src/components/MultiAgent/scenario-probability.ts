import type { DeepReport } from '@shared/api.interface';

type ScenarioProbabilities = Pick<DeepReport, 'probBear' | 'probBase' | 'probBull'>;

/**
 * Built-in reports use fractions, but external reports have no enforced unit.
 * Scale only a complete fractional distribution whose sum is within 1e-6 of 1
 * (floating-point tolerance, not missing-probability normalization). Preserve
 * percentage-style, incomplete, and ambiguous inputs exactly as received.
 */
export function formatScenarioProbabilities(values: ScenarioProbabilities): ScenarioProbabilities {
  const raw: Array<string | null> = [values.probBear, values.probBase, values.probBull];
  if (raw.some((value: string | null) => value == null || value.trim() === '')) return values;
  const numbers: number[] = raw.map((value: string | null) => Number(value));
  const isFraction: boolean =
    numbers.every((value: number) => Number.isFinite(value) && value >= 0 && value <= 1) &&
    Math.abs(numbers.reduce((sum: number, value: number) => sum + value, 0) - 1) <= 1e-6;
  if (!isFraction) return values;

  const percent = (value: number): string => String(Number((value * 100).toFixed(2)));
  return {
    probBear: percent(numbers[0]),
    probBase: percent(numbers[1]),
    probBull: percent(numbers[2]),
  };
}
