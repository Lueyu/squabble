import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_NATIVE_IMAGE_BYTES, type NativeAgentImage } from '../../shared/native-image.interface';
import type { LocalAgentProvider } from '../../shared/local-agents.interface';
import type { ResearchInvocation } from './research';

export function nativeImageCapability(provider: LocalAgentProvider): boolean {
  return provider === 'codex' || provider === 'opencode';
}

export function validateNativeImage(image: unknown): NativeAgentImage {
  const invalid = (): never => { throw new Error('NATIVE_AGENT_INVALID_IMAGE'); };
  if (!image || typeof image !== 'object' || Array.isArray(image)) return invalid();
  const value = image as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== 'mimeType' && key !== 'data')
    || !['image/png', 'image/jpeg', 'image/webp'].includes(String(value.mimeType)) || typeof value.data !== 'string'
    || !value.data.length || value.data.length > 4 * Math.ceil(MAX_NATIVE_IMAGE_BYTES / 3)
    || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.data)) return invalid();
  const bytes = Buffer.from(value.data, 'base64');
  if (bytes.length > MAX_NATIVE_IMAGE_BYTES || bytes.toString('base64') !== value.data) return invalid();
  const matches = value.mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : value.mimeType === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!matches) return invalid();
  return { mimeType: value.mimeType as NativeAgentImage['mimeType'], data: value.data };
}

/** Only the owned workspace gets attachment bytes; prompts, argv and diagnostics never do. */
export async function attachNativeImage(provider: LocalAgentProvider, invocation: ResearchInvocation,
  image: NativeAgentImage, cwd: string): Promise<ResearchInvocation> {
  const suffix = image.mimeType === 'image/png' ? 'png' : image.mimeType === 'image/jpeg' ? 'jpg' : 'webp';
  const path = join(cwd, `attachment.${suffix}`);
  await writeFile(path, Buffer.from(image.data, 'base64'), { mode: 0o600, flag: 'wx' });
  if (provider === 'codex') {
    const args = invocation.args.filter(arg => arg !== '--search');
    args.splice(args.length - 1, 0, '--image', path, '-c', 'web_search="disabled"');
    return { ...invocation, args };
  }
  const permissions = { '*': 'deny' };
  const config = { permission: permissions, agent: { 'squabble-research': {
    description: 'Extract attached screenshot', mode: 'primary', prompt: 'Extract only the attached image. Do not use tools.', permission: permissions,
  } } };
  return { ...invocation, args: [...invocation.args, '--file', path], env: { ...invocation.env,
    OPENCODE_PERMISSION: JSON.stringify(permissions), OPENCODE_CONFIG_CONTENT: JSON.stringify(config) } };
}
