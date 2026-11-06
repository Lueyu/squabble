import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { ReportReference, ResolvedReportReference, ResearchDocumentSection, ResearchDocumentVersion, ResearchRevisionInput, ResearchSectionDiff, ResearchReportCategory } from '../../../shared/research-document.interface';

export const reportIdSchema = z.string().uuid();
export const reportSourceSchema = z.object({ type: z.enum(['daily', 'deep', 'portfolio', 'council']), id: reportIdSchema }).strict();
const sectionSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), title: z.string().min(1).max(200), content: z.string().max(100_000) }).strict();
export const reportReferencesSchema = z.array(z.object({ versionId: reportIdSchema, sectionId: z.string().max(100).optional(), excerpt: z.string().min(1).max(6000).optional() }).strict()).max(20);
export const reportIndexSchema = z.object({ category: z.enum(['all', 'daily', 'stock', 'review']).default('all'),
  topic: z.string().max(100).optional(), state: z.enum(['all', 'adopted', 'draft', 'strategy']).default('all'), search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(100_000).default(0),
  history: z.union([z.boolean(), z.enum(['true', 'false']).transform(value => value === 'true')]).default(false),
  from: z.iso.date().optional(), to: z.iso.date().optional(),date:z.iso.date().optional(),source:reportSourceSchema.shape.type.optional() }).strict();
export const revisionSchema = z.object({ title: z.string().trim().min(1).max(300), content: z.string().trim().min(1).max(300_000),
  changeReason: z.string().trim().min(1).max(3000), sections: z.array(sectionSchema).max(200).optional(), sourceReferences: reportReferencesSchema.optional() }).strict();
export const submitSchema = z.object({ idempotencyKey: z.string().min(1).max(300), title: z.string().trim().min(1).max(300), kind: reportSourceSchema.shape.type,
  ticker: z.string().max(30).nullable().optional(), content: z.string().min(1).max(300_000), sections: z.array(sectionSchema).min(1).max(200),
  source: reportSourceSchema.nullable().optional(), reportId: reportIdSchema.optional(), parentVersionId: reportIdSchema.nullable().optional(),
  changeReason: z.string().max(3000).nullable().optional(), dataAsOf: z.iso.datetime({ offset: true }).nullable().optional(),
  availableAt: z.iso.datetime({ offset: true }).nullable().optional(), snapshot: z.record(z.string(), z.unknown()).nullable().optional() }).strict();

export function parseReportRequest<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BadRequestException('REPORT_INVALID_REQUEST');
  return parsed.data;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && !(value instanceof Date)) return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export function contentHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
export function reportTopic(ticker: string | null | undefined): string {
  return !ticker?.trim() || ticker.trim().toUpperCase() === 'PORTFOLIO' ? 'portfolio' : `ticker:${ticker.trim().toUpperCase()}`;
}
export function reportCategory(version: Pick<ResearchDocumentVersion, 'kind' | 'ticker' | 'snapshot'>): ResearchReportCategory {
  if (version.snapshot?.experimentId || version.snapshot?.scene === 'trade_post_review') return 'review';
  return version.kind === 'deep' || version.kind === 'council' && reportTopic(version.ticker) !== 'portfolio' ? 'stock' : 'daily';
}
export function assertIdempotency(existingHash: string, requestedHash: string): void {
  if (existingHash !== requestedHash) throw new ConflictException('REPORT_IDEMPOTENCY_CONFLICT');
}
export function assertAdoption(reportId: string, adoptedVersionId: string | null, version: ResearchDocumentVersion, expected: string | null): void {
  if (version.reportId !== reportId) throw new ConflictException('REPORT_BRANCH_MISMATCH');
  if (adoptedVersionId !== expected) throw new ConflictException('REPORT_ADOPTION_CONFLICT');
  if (version.status === 'revoked') throw new ConflictException('REPORT_REVOKED');
}
export function validateRevision(input: unknown): ResearchRevisionInput {
  const parsed = revisionSchema.safeParse(input);
  if (!parsed.success) throw new BadRequestException('REPORT_INVALID_REVISION');
  if (parsed.data.sections && new Set(parsed.data.sections.map(s => s.id)).size !== parsed.data.sections.length) throw new BadRequestException('REPORT_DUPLICATE_SECTION');
  return parsed.data;
}
export function sectionsFromRecord(record: Record<string, unknown>): ResearchDocumentSection[] {
  return Object.entries(record).filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([key, value]) => ({ id: key.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 100), title: key,
      content: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }));
}
export function resolveExactReference(version: ResearchDocumentVersion, reference: ReportReference): ResolvedReportReference {
  if (version.id !== reference.versionId) throw new BadRequestException('REPORT_VERSION_MISMATCH');
  const section = reference.sectionId ? version.sections.find(s => s.id === reference.sectionId) ?? null : null;
  if (reference.sectionId && !section) throw new NotFoundException('REPORT_SECTION_NOT_FOUND');
  const content = section?.content ?? version.content;
  if (reference.excerpt && !content.includes(reference.excerpt)) throw new BadRequestException('REPORT_EXCERPT_MISMATCH');
  return { ...reference, reportId: version.reportId, version: version.version, title: version.title, kind: version.kind,
    ticker: version.ticker, content, section, dataAsOf: version.dataAsOf, availableAt: version.availableAt, createdAt: version.createdAt,
    snapshot: version.snapshot, source: version.source, parentVersionId: version.parentVersionId, status: version.status, sourceStatus: version.sourceStatus };
}
export function diffSections(before: ResearchDocumentSection[], after: ResearchDocumentSection[]): ResearchSectionDiff[] {
  const ids = new Set([...before, ...after].map(s => s.id));
  return [...ids].flatMap(id => {
    const a = before.find(s => s.id === id); const b = after.find(s => s.id === id);
    if (a?.content === b?.content && a?.title === b?.title) return [];
    return [{ id, title: b?.title ?? a!.title, before: a?.content ?? null, after: b?.content ?? null,
      change: !a ? 'added' as const : !b ? 'removed' as const : 'changed' as const }];
  });
}
