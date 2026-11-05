import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform/database.provider';
import { users } from '../../database/schema';
import { isLocalWorkspaceMode } from './local-workspace';

interface WorkspaceIdentity { userId: string; username: string }

/** A stable internal owner preserves existing data without presenting accounts. */
@Injectable()
export class LocalWorkspaceService implements OnModuleInit {
  private current?: Promise<WorkspaceIdentity>;

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async onModuleInit(): Promise<void> {
    if (isLocalWorkspaceMode()) await this.identity();
  }

  identity(): Promise<WorkspaceIdentity> {
    this.current ??= this.resolveIdentity().catch(error => { this.current = undefined; throw error; });
    return this.current;
  }

  private async resolveIdentity(): Promise<WorkspaceIdentity> {
    const selected = process.env.LOCAL_WORKSPACE_USER_ID?.trim();
    const fields = { userId: users.id, username: users.username };
    if (selected) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(selected)) {
        throw new Error('LOCAL_WORKSPACE_USER_ID must be an existing user UUID');
      }
      const [existing] = await this.db.select(fields).from(users).where(eq(users.id, selected));
      if (!existing) throw new Error('LOCAL_WORKSPACE_USER_ID was not found; existing data was not changed');
      return existing;
    }
    return this.db.transaction(async tx => {
      // Serialize empty-install initialization, including concurrent application starts.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('squabble-first-user-registration'))`);
      const existing = await tx.select(fields).from(users).limit(2);
      if (existing.length > 1) {
        throw new Error('Multiple existing workspaces: set LOCAL_WORKSPACE_USER_ID to choose data; no accounts were changed');
      }
      if (existing.length === 1) return existing[0];
      const [created] = await tx.insert(users).values({ username: 'local-workspace', displayName: 'Local workspace',
        passwordHash: `local-disabled:${randomBytes(32).toString('hex')}` }).returning(fields);
      return created;
    });
  }
}
