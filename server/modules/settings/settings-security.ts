/**
 * Settings security（设置模块安全原语）。
 *
 * 职责边界：两件事——①集成密钥的对称加解密（AES-256-GCM，密文格式
 * 'v1:iv:tag:ciphertext'）；②用户自填 LLM API base URL 的公网校验与
 * 归一化（防 SSRF：只允许解析到公网 IP 的 HTTPS 主机，且不落盘任何
 * 私网地址）。只提供纯函数与 Agent 工厂，不持有状态。
 *
 * 上下游：import node:crypto / node:dns / node:https / node:net；被
 * settings.service.ts（加解密 apiKey、校验 baseUrl）与
 * settings.controller.ts 使用；本文件无外部依赖。
 *
 * 关键约定：主密钥取 SETTINGS_ENCRYPTION_KEY 或 JWT_SECRET（<16 字符
 * fail-fast）；密钥派生为 sha256('squabble-integration-secrets-v1\0' +
 * masterSecret)——带域分隔前缀，避免与其他用途的密钥派生撞车；DNS
 * 解析在每个连接时刻独立校验（lookupAll），防止"校验时公网、连接时
 * 被解析到内网"的 TOCTOU 缝隙。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { Agent as HttpsAgent } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

/** 从主密钥派生 AES-256 密钥（域分隔前缀 + sha256）。 */
function deriveKey(masterSecret: string): Buffer {
  // 短密钥直接拒绝（与 JWT_SECRET 共用时的最低强度底线）。
  if (masterSecret.length < 16) {
    throw new Error('SETTINGS_ENCRYPTION_KEY or JWT_SECRET must be at least 16 characters');
  }
  return createHash('sha256')
    .update('squabble-integration-secrets-v1\0')
    .update(masterSecret)
    .digest();
}

/** AES-256-GCM 密文自带随机 nonce 与完整性标签。 */
export function encryptSecret(plaintext: string, masterSecret: string): string {
  // 每次加密用全新 12 字节随机 IV。
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(masterSecret), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  // 密文格式：v1:iv:tag:ciphertext（各段 base64url）。
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

/** 解密 v1 格式密文；版本/段数不符或 GCM 校验失败都会抛错。 */
export function decryptSecret(stored: string, masterSecret: string): string {
  // 严格四段结构，多余段（extra）视为非法，拒绝任何格式漂移。
  const [version, ivPart, tagPart, encryptedPart, extra] = stored.split(':');
  if (version !== 'v1' || !ivPart || !tagPart || !encryptedPart || extra) {
    throw new Error('Invalid encrypted integration credential');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(masterSecret),
    Buffer.from(ivPart, 'base64url'),
  );
  // setAuthTag 后 final() 会在标签不匹配时抛错（密文被篡改/密钥不符）。
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** IPv4 是否公网：逐一排除保留段（0/10/127/组播≥224、CGNAT、链路本地、私网段、文档段）。 */
function isPublicIpv4(address: string): boolean {
  const [first, second, third] = address.split('.').map(Number);
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false; // 100.64/10 CGNAT
  if (first === 169 && second === 254) return false; // 链路本地
  if (first === 172 && second >= 16 && second <= 31) return false; // 私网
  if (first === 192 && (second === 0 || second === 168)) return false; // 192.0.0/24 与 192.168/16
  if (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100)))
    return false; // 198.18/15 基准测试 + 198.51.100/24 文档段
  if (first === 203 && second === 0 && third === 113) return false; // 203.0.113/24 文档段
  return true;
}

/** IPv4/IPv6 是否公网；IPv6 覆盖未指定/回环/ULA/链路本地/文档段/IPv4 映射。 */
function isPublicIp(address: string): boolean {
  if (isIP(address) === 4) return isPublicIpv4(address);
  if (isIP(address) !== 6) return false;
  const normalized = address.toLowerCase();
  // IPv4 映射形式（::ffff:x.x.x.x）：按嵌入的 IPv4 判定。
  if (normalized.includes('.')) {
    const embedded = normalized.slice(normalized.lastIndexOf(':') + 1);
    if (isIP(embedded) === 4) return isPublicIpv4(embedded);
  }
  return !(
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') || // fc00::/7 ULA
    normalized.startsWith('fd') ||
    /^fe[89ab]/u.test(normalized) || // fe80::/10 链路本地
    normalized.startsWith('2001:db8:') || // 文档段
    normalized.startsWith('::ffff:')
  );
}

/** 连接时刻校验每条 DNS 答案，然后把 socket 钉到该校验过的地址上。 */
export function makePublicLookup(
  resolveAll: (hostname: string) => Promise<LookupAddress[]> = (hostname) =>
    lookup(hostname, { all: true }),
): LookupFunction {
  return (hostname, options, callback) => {
    void resolveAll(hostname)
      .then((addresses) => {
        // 任一解析结果非公网（或为空）都拒绝——不允许 DNS 重绑到内网。
        if (addresses.length === 0 || addresses.some((item) => !isPublicIp(item.address))) {
          callback(new Error('API base URL must use a public HTTPS host'), '');
          return;
        }
        // 按请求的地址族过滤（family 未指定时全部候选都可用）。
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
        // all 语义返回完整列表；否则返回首个地址+族。
        if (options.all) callback(null, eligible);
        else callback(null, eligible[0].address, eligible[0].family);
      })
      .catch(() => callback(new Error('Could not resolve a public API host'), ''));
  };
}

/** 带"只连公网地址"lookup 的 HTTPS Agent（供上游 LLM 调用使用）。 */
export function publicHttpsAgent(): HttpsAgent {
  return new HttpsAgent({ lookup: makePublicLookup() });
}

/** 在持久化或调用用户 URL 之前，拒绝本地/内网端点并归一化 URL。 */
export async function normalizePublicLlmBaseUrl(
  input: string,
  resolveAll: (hostname: string) => Promise<LookupAddress[]> = (hostname) =>
    lookup(hostname, { all: true }),
): Promise<string> {
  // 第一步：长度与 URL 形态校验。
  if (typeof input !== 'string' || input.length > 500) {
    throw new Error('Enter a valid HTTPS API base URL');
  }
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Enter a valid HTTPS API base URL');
  }
  // 第二步：协议与结构——仅 HTTPS、不带内嵌凭据、不带查询串/锚点。
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('API base URL must use HTTPS without credentials or query parameters');
  }
  // 第三步：主机名形态——非空、含点（拒绝裸主机名）、拒绝 localhost 族后缀。
  const hostname = url.hostname.toLowerCase().replace(/[.]$/u, '');
  if (
    !hostname ||
    !hostname.includes('.') ||
    /[.]((localhost)|(local)|(internal)|(test)|(invalid)|(example))$/u.test(hostname)
  ) {
    throw new Error('API base URL must use a public HTTPS host');
  }
  // 第四步：DNS 实校验——字面 IP 直接判公网，域名则要求全部解析结果公网。
  const addresses = isIP(hostname) ? [{ address: hostname }] : await resolveAll(hostname);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new Error('API base URL must use a public HTTPS host');
  }
  // 第五步：路径归一化——去尾斜杠；拒绝把 /chat/completions 本身填进
  // base URL（该后缀由调用方拼接）。
  const pathname = url.pathname.replace(/\/+$/u, '');
  if (pathname.endsWith('/chat/completions')) {
    throw new Error('Enter the API base URL before /chat/completions');
  }
  return `${url.origin}${pathname}`;
}
