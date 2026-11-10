import { z } from 'zod';
import { dataLibraryAuthKinds, dataLibraryFormats, dataLibraryKinds } from '../../../shared/data-library.interface';
export const sourceId = z.string().uuid();
const title = z.string().trim().min(1).max(200), description = z.string().trim().max(10_000);
const secret = z.string().max(16_384).refine(v => !/[\r\n\u0000]/u.test(v), 'Invalid credential');
const auth = { authKind: z.enum(dataLibraryAuthKinds).optional(), credential: secret.optional(),
  username: z.string().max(500).refine(v => !/[\r\n:\u0000]/u.test(v)).optional(), password: secret.optional() };
const interval = z.number().int().min(60).max(43_200).nullable().optional();
export const sourceCreate = z.object({ title, description: description.optional(), kind: z.enum(['page', 'website']),
  format: z.enum(['text', 'html', 'rss', 'json']).optional(), text: z.string().max(200_000).optional(),
  url: z.string().max(2000).optional(), enabled: z.boolean().optional(), syncIntervalMinutes: interval, ...auth }).strict();
export const sourceUpdate = z.object({ title: title.optional(), description: description.optional(),
  text: z.string().max(200_000).optional(), enabled: z.boolean().optional(), syncIntervalMinutes: interval,
  clearCredential: z.boolean().optional(), ...auth }).strict();
export const fileUpload = z.object({ title, description: description.optional(), fileName: z.string().min(1).max(240),
  mimeType: z.string().max(150), data: z.string().max(11_184_812) }).strict();
export const sourceList = z.object({ offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50), kind: z.enum(dataLibraryKinds).optional(),
  format: z.enum(dataLibraryFormats).optional(), query: z.string().trim().max(200).optional(), q: z.string().trim().max(200).optional() }).strict();
export const searchRequest = z.object({ query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(10).default(6), sourceIds: z.array(sourceId).max(30).optional() }).strict();
