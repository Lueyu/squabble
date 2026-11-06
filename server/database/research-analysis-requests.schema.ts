import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { PortfolioReportSnapshot } from '../../shared/portfolio-report.interface';

/** The request and the confirmed holdings commit share one transaction. */
export const researchAnalysisRequests=pgTable('research_analysis_requests',{
  id:uuid('id').primaryKey().defaultRandom(),owner:text('owner').notNull(),receiptId:text('receipt_id').notNull(),
  snapshot:jsonb('snapshot').$type<PortfolioReportSnapshot>().notNull(),dateKey:text('date_key').notNull(),
  state:text('state').notNull().default('queued'),error:text('error'),taskId:uuid('task_id'),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[uniqueIndex('research_analysis_request_receipt').on(t.owner,t.receiptId)]);
