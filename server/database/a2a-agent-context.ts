import { ConflictException, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { a2aAgentConnections } from './a2a-agents.schema';
import type { TeamDatabase } from './team-context';
import type { A2aConnectionFingerprint } from '../../shared/a2a-agents.interface';

/** Neutral, owner-scoped authority shared by roster, Council and team publication. */
export async function readA2aConnectionFingerprint(tx: TeamDatabase, owner: string, id: string): Promise<A2aConnectionFingerprint> {
  const [row] = await tx.select().from(a2aAgentConnections).where(and(eq(a2aAgentConnections.owner, owner), eq(a2aAgentConnections.id, id))).for('share');
  if (!row) throw new NotFoundException('A2A_CONNECTION_NOT_FOUND');
  if (row.status !== 'enabled') throw new ConflictException('A2A_CONNECTION_DISABLED');
  return { connectionId: row.id, connectionRevision: row.revision, cardHash: row.cardHash, protocolVersion: '1.0', interfaceUrl: row.interfaceUrl,
    ...(row.tenant ? { tenant: row.tenant } : {}) };
}
export async function assertA2aConnectionFingerprint(tx: TeamDatabase, owner: string, fingerprint: A2aConnectionFingerprint): Promise<void> {
  const current = await readA2aConnectionFingerprint(tx, owner, fingerprint.connectionId);
  if (current.connectionId !== fingerprint.connectionId || current.connectionRevision !== fingerprint.connectionRevision
    || current.cardHash !== fingerprint.cardHash || current.protocolVersion !== fingerprint.protocolVersion
    || current.interfaceUrl !== fingerprint.interfaceUrl || current.tenant !== fingerprint.tenant) throw new ConflictException('A2A_CONNECTION_CHANGED');
}
