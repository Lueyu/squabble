import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { builderScanLeases, builderReviewChecks } from '../../database/builder-cadence.schema';
import { marketDate, reviewDue } from './trading-cadence';
import type { BuilderProfile, Market } from '../../../shared/api.interface';

@Injectable()
export class BuilderCadenceService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async claimScan(owner: string): Promise<string | null> {
    const token = randomUUID();
    const expiresAt = sql`now() + interval '20 minutes'`;
    const [lease] = await this.db
      .insert(builderScanLeases)
      .values({ owner, token, expiresAt })
      .onConflictDoUpdate({
        target: builderScanLeases.owner,
        set: { token, expiresAt },
        setWhere: sql`${builderScanLeases.expiresAt} <= now()`,
      })
      .returning();
    return lease?.token ?? null;
  }

  async releaseScan(owner: string, token: string): Promise<void> {
    await this.db
      .delete(builderScanLeases)
      .where(and(eq(builderScanLeases.owner, owner), eq(builderScanLeases.token, token)));
  }

  /** Persist a review before any paid work, including failures and declined ideas. */
  async claimReview(
    owner: string,
    profile: BuilderProfile,
    ticker: string,
    market: Market,
    inputHash: string,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`builder-review:${owner}:${profile.id}`}))`,
      );
      const [previous] = await tx
        .select()
        .from(builderReviewChecks)
        .where(
          and(
            eq(builderReviewChecks.owner, owner),
            eq(builderReviewChecks.profileId, profile.id),
            eq(builderReviewChecks.ticker, ticker),
          ),
        );
      const now = new Date();
      const today = marketDate(market, now);
      const lastDate = previous ? marketDate(market, previous.reviewedAt) : null;
      // Changes are coalesced to one automatic candidate review per local day.
      if (lastDate === today) return false;
      if (
        !reviewDue(
          previous?.inputHash ?? null,
          inputHash,
          lastDate,
          today,
          profile.config.cadence?.reviewEveryTradingDays ?? 5,
        )
      )
        return false;
      await tx
        .insert(builderReviewChecks)
        .values({
          owner,
          profileId: profile.id,
          profileVersion: profile.version,
          ticker,
          inputHash,
          reviewedAt: now,
          decision: 'pending',
          reason: 'Review reserved',
        })
        .onConflictDoUpdate({
          target: [
            builderReviewChecks.owner,
            builderReviewChecks.profileId,
            builderReviewChecks.ticker,
          ],
          set: {
            profileVersion: profile.version,
            inputHash,
            reviewedAt: now,
            decision: 'pending',
            reason: 'Review reserved',
          },
        });
      return true;
    });
  }

  async finishReview(
    owner: string,
    profileId: string,
    ticker: string,
    decision: string,
    reason: string,
  ): Promise<void> {
    await this.db
      .update(builderReviewChecks)
      .set({ decision, reason: reason.slice(0, 1000) })
      .where(
        and(
          eq(builderReviewChecks.owner, owner),
          eq(builderReviewChecks.profileId, profileId),
          eq(builderReviewChecks.ticker, ticker),
        ),
      );
  }
}
