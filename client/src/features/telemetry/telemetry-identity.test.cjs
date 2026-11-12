const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('../../utils/simple-test-loader.cjs');

test('persistent person, version, team and trajectory filters survive trace navigation and reach the read API', async () => {
  const { load, state } = fixture();
  const { telemetryFilters, telemetryRunPath, updateTelemetryParams } = load('features/telemetry/telemetry-state.ts');
  const dimensions = { rosterAgentId: 'friend-1', rosterAgentVersionId: 'version-1', memberId: 'seat-1', teamId: 'team-1',
    teamVersionId: 'team-version-1', commissionId: 'commission-1', workKey: 'valuation', attemptId: 'attempt-1' };
  const params = new URLSearchParams({ ...dimensions, offset: '24' });
  const filters = telemetryFilters(params);
  for (const [key, value] of Object.entries(dimensions)) assert.equal(filters[key], value);
  const next = updateTelemetryParams(params, { rosterAgentVersionId: 'version-2' });
  assert.equal(next.get('offset'), null);
  assert.equal(next.get('teamId'), dimensions.teamId);
  assert.ok(telemetryRunPath('research:one', next).includes('rosterAgentVersionId=version-2'));
  await load('api/telemetry.ts').fetchTelemetryWorkspace(filters);
  assert.equal(state.requests[0].method, 'get');
  for (const [key, value] of Object.entries(dimensions)) assert.equal(state.requests[0].args[1].params[key], value);
});
