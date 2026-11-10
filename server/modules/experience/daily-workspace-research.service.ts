import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { and, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '../../common/platform';
import { holdings, cashAccounts } from '../../database/schema';
import { councilReports, councilSessions } from '../../database/council.schema';
import { researchDocumentVersions, researchDocuments } from '../../database/research-documents.schema';
import { SimpleCouncilService } from '../council/simple-council.service';
import { DailyWorkspaceService } from './daily-workspace.service';
import { dailyDate } from './daily-workspace.rules';
import { readableResearchSections } from '../../../shared/research-reading';
import type { OverallDailyEvidence, OverallDailyResearchView } from '../../../shared/daily-workspace.interface';

const requestSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), requestKey: z.string().trim().min(1).max(160) }).strict();
export const OVERALL_DAILY_QUESTION = '生成总体投资日报：基于冻结的个人账本、可追溯历史持仓输入和所有独立模拟账户当日结果，先独立分析，再反向核查，再封存总结。逐个账户解释实际成交、费用、未执行原因、失败与缺口；说明这些变化对个人持仓的意义、分歧和下一步观察。个人与模拟资金分开，不同起点不排名。缺失事实保持未知，不授权交易。';

/** Explicit generation only. GET never refreshes sources or starts/restarts an executor. */
@Injectable()
export class DailyWorkspaceResearchService {
  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly daily: DailyWorkspaceService, private readonly research: SimpleCouncilService) {}

  async start(owner: string, input: unknown): Promise<OverallDailyResearchView> {
    if (!owner?.trim()) throw new UnauthorizedException();
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('INVALID_OVERALL_DAILY_REQUEST');
    const date = dailyDate(parsed.data.date);
    if (date > dailyDate()) throw new BadRequestException('FUTURE_DAILY_RESEARCH_UNAVAILABLE');
    // create() resolves this supplier only after checking its durable owner/request receipt.
    await this.research.create(owner, { context: { kind: 'portfolio', date }, message: OVERALL_DAILY_QUESTION,
      requestKey: `overall-daily:${parsed.data.requestKey}` }, { researchOnly: true,
      overallDaily: { date, capture: () => this.capture(owner, date) } });
    return this.read(owner, date);
  }

  async capture(owner: string, date: string): Promise<OverallDailyEvidence> {
    const { reports: _reports, ...facts } = await this.daily.read(owner, date);
    const now = new Date();
    const personalHistory = await this.db.transaction(async tx => {
      const rows = await tx.select({ version: researchDocumentVersions }).from(researchDocumentVersions)
        .innerJoin(researchDocuments, and(eq(researchDocuments.id, researchDocumentVersions.reportId), eq(researchDocuments.owner, owner)))
        .where(and(eq(researchDocumentVersions.owner, owner), eq(researchDocuments.topicKey, 'portfolio'), isNull(researchDocumentVersions.deletedAt), isNull(researchDocumentVersions.revokedAt),
          lte(researchDocumentVersions.createdAt, now), or(isNull(researchDocumentVersions.availableAt), lte(researchDocumentVersions.availableAt, now)),
          sql`${researchDocumentVersions.snapshot} IS NOT NULL AND ${researchDocumentVersions.snapshot}->'overallDaily' IS NULL`,
          sql`${researchDocumentVersions.snapshot}->>'businessDate' <= ${date}`))
        .orderBy(desc(researchDocumentVersions.createdAt), desc(researchDocumentVersions.id)).limit(5);
      const currentStoredPortfolio = date === dailyDate(undefined, now) ? {
        capturedAt: now.toISOString(),
        holdings: await tx.select().from(holdings).where(eq(holdings.owner, owner)),
        cash: await tx.select().from(cashAccounts).where(eq(cashAccounts.owner, owner)),
      } : null;
      return { scope: 'latest_five_saved_portfolio_inputs' as const,
        sources: rows.map(({ version }) => ({ versionId: version.id, businessDate: String(version.snapshot!.businessDate),
          capturedAt: version.dataAsOf?.toISOString() ?? (typeof version.snapshot!.capturedAt === 'string' ? version.snapshot!.capturedAt : null), snapshot: version.snapshot! })),
        currentStoredPortfolio, gaps: [
          'History covers at most the latest five available saved portfolio inputs on or before the report day, not a complete position history. Archived opinions are not observed facts.',
          ...(rows.length ? [] : ['No saved historical portfolio input is available. Historical holdings cannot be inferred from current holdings.']),
          ...(currentStoredPortfolio ? ['Current stored holdings/cash are read-time records, not verified closing positions or fresh prices.'] : ['Current holdings are excluded from this historical report.']),
        ] };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    return { schemaVersion: 1, facts, personalHistory };
  }

  async read(owner: string, input?: string): Promise<OverallDailyResearchView> {
    if (!owner?.trim()) throw new UnauthorizedException();
    const date = dailyDate(input), now = new Date();
    const [latest] = await this.db.select().from(councilSessions).where(and(isNull(councilSessions.deletedAt), eq(councilSessions.owner, owner),
      sql`${councilSessions.checkpoint}->'simple'->'overallDaily'->>'date'=${date}`)).orderBy(desc(councilSessions.createdAt), desc(councilSessions.id)).limit(1);
    const rows = await this.db.select({ version: researchDocumentVersions, session: councilSessions }).from(councilReports)
      .innerJoin(councilSessions, and(isNull(councilSessions.deletedAt), eq(councilSessions.owner, owner), eq(councilSessions.id, councilReports.sessionId)))
      .innerJoin(researchDocumentVersions, and(eq(researchDocumentVersions.owner, owner), eq(researchDocumentVersions.id, councilReports.researchVersionId)))
      .where(and(eq(councilReports.owner, owner), eq(councilReports.publicationOutcome, 'succeeded'), isNull(researchDocumentVersions.deletedAt), isNull(researchDocumentVersions.revokedAt),
        lte(researchDocumentVersions.createdAt, now), or(isNull(researchDocumentVersions.availableAt), lte(researchDocumentVersions.availableAt, now)),
        sql`${researchDocumentVersions.snapshot}->'overallDaily'->>'date'=${date}`))
      .orderBy(desc(councilReports.createdAt), desc(councilReports.id));
    const marker = latest?.checkpoint?.simple?.overallDaily;
    return { date, timezone: 'Asia/Shanghai', latest: latest && marker ? { sessionId: latest.id, status: latest.status,
      stage: latest.checkpoint?.simple?.stage ?? 'waiting', error: latest.error, readAt: marker.readAt, factsHash: marker.factsHash } : null,
      reports: rows.map(({ version, session }) => ({ versionId: version.id, sessionId: session.id, title: version.title,
        createdAt: version.createdAt.toISOString(), readAt: String((version.snapshot!.overallDaily as { readAt: string }).readAt),
        factsHash: String((version.snapshot!.overallDaily as { factsHash: string }).factsHash), content: readableResearchSections(version.sections) })) };
  }
}
