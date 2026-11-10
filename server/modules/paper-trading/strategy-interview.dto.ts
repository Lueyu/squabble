import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const key = z.string().min(8).max(200);
const field = z.enum(['idea', 'security', 'condition', 'amount', 'frequency', 'period']);
const message = z.string().min(1).max(1500).refine(value => value.trim().length > 0);
const mutation = { expectedRevision: z.number().int().positive(), requestKey: key };
export const interviewIdSchema = z.uuid();
export const createInterviewSchema = z.object({ accountId: z.uuid(), baseStrategyId: z.uuid().optional(), message, requestKey: key }).strict();
export const answerInterviewSchema = z.object({ ...mutation, field, message }).strict();
export const acceptInterviewSchema = z.object({ ...mutation, suggestionId: z.uuid() }).strict();
export const previewInterviewSchema = z.object({ ...mutation, observationOnly: z.boolean().optional() }).strict();
export function parseInterviewInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BadRequestException('INVALID_STRATEGY_INTERVIEW_INPUT');
  return parsed.data;
}
