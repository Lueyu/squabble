const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');

test('telemetry filters preserve deep-link context, reset pagination and ignore invalid values', () => {
  const { load } = fixture();
  const { telemetryFilters, updateTelemetryParams, telemetryRunPath } = load('features/telemetry/telemetry-state.ts');
  const params = new URLSearchParams('view=runs&status=failed&offset=24&limit=12&search=abc');
  assert.equal(telemetryFilters(params).offset, 24);
  const next = updateTelemetryParams(params, { agentId: 'member/1' });
  assert.equal(next.get('view'), 'runs');
  assert.equal(next.get('offset'), null);
  assert.equal(next.get('status'), 'failed');
  assert.match(telemetryRunPath('research:one/two', params), /^\/telemetry\/runs\/research%3Aone%2Ftwo\?/);
  const invalid = telemetryFilters(new URLSearchParams('offset=-10&limit=999&status=garbage&from=not-a-date'));
  assert.equal(invalid.offset, 0);
  assert.equal(invalid.limit, 12);
  assert.equal(invalid.status, undefined);
  assert.equal(invalid.from, undefined);
});

test('trace links accept only safe configured project URLs and encode trace identities', () => {
  const { load } = fixture();
  const { langfuseLink } = load('features/telemetry/telemetry-state.ts');
  const integration = { status: 'ready', enabled: true, configured: true, projectUrl: 'https://trace.example/project/alpha', baseUrl: 'https://trace.example', captureContent: false };
  assert.equal(langfuseLink(integration, 'trace/a'), 'https://trace.example/project/alpha/traces/trace%2Fa');
  for (const projectUrl of ['javascript:alert(1)', '//evil.example', 'https://user:secret@trace.example/project/a']) {
    assert.equal(langfuseLink({ ...integration, projectUrl }), null);
  }
  assert.equal(langfuseLink({ ...integration, status: 'disabled' }), null);
});

test('timeline uses real starts and durations; unknown durations never become measured zero', () => {
  const { load } = fixture();
  const { spanGeometry, formatDuration, formatAmount } = load('features/telemetry/telemetry-state.ts');
  const run = { startedAt: '2026-11-11T08:00:00Z', durationMs: 20000 };
  assert.deepEqual({ ...spanGeometry(run, { startedAt: '2026-11-11T08:00:05Z', durationMs: 10000 }) }, { left: 25, width: 50, known: true });
  assert.equal(spanGeometry(run, { startedAt: run.startedAt, durationMs: null }).known, false);
  assert.equal(formatDuration(null), '—');
  assert.equal(formatAmount(null), '—');
  assert.equal(formatAmount(0), '0');
});

test('UTC trend date keys never shift to the previous local day', () => {
  const { load } = fixture();
  const { formatTrendDate } = load('features/telemetry/telemetry-state.ts');
  assert.equal(formatTrendDate('2026-11-11', 'en-US'), '11/11');
  assert.equal(formatTrendDate('not-a-date', 'en-US'), '—');
});

test('telemetry HTTP actions use encoded owner-scoped run URLs and explicit feedback', async () => {
  const { state, load } = fixture();
  const api = load('api/telemetry.ts');
  await api.fetchTelemetryWorkspace({ status: 'failed', offset: 12, limit: 12 });
  await api.fetchTelemetryRun('research:a/b');
  await api.saveTelemetryFeedback('research:a/b', { rating: 'negative', comment: 'Source date missing' });
  assert.equal(state.requests[0].args[0], '/api/telemetry/workspace');
  assert.equal(state.requests[0].args[1].params.offset, 12);
  assert.equal(state.requests[1].args[0], '/api/telemetry/runs/research%3Aa%2Fb');
  assert.equal(state.requests[2].method, 'put');
  assert.equal(state.requests[2].args[0], '/api/telemetry/runs/research%3Aa%2Fb/feedback');
  assert.equal(state.requests[2].args[1].rating, 'negative');
});
