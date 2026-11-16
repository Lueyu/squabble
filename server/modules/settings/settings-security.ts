import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { Agent as HttpsAgent } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

function deriveKey(masterSecret: string): Buffer {
  if (masterSecret.length < 16) {
    throw new Error('SETTINGS_ENCRYPTION_KEY or JWT_SECRET must be at least 16 characters');
  }
  return createHash('sha256')
    .update('squabble-integration-secrets-v1\0')
    .update(masterSecret)
    .digest();
}

/** AES-256-GCM ciphertext includes a fresh nonce and integrity tag. */
export function encryptSecret(plaintext: string, masterSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(masterSecret), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

export function decryptSecret(stored: string, masterSecret: string): string {
  const [version, ivPart, tagPart, encryptedPart, extra] = stored.split(':');
  if (version !== 'v1' || !ivPart || !tagPart || !encryptedPart || extra) {
    throw new Error('Invalid encrypted integration credential');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(masterSecret),
    Buffer.from(ivPart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function isPublicIpv4(address: string): boolean {
  const [first, second, third] = address.split('.').map(Number);
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && (second === 0 || second === 168)) return false;
  if (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100)))
    return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

function isPublicIp(address: string): boolean {
  if (isIP(address) === 4) return isPublicIpv4(address);
  if (isIP(address) !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized.includes('.')) {
    const embedded = normalized.slice(normalized.lastIndexOf(':') + 1);
    if (isIP(embedded) === 4) return isPublicIpv4(embedded);
  }
  return !(
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/u.test(normalized) ||
    normalized.startsWith('2001:db8:') ||
    normalized.startsWith('::ffff:')
  );
}

/** Validate every DNS answer at connection time, then pin the socket to it. */
export function makePublicLookup(
  resolveAll: (hostname: string) => Promise<LookupAddress[]> = (hostname) =>
    lookup(hostname, { all: true }),
): LookupFunction {
  return (hostname, options, callback) => {
    void resolveAll(hostname)
      .then((addresses) => {
        if (addresses.length === 0 || addresses.some((item) => !isPublicIp(item.address))) {
          callback(new Error('API base URL must use a public HTTPS host'), '');
          return;
        }
        const family =
          options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family;
        const eligible =
          family === 4 || family === 6
            ? addresses.filter((item) => item.family === family)
            : addresses;
        if (eligible.length === 0) {
          callback(new Error('API host has no public address for the requested family'), '');
          return;
        }
        if (options.all) callback(null, eligible);
        else callback(null, eligible[0].address, eligible[0].family);
      })
      .catch(() => callback(new Error('Could not resolve a public API host'), ''));
  };
}

export function publicHttpsAgent(): HttpsAgent {
  return new HttpsAgent({ lookup: makePublicLookup() });
}

/** Reject local/private endpoints before persisting or invoking a user URL. */
export async function normalizePublicLlmBaseUrl(
  input: string,
  resolveAll: (hostname: string) => Promise<LookupAddress[]> = (hostname) =>
    lookup(hostname, { all: true }),
): Promise<string> {
  if (typeof input !== 'string' || input.length > 500) {
    throw new Error('Enter a valid HTTPS API base URL');
  }
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Enter a valid HTTPS API base URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('API base URL must use HTTPS without credentials or query parameters');
  }
  const hostname = url.hostname.toLowerCase().replace(/[.]$/u, '');
  if (
    !hostname ||
    !hostname.includes('.') ||
    /[.]((localhost)|(local)|(internal)|(test)|(invalid)|(example))$/u.test(hostname)
  ) {
    throw new Error('API base URL must use a public HTTPS host');
  }
  const addresses = isIP(hostname) ? [{ address: hostname }] : await resolveAll(hostname);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new Error('API base URL must use a public HTTPS host');
  }
  const pathname = url.pathname.replace(/\/+$/u, '');
  if (pathname.endsWith('/chat/completions')) {
    throw new Error('Enter the API base URL before /chat/completions');
  }
  return `${url.origin}${pathname}`;
}
