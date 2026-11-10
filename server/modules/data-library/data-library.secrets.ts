import { BadRequestException } from '@nestjs/common';
import { encryptSecret, decryptSecret } from '../settings/settings-security';
import type { DataLibraryAuthKind } from '../../../shared/data-library.interface';
export function dataSecretKey(): string {
  const key = process.env.SETTINGS_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!key || key.length < 16 || key === 'change-me-in-production-0123456789abcdef') throw new BadRequestException('PRIVATE_ENCRYPTION_KEY_REQUIRED');
  return key;
}
export function encodeDataSecret(value: string): string { return encryptSecret(value, dataSecretKey()); }
export function decodeDataSecret(value: string | null): string | null {
  if (!value) return null;
  try { return decryptSecret(value, dataSecretKey()); } catch { return null; }
}
export function authHeaders(kind: DataLibraryAuthKind, value: string | null): Record<string, string> {
  if (kind === 'none') return {};
  if (!value) throw new BadRequestException('CREDENTIAL_UNREADABLE');
  if (/[\r\n\u0000]/u.test(value)) throw new BadRequestException('INVALID_CREDENTIAL');
  if (kind === 'cookie') return { Cookie: value };
  if (kind === 'bearer') return { Authorization: `Bearer ${value}` };
  return { Authorization: `Basic ${Buffer.from(value).toString('base64')}` };
}
