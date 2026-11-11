import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import { councilReports, councilSessions } from '../../database/council.schema';
import { researchDocumentVersions } from '../../database/research-documents.schema';
import { teamStrategyAuthority } from './team-strategy-transaction';

interface Version { id: string; parentVersionId?: string; source?: { type: 'council'; id: string }; snapshot?: Record<string, unknown> }
function fixture(versions: Version[], original: string | null = null) {
  const reportId = randomUUID(), sessionId = randomUUID(), dialect = new PgDialect();
  let queries = 0;
  const tx = { select: () => ({ from: (table: unknown) => ({ where: (condition: unknown) => {
    queries++;
    const params = dialect.sqlToQuery(condition as never).params;
    let rows: unknown[] = [];
    if (table === researchDocumentVersions) rows = versions.filter(version => params.includes(version.id));
    if (table === councilReports && original && (params.includes(original) || params.includes(reportId))) {
      rows = [{ id: reportId, sessionId, researchVersionId: original }];
    }
    if (table === councilSessions && params.includes(sessionId)) rows = [{ id: sessionId, teamCommissionId: 'fixture-commission' }];
    const result = Promise.resolve(rows);
    return Object.assign(result, { for: () => result });
  } }) }) };
  return { tx, reportId, queries: () => queries };
}
function check(f: ReturnType<typeof fixture>, id: string) {
  return teamStrategyAuthority(f.tx as never, 'fixture-owner', 'fixture-account',
    [{ snapshot: { sources: [{ kind: 'report', versionId: id }] } }] as never, []);
}

test('forked team outputs and parent/reference chains cannot become legacy strategies without exact fresh authority', async () => {
  const original = randomUUID(), fork = randomUUID(), parent = randomUUID(), nested = randomUUID();
  const f = fixture([{ id: original }, { id: fork, snapshot: { teamExecutionContext: { commissionId: 'fixture-commission' } } },
    { id: parent, parentVersionId: original }, { id: nested, snapshot: { continuationSummary: { reportReferences: [{ versionId: parent }] } } }], original);
  for (const id of [original, fork, parent, nested]) await assert.rejects(check(f, id), /TEAM_REAPPROVAL_REQUIRED/);
});

test('ordinary non-team report derivation remains available while malformed and cyclic ancestry fails closed', async () => {
  const ordinary = randomUUID(), ordinaryChild = randomUUID();
  await check(fixture([{ id: ordinary }, { id: ordinaryChild, parentVersionId: ordinary }]), ordinaryChild);
  const a = randomUUID(), b = randomUUID();
  await assert.rejects(check(fixture([{ id: a, parentVersionId: b }, { id: b, parentVersionId: a }]), a), /TEAM_REAPPROVAL_REQUIRED/);
  await assert.rejects(check(fixture([{ id: a, snapshot: { reportReferences: 'invalid' } }]), a), /TEAM_REAPPROVAL_REQUIRED/);
  const ids = Array.from({ length: 102 }, () => randomUUID());
  const deep = fixture(ids.map((id, index) => ({ id, ...(ids[index + 1] ? { parentVersionId: ids[index + 1] } : {}) })));
  await assert.rejects(check(deep, ids[0]), /TEAM_REAPPROVAL_REQUIRED/);
  assert.ok(deep.queries() < 300, 'Ancestry traversal is bounded before unbounded queries');
});
