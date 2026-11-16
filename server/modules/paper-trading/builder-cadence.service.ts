/**
 * builder-cadence.service.ts — agent builder 的扫描租约与评审节流服务。
 *
 * 职责边界：
 *  - 管两类并发/频控原语：builderScanLeases（同一 owner 同时只允许一个扫描）与
 *    builderReviewChecks（同一 (owner, profile, ticker) 每个交易日最多一次候选评审）。
 *  - 不做信号计算、不写订单；频控判定规则实现在 trading-cadence.ts 的 reviewDue。
 * 上下游：
 *  - 上游（谁调用本服务）：AgentBuilderService / BotScheduler 相关扫描链路。
 *  - 下游（本文件调用谁）：Drizzle 数据库（builder-cadence.schema 两张表）、
 *    trading-cadence 的 marketDate / reviewDue。
 * 关键约定：
 *  - 扫描租约 20 分钟过期，靠 onConflictDoUpdate + setWhere（仅当旧租约已到期）原子抢占。
 *  - 评审抢占必须在任何付费动作（LLM 调用等）之前完成：失败、拒绝的提案也要留下评审记录。
 *  - 评审锁用 pg_advisory_xact_lock，键为 builder-review:<owner>:<profileId>。
 */
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

  /**
   * claimScan — 为 owner 抢占一个扫描租约。
   *
   * 通过 upsert + setWhere（旧租约已过期才允许覆盖）实现原子抢占：
   * 已有未过期租约时返回 null，表示该 owner 当前不允许扫描。
   *
   * @param owner 账户所有者用户 id。
   * @returns 租约令牌（UUID）；抢占失败返回 null。
   */
  async claimScan(owner: string): Promise<string | null> {
    // 生成新令牌并设置 20 分钟过期时间。
    const token = randomUUID();
    const expiresAt = sql`now() + interval '20 minutes'`;
    // 仅当既有租约已过期时才覆盖（setWhere 保证并发下只有一个赢家）。
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

  /**
   * releaseScan — 释放当前 owner 的扫描租约（令牌必须匹配才删除）。
   *
   * @param owner 账户所有者用户 id。
   * @param token claimScan 返回的租约令牌。
   */
  async releaseScan(owner: string, token: string): Promise<void> {
    await this.db
      .delete(builderScanLeases)
      .where(and(eq(builderScanLeases.owner, owner), eq(builderScanLeases.token, token)));
  }

  /**
   * claimReview — 为一次候选评审抢占名额（在任何付费动作之前调用）。
   *
   * 事务内先取 advisory 锁串行化同一 (owner, profile) 的并发评审，再按节流规则判定：
   * 同一本地交易日已有评审 → 不通过；距上次评审未满配置的交易日间隔且输入未变化 → 不通过。
   * 通过则写入/覆盖一条 decision='pending' 的评审记录（失败与被拒的提案同样会占位）。
   *
   * @param owner     账户所有者用户 id。
   * @param profile   目标 agent 配置档案（取 id/version/cadence.reviewEveryTradingDays）。
   * @param ticker    标的代码。
   * @param market    所属市场（决定交易日历时区）。
   * @param inputHash 本次评审输入的哈希（用于输入变化检测）。
   * @returns 抢占成功返回 true；被节流（或当日已评审）返回 false。
   */
  async claimReview(
    owner: string,
    profile: BuilderProfile,
    ticker: string,
    market: Market,
    inputHash: string,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // 事务级 advisory 锁：同一 (owner, profile) 的评审串行化，避免并发双占。
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`builder-review:${owner}:${profile.id}`}))`,
      );
      // 读取该 (owner, profile, ticker) 的最近一次评审记录。
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
      // 以市场本地日期比较"今天"与上次评审日。
      const now = new Date();
      const today = marketDate(market, now);
      const lastDate = previous ? marketDate(market, previous.reviewedAt) : null;
      // 变更合并为每个本地交易日至多一次自动候选评审。
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
      // 抢占成功：写入 pending 评审记录（upsert 覆盖旧记录）。
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

  /**
   * finishReview — 回写评审结论（成功、失败、拒绝都要调用）。
   *
   * @param owner     账户所有者用户 id。
   * @param profileId agent 配置档案 id。
   * @param ticker    标的代码。
   * @param decision  评审结论（写回 builderReviewChecks.decision）。
   * @param reason    结论说明，截断到 1000 字符。
   */
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
