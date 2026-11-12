import assert from 'node:assert/strict';
import type { ResearchDocumentsService } from '../research-documents/research-documents.service';

/** Docker PostgreSQL and the host may differ by milliseconds. Keep production time fences strict. */
export async function waitForSavedAvailability(availableAt: string | null): Promise<void> {
  assert.ok(availableAt && Number.isFinite(Date.parse(availableAt)), 'The saved report needs an exact availability timestamp');
  const deadline = performance.now() + 5000;
  while (Date.parse(availableAt) > Date.now() && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(Date.parse(availableAt) <= Date.now(), JSON.stringify({ availableAt, appNow: new Date().toISOString() }));
}

/** Keep fictional published versions visible before assertions, including publication inside another service. */
export function waitForFixturePublications(documents: ResearchDocumentsService): void {
  const visible = async <T extends { createdAt: string; availableAt: string | null }>(version: T): Promise<T> => {
    const timestamp = Math.max(Date.parse(version.createdAt), version.availableAt ? Date.parse(version.availableAt) : -Infinity);
    await waitForSavedAvailability(new Date(timestamp).toISOString());
    return version;
  };
  const submit = documents.submit.bind(documents);
  const importSource = documents.importSourceInTransaction.bind(documents);
  documents.submit = async (...args) => visible(await submit(...args));
  documents.importSourceInTransaction = async (...args) => visible(await importSource(...args));
}
