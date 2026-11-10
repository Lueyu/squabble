import { BadRequestException, ConflictException } from '@nestjs/common';
import { z } from 'zod';
import { contentHash } from './research-documents.rules';

const requestKey = z.string().trim().min(1).max(200);
export const deleteVersionSchema = z.object({ expectedVersion: z.number().int().positive(), requestKey }).strict();
export const deleteConversationSchema = z.object({ expectedRevision: z.number().int().positive(), requestKey }).strict();
export function parseDeletion<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BadRequestException('RESEARCH_DELETE_INVALID_REQUEST');
  return parsed.data;
}
export function deletionHash(kind: 'version' | 'conversation', id: string, input: unknown): string {
  return contentHash({ kind, id, input });
}
export function assertDeletionReceipt(existingHash: string, requestedHash: string): void {
  if (existingHash !== requestedHash) throw new ConflictException('RESEARCH_DELETE_REQUEST_CONFLICT');
}
