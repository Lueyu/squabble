/** Converts local midnight independently for each date, preserving 23/25-hour DST days. */
export function simulationDayStart(date: string, timezone: string): Date {
  const wall = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 10) !== date) throw new Error('Invalid review calendar date');
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let instant = wall;
  for (let pass = 0; pass < 4; pass++) {
    const p = Object.fromEntries(format.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
    const shown = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    if (shown === wall) return new Date(instant);
    instant += wall - shown;
  }
  throw new Error('The local calendar date has no unambiguous midnight');
}
export const adjacentSimulationDate = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
export function observedDrawdown(values: number[]): string | null {
  if (values.length < 2 || values.some(value => !Number.isFinite(value) || value < 0)) return null;
  let peak = values[0]; let maximum = 0;
  for (const value of values) { peak = Math.max(peak, value); if (peak > 0) maximum = Math.max(maximum, (peak - value) / peak * 100); }
  return maximum.toFixed(4);
}
