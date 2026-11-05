import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const validZone = (value: string) => { try { new Intl.DateTimeFormat('en',{timeZone:value}); return true; } catch { return false; } };
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {const d=new Date(s+'T12:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().startsWith(s);});
export const requestKey = z.string().min(1).max(200);
export const topicKey = z.string().regex(/^(portfolio|ticker:[A-Z0-9.^][A-Z0-9.^/_-]{0,19})$/);
export const refreshSchema = z.object({topicKey,date:date.optional(),requestKey,trigger:z.literal('first_open').optional()}).strict();
export const currentQuerySchema = z.object({topicKey,date:date.optional()}).strict();
export const preferencesSchema = z.object({timezone:z.string().refine(validZone).optional(),defaultMembers:z.array(z.string().min(1).max(200)).max(3).optional(),requestKey}).strict();
export function parseRefresh(input: unknown) { const p=refreshSchema.safeParse(input);if(!p.success) throw new BadRequestException('INVALID_RESEARCH_REQUEST');return p.data; }
export function businessDate(at: Date, timezone: string) { return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(at); }
export function generationIdentity(topic: string, day: string, facts: unknown): string {
  const canonical = (value: unknown): unknown => Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
    ?Object.fromEntries(Object.entries(value).filter(([key])=>!['capturedAt','asOf'].includes(key)).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,canonical(v)])):value;
  return createHash('sha256').update(JSON.stringify([topic,day,canonical(facts)])).digest('hex');
}
export function shouldPublish(currentSequence: number, finishedSequence: number, status: string) { return currentSequence===finishedSequence&&status==='completed'; }
