import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { toolConnections, toolOAuthStates } from '../../database/tool-connections.schema';
import { decryptSecret, encryptSecret } from '../settings/settings-security';
import { ToolTransportPolicy } from './tool-transport-policy';
import { toolEncryptionKey } from './tool-connections.service';

function stateHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function callbackUrl(): string {
  const raw = process.env.TOOL_OAUTH_CALLBACK_URL;
  if (!raw) throw new BadRequestException('TOOL_OAUTH_CALLBACK_UNCONFIGURED');
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.pathname !== '/settings/tools') throw new BadRequestException('TOOL_OAUTH_CALLBACK_RESTRICTED');
  return url.href;
}

@Injectable()
export class ToolOAuthService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly policy: ToolTransportPolicy) {}

  async begin(owner: string, connectionId: string): Promise<{ authorizationUrl: string; expiresAt: string }> {
    if (!owner?.trim() || !z.string().uuid().safeParse(connectionId).success) throw new NotFoundException('TOOL_CONNECTION_NOT_FOUND');
    const [connection] = await this.db.select().from(toolConnections).where(and(eq(toolConnections.owner, owner), eq(toolConnections.id, connectionId)));
    if (!connection?.oauthConfig) throw new BadRequestException('TOOL_OAUTH_UNCONFIGURED');
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + 5 * 60_000), redirectUri = callbackUrl();
    await this.policy.normalizeEndpoint(connection.oauthConfig.authorizationUrl);
    await this.policy.normalizeEndpoint(connection.oauthConfig.tokenUrl);
    await this.db.insert(toolOAuthStates).values({ id: randomUUID(), owner, connectionId, connectionRevision: connection.revision,
      stateHash: stateHash(state), verifierEnc: encryptSecret(verifier, toolEncryptionKey()), expiresAt });
    const url = new URL(connection.oauthConfig.authorizationUrl);
    url.search = new URLSearchParams({ response_type: 'code', client_id: connection.oauthConfig.clientId, redirect_uri: redirectUri,
      state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      ...(connection.oauthConfig.scopes.length ? { scope: connection.oauthConfig.scopes.join(' ') } : {}) }).toString();
    return { authorizationUrl: url.href, expiresAt: expiresAt.toISOString() };
  }

  async complete(owner: string, value: unknown): Promise<{ connectionId: string; authorized: true }> {
    const parsed = z.object({ state: z.string().min(40).max(100), code: z.string().min(1).max(4000) }).strict().safeParse(value);
    if (!owner?.trim() || !parsed.success) throw new BadRequestException('TOOL_OAUTH_STATE_INVALID');
    const redirectUri = callbackUrl();
    // Consume before any token exchange: retries, concurrent callbacks and replay cannot reuse a code.
    const [state] = await this.db.update(toolOAuthStates).set({ consumedAt: new Date() }).where(and(eq(toolOAuthStates.owner, owner),
      eq(toolOAuthStates.stateHash, stateHash(parsed.data.state)), isNull(toolOAuthStates.consumedAt), gt(toolOAuthStates.expiresAt, new Date()))).returning();
    if (!state) throw new BadRequestException('TOOL_OAUTH_STATE_INVALID');
    const [connection] = await this.db.select().from(toolConnections).where(and(eq(toolConnections.owner, owner), eq(toolConnections.id, state.connectionId)));
    if (!connection?.oauthConfig || connection.revision !== state.connectionRevision) throw new ConflictException('TOOL_CONNECTION_REVISION_CHANGED');
    const config = connection.oauthConfig;
    let token: string;
    try {
      const response = await this.policy.fetch(config.tokenUrl, { method: 'POST', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code',
          code: parsed.data.code, redirect_uri: redirectUri, client_id: config.clientId,
          code_verifier: decryptSecret(state.verifierEnc, toolEncryptionKey()) }).toString() }, config.tokenUrl, 64_000);
      if (!response.ok) throw new Error('TOKEN_EXCHANGE_FAILED');
      const result: unknown = await response.json();
      const parsedToken = z.object({ access_token: z.string().min(1).max(16_000), token_type: z.string() }).passthrough().safeParse(result);
      if (!parsedToken.success || parsedToken.data.token_type.toLowerCase() !== 'bearer') throw new Error('TOKEN_EXCHANGE_FAILED');
      token = parsedToken.data.access_token;
    } catch { throw new BadRequestException('TOOL_OAUTH_TOKEN_EXCHANGE_FAILED'); }
    const [saved] = await this.db.update(toolConnections).set({ secretEnc: encryptSecret(token, toolEncryptionKey()), revision: connection.revision + 1,
      status: 'configured', allowedToolIds: [], catalogVersionId: null, verifiedAt: null, updatedAt: new Date() })
      .where(and(eq(toolConnections.owner, owner), eq(toolConnections.id, connection.id), eq(toolConnections.revision, state.connectionRevision))).returning();
    if (!saved) throw new ConflictException('TOOL_CONNECTION_REVISION_CHANGED');
    return { connectionId: saved.id, authorized: true };
  }
}
