import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeRecoveryService } from './runtime-recovery.service';

test('status projects only public durable facts and never resumes work', async () => {
  let recoveries = 0;
  const recovery = new RuntimeRecoveryService({
    read: async () => ({ id: 'run', state: 'provider_unknown', cursor: 4,
      frozenInput: { holdings: 'private' }, frozenInputEnc: 'encrypted-private', leaseToken: 'private-token',
      steps: [{ id: 'step', stepIndex: 0, state: 'dispatched', model: 'fixture', requestEnc: 'private-request',
        responseEnc: null, providerRequestId: null, usage: null }] }),
    recover: async () => { recoveries += 1; return 'provider_unknown'; },
    cancel: async () => {}, settleUnknown: async () => {},
  });
  const status = await recovery.status('owner', 'run');
  assert.equal(recoveries, 0); assert.equal(status.state, 'provider_unknown');
  assert.doesNotMatch(JSON.stringify(status), /private|leaseToken|requestEnc|frozenInput/);
});

test('recovery and unknown settlement only update durable state without invoking a model', async () => {
  const calls: string[] = [];
  const recovery = new RuntimeRecoveryService({
    read: async () => ({ id: 'run', state: 'settled_unknown', cursor: 5, steps: [] }),
    recover: async () => { calls.push('recover'); return 'provider_unknown'; },
    cancel: async () => { calls.push('cancel'); }, settleUnknown: async () => { calls.push('settle'); },
  });
  assert.equal(await recovery.recover('owner', 'run'), 'provider_unknown');
  await recovery.cancel('owner', 'run'); await recovery.closeUnknown('owner', 'run');
  assert.deepEqual(calls, ['recover', 'cancel', 'settle']);
});

test('zero usage placeholders are unknown while measured totals preserve extra reasoning tokens', async () => {
  const recovery = new RuntimeRecoveryService({ read: async () => ({ id: 'run', state: 'accepted', cursor: 1,
    steps: [{ id: 'zero', stepIndex: 0, state: 'parsed', model: 'fixture', responseEnc: 'saved',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
    { id: 'measured', stepIndex: 1, state: 'parsed', model: 'fixture', responseEnc: 'saved',
      usage: { inputTokens: 100, outputTokens: 100, totalTokens: 1000 } }] }),
  recover: async () => 'accepted', cancel: async () => {}, settleUnknown: async () => {} });
  const status = await recovery.status('owner', 'run');
  assert.equal(status.steps[0].usageKnown, false);
  assert.equal(status.steps[1].usageKnown, true);
});
