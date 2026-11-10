const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./simple-test-loader.cjs');

test('notification and gateway settings can render outside the legacy trading terminal with readable failures', () => {
  const filename = path.resolve(__dirname, '../features/integrations/PaperIntegrationPanels.tsx');
  assert.ok(fs.existsSync(filename), 'integration controls need an independent settings entrypoint');
  const f = fixture();
  f.state.queries.set('notifications', { isError: true, refetch() {} });
  f.state.queries.set('mcp', { isError: true, refetch() {} });
  const { NotificationChannelsCard, AgentSessionsCard } = f.load(filename);
  assert.match(f.render(NotificationChannelsCard), /role="alert"/);
  assert.match(f.render(AgentSessionsCard), /role="alert"/);
  assert.doesNotMatch(f.render(AgentSessionsCard), /paper\.placeOrder/);
});

test('an unnamed notification channel never exposes its provider secret as its display label', () => {
  const f = fixture();
  f.state.queries.set('notifications', { data: [{ id: 'fictional', channelType: 'bark', label: null, enabled: true,
    config: { key: 'secret-must-not-be-a-label' } }] });
  const { NotificationChannelsCard } = f.load('features/integrations/PaperIntegrationPanels.tsx');
  assert.doesNotMatch(f.render(NotificationChannelsCard), /secret-must-not-be-a-label/);
});

test('the one-time MCP token receipt renders only a mask and an explicit copy control', () => {
  const f = fixture();
  const { AgentSessionToken } = f.load('features/integrations/PaperIntegrationPanels.tsx');
  const markup = f.render(AgentSessionToken, { token: 'secret-token-not-visible-1234', baseUrl: 'http://localhost:4000', onClose() {} });
  assert.doesNotMatch(markup, /secret-token-not-visible/);
  assert.match(markup, /1234/);
  assert.match(markup, /Copy token/);
});
