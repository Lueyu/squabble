export type ZonedInputResult = { iso: string; error?: never; candidates: string[] }
  | { iso?: never; error: 'invalid' | 'zone' | 'nonexistent' | 'ambiguous'; candidates: string[] };

function parts(instant: Date, timezone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(instant).map(part => [part.type, part.value]));
}
export function zonedInput(iso: string, timezone: string): string {
  try { const value = parts(new Date(iso), timezone); return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`; }
  catch { return ''; }
}
export function businessTime(iso: string, timezone: string): string {
  try { return new Intl.DateTimeFormat(undefined, { timeZone: timezone, dateStyle: 'medium', timeStyle: 'long' }).format(new Date(iso)); }
  catch { return iso; }
}

/** Resolve a wall clock in an IANA zone without accepting Date's silent DST normalization. */
export function resolveZonedInput(value: string, timezone: string, choice?: string): ZonedInputResult {
  try { parts(new Date(0), timezone); } catch { return { error: 'zone', candidates: [] }; }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return { error: 'invalid', candidates: [] };
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  if (year < 1970 || new Date(wall).toISOString().slice(0, 16) !== value) return { error: 'invalid', candidates: [] };
  const offsets = new Set<number>();
  // Offsets on both sides of a nearby transition produce every valid instant, including half-hour DST.
  for (let hours = -48; hours <= 48; hours += 6) {
    const instant = new Date(wall + hours * 3_600_000); const local = parts(instant, timezone);
    offsets.add(Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day), Number(local.hour), Number(local.minute), Number(local.second)) - instant.getTime());
  }
  const candidates = [...new Set([...offsets].map(offset => new Date(wall - offset).toISOString()).filter(iso => zonedInput(iso, timezone) === value))].sort();
  if (!candidates.length) return { error: 'nonexistent', candidates };
  if (candidates.length > 1 && (!choice || !candidates.includes(choice))) return { error: 'ambiguous', candidates };
  return { iso: choice && candidates.includes(choice) ? choice : candidates[0], candidates };
}

export function strategyPeriodDates(period: 'day' | 'month' | 'custom', timezone: string, now = new Date()): { startsAt: string; endsAt: string } {
  const local = parts(now, timezone); const year = Number(local.year); const month = Number(local.month); const day = Number(local.day);
  const lastDate = period === 'month' ? new Date(Date.UTC(year, month, 0)) : new Date(Date.UTC(year, month - 1, day + (period === 'custom' ? 7 : 0)));
  const end = resolveZonedInput(`${lastDate.toISOString().slice(0, 10)}T23:59`, timezone);
  if (!end.iso) throw new Error('STRATEGY_INVALID_BUSINESS_DATE');
  return { startsAt: now.toISOString(), endsAt: new Date(Date.parse(end.iso) + 59999).toISOString() };
}
