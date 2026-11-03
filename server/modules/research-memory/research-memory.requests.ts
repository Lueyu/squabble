import { z } from 'zod';
export const memoryIdSchema = z.string().uuid();
const text = z.string().trim().min(1).max(1500);
const lines = z.array(text).max(20);
const reference = z.object({ evidenceId: z.string().trim().min(1).max(100) }).strict();
const horizon = z.object({ startAt: z.iso.datetime().optional(), endAt: z.iso.datetime().optional(),
  reviewAt: z.iso.datetime().optional() }).strict().refine(value => !value.startAt || !value.endAt
    || Date.parse(value.startAt) <= Date.parse(value.endAt), 'Horizon ends before it starts');
export const thesisContentSchema = z.object({
  claim: text,
  supportingEvidence: z.array(reference).max(20),
  opposingEvidence: lines, assumptions: lines, indicators: lines, invalidationConditions: lines,
  horizon: horizon.optional(), boundaryOrigin: z.enum(['stated', 'proposed', 'unknown']).optional(),
  evidenceRelations: z.array(reference.extend({ role: z.enum(['support', 'refute', 'qualify']) })).max(40).optional(),
}).strict();
export const thesisCandidateSchema = thesisContentSchema.extend({ expiresAt: z.iso.datetime().nullable().optional() });
export const memoryQuerySchema = z.object({ ticker: z.string().trim().min(1).max(20),
  market: z.enum(['US', 'HK', 'CN']).optional(), topic: z.string().trim().max(120).optional() }).strict();
export const memoryPreferencesSchema = z.object({ autoArchive: z.boolean(), recallEnabled: z.boolean() }).strict();
export const memoryUpdateSchema = z.object({ excluded: z.boolean() }).strict();
export const thesisDeleteSchema = z.object({ expectedVersion: z.number().int().min(1) }).strict();
export const thesisUpdateSchema = z.object({
  expectedVersion: z.number().int().min(1), action: z.enum(['confirm', 'edit', 'dismiss', 'expire', 'exclude']),
  content: thesisContentSchema.optional(), expiresAt: z.iso.datetime().nullable().optional(), excluded: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action === 'edit' && !value.content) ctx.addIssue({ code: 'custom', message: 'Content required', path: ['content'] });
  if (value.action === 'exclude' && value.excluded === undefined) ctx.addIssue({ code: 'custom', message: 'Excluded required', path: ['excluded'] });
  if (value.action !== 'edit' && value.content) ctx.addIssue({ code: 'custom', message: 'Use edit action', path: ['content'] });
});
