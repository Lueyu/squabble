import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserMcpAdapter, PLAYWRIGHT_MCP_PACKAGE_VERSION } from './browser-mcp.adapter';
import { BrowserbaseAdapter } from './browserbase.adapter';

const binding = { owner: 'fixture-owner', runId: 'fixture-run', leaseToken: 'fixture-lease', runRevision: 'fixture-revision' };
const authority = { assert: async () => {} };
test('cloud backends stay unverified with no credentials or navigation proof and never dispatch', async () => {
  let calls = 0;
  const base = new BrowserbaseAdapter({ apiKey: 'fixture-only', projectId: 'fixture-project' }, { authority,
    transport: async () => { calls++; throw new Error('must not dispatch'); } });
  assert.equal(base.availability().available, false);
  await assert.rejects(base.createSession(binding, 'fixture-dispatch'), /EGRESS_UNVERIFIED/u);
  assert.equal(calls, 0);
  const mcp = new BrowserMcpAdapter(authority);
  assert.equal(mcp.availability().available, false);
  await assert.rejects(mcp.open(binding), /UNVERIFIED/u);
  assert.equal(PLAYWRIGHT_MCP_PACKAGE_VERSION, '0.0.85');
});

test('Browserbase lifecycle uses fixed official API methods and durable owner-bound dispatch receipts', async () => {
  const requests: Array<{ method: string; url: string; body?: unknown }> = [];
  const rows = new Map<string, { owner: string; runId: string; bindingHash: string; state: 'pending' | 'created' | 'unknown' | 'released'; remoteId?: string }>();
  const receipts = {
    reserve: async (key: string, owner: string, runId: string, bindingHash: string) => {
      const prior = rows.get(key); if (prior) return { fresh: false, ...prior };
      const row = { owner, runId, bindingHash, state: 'pending' as const }; rows.set(key, row); return { fresh: true, ...row };
    },
    update: async (key: string, state: 'created' | 'unknown' | 'released', remoteId?: string) => {
      const row = rows.get(key)!; rows.set(key, { ...row, state, remoteId: remoteId ?? row.remoteId });
    },
    read: async (key: string) => rows.get(key) ?? null,
  };
  const verification = { deploymentId: 'fixture-deployment', policyVersion: 'squabble-public-pinned-v1' as const,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), evidenceArtifactId: 'fixture-evidence',
    controls: { navigation: true, redirects: true, subresources: true, downloads: true, dnsPinning: true, privateNetwork: true } };
  const base = new BrowserbaseAdapter({ apiKey: 'fixture-only', projectId: 'fixture-project', deploymentId: 'fixture-deployment', riskPolicyId: 'fixture-policy', verification }, { authority, receipts,
    transport: async (url, init) => {
      requests.push({ url, method: init.method!, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ id: 'fake-remote-session', status: init.method === 'POST' && url.endsWith('/fake-remote-session') ? 'COMPLETED' : 'RUNNING' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const created = await base.createSession(binding, 'fixture-dispatch');
  assert.equal(created.remoteId, 'fake-remote-session');
  await assert.rejects(base.createSession(binding, 'fixture-dispatch'), /ALREADY_DISPATCHED/u);
  await assert.rejects(base.status({ ...binding, owner: 'other' }, 'fixture-dispatch'), /NOT_FOUND/u);
  await assert.rejects(base.release({ ...binding, leaseToken: 'other-lease' }, 'fixture-dispatch'), /NOT_FOUND/u);
  await base.status(binding, 'fixture-dispatch'); await base.release(binding, 'fixture-dispatch');
  assert.deepEqual(requests.map(row => [row.method, row.url]), [
    ['POST', 'https://api.browserbase.com/v1/sessions'], ['GET', 'https://api.browserbase.com/v1/sessions/fake-remote-session'],
    ['POST', 'https://api.browserbase.com/v1/sessions/fake-remote-session'],
  ]);
  assert.equal((requests[0].body as Record<string, unknown>).keepAlive, false);
  assert.deepEqual(requests[2].body, { projectId: 'fixture-project', status: 'REQUEST_RELEASE' });
  assert.doesNotMatch(JSON.stringify(requests), /storageState|cookies|contextId/u);
});

test('Browserbase uncertain create is retained as unknown and cannot dispatch again', async () => {
  let calls = 0;
  let row: import('./browserbase.adapter').BrowserbaseReceipt | null = null;
  const proof = { deploymentId: 'fictional-deployment', policyVersion: 'squabble-public-pinned-v1' as const,
    evidenceArtifactId: 'fictional-contract-evidence', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    controls: { navigation: true, redirects: true, subresources: true, downloads: true, dnsPinning: true, privateNetwork: true } };
  // Synthetic attestation exercises only API lifecycle behavior; it does not verify remote navigation.
  const adapter = new BrowserbaseAdapter({ apiKey: 'fictional-key', projectId: 'fictional-project', deploymentId: proof.deploymentId,
    riskPolicyId: 'fictional-policy', verification: proof }, { authority,
    receipts: {
      reserve: async (_key, owner, runId, bindingHash) => {
        if (row) return { ...row, fresh: false };
        row = { owner, runId, bindingHash, state: 'pending' }; return { ...row, fresh: true };
      },
      read: async () => row,
      update: async (_key, state, remoteId) => { row = { ...row!, state, remoteId }; },
    },
    transport: async () => { calls++; throw new Error('fictional connection lost after request'); },
  });
  await assert.rejects(adapter.createSession(binding, 'fictional-receipt'), /PROVIDER_UNKNOWN/u);
  assert.equal(row?.state, 'unknown');
  await assert.rejects(adapter.createSession(binding, 'fictional-receipt'), /ALREADY_DISPATCHED/u);
  assert.equal(calls, 1);
  proof.controls.privateNetwork = false;
  assert.equal(adapter.availability().available, false);
  await assert.rejects(adapter.createSession(binding, 'other-receipt'), /EGRESS_UNVERIFIED/u);
  assert.equal(calls, 1);
});
