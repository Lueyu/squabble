import { sql } from 'drizzle-orm';
import { councilReports } from './council.schema';

/** Exact original archive identity: deleting a manual sibling revision does not revoke this source. */
export function councilReportSourceVisible() {
  return sql`EXISTS (SELECT 1 FROM council_sessions live_session WHERE live_session.owner = ${councilReports.owner}
    AND live_session.id = ${councilReports.sessionId} AND live_session.deleted_at IS NULL) AND NOT EXISTS (SELECT 1 FROM research_document_versions deleted_version
    WHERE deleted_version.owner = ${councilReports.owner} AND deleted_version.deleted_at IS NOT NULL
      AND (deleted_version.id = ${councilReports.researchVersionId}
        OR (deleted_version.change_reason IS NULL AND deleted_version.source->>'type' = 'council'
          AND deleted_version.source->>'id' = ${councilReports.id}::text)))`;
}
