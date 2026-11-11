import { createHash } from 'node:crypto';
import type { AgentToolDescriptor } from '@shared/agent-tooling.interface';
import type { RuntimeApprovalPreview, RuntimeFrozenInputSnapshot } from '@shared/research-runtime.interface';

export function descriptor(): AgentToolDescriptor {
  return { id: 'quotes', connectionId: null, catalogVersionId: 'catalog-1', schemaHash: 'a'.repeat(64),
    name: 'quotes', description: 'Read test quotes', inputSchema: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] },
    effect: 'read', dataClasses: ['public'], timeoutMs: 1_000, maxOutputBytes: 4_096,
    supportsCancellation: false, supportsStatusLookup: false, remoteIdempotency: 'unknown' };
}

export function preview(): RuntimeApprovalPreview {
  return { id: 'preview-1', runId: 'run-1', stepId: 'step-1', invocationId: 'inv-1', state: 'waiting_approval',
    revision: 1, payloadHash: 'old-hash', payload: { accountId: 'test-account', target: 'test-note', body: 'Draft',
      attachmentHashes: [], catalogVersionId: 'catalog-1', connectionRevision: 1, sourceVersionIds: ['v1'],
      feeCeiling: { amount: '1.00', currency: 'USD' } }, expiresAt: 900_000,
    approval: { payloadHash: 'old-hash', revision: 1, approvedAt: 0 } };
}

export function frozenInput(): RuntimeFrozenInputSnapshot {
  // This object deliberately uses canonical key order for an independent hash oracle.
  const payload = { cash: [{ accountId: 'paper-a', amount: '50.00', currency: 'USD' }],
    holdings: [{ accountId: 'paper-a', instrumentId: 'TEST', quantity: '100' }],
    sourcePayloads: [{ datasetVersionId: 'v1', facts: { close: '10.00' } }] };
  return { version: 1, datasetVersionIds: ['v1'], datasets: [{ datasetVersionId: 'v1', contentHash: 'b'.repeat(64) }],
    payload, payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
}
