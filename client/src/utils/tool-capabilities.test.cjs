const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');

function capability(packId, extra = {}) {
  return { packId, manifestHash: 'reviewed', manifestVersion: '1', revision: 0, installation: 'ready',
    catalog: 'verified', grant: 'disabled', dataClasses: ['public'], ready: false, checkedAt: null, reasonCode: null, ...extra };
}

test('recommended grants retain the displayed manifest and never include unselected network or application data', () => {
  const { load } = fixture();
  const { recommendedGrants } = load('features/tool-connections/tool-capability-state.ts');
  const views = ['documents', 'market_data', 'browser', 'compute'].map(id => capability(id));
  const local = recommendedGrants(views, { publicNetwork: false, privateLocal: true });
  assert.deepEqual(Array.from(local, item => item.packId), ['documents', 'compute']);
  assert.deepEqual(Array.from(local[0].dataClasses), ['public', 'private_material', 'portfolio']);
  assert.equal(local[0].manifestHash, 'reviewed');
  const network = recommendedGrants(views, { publicNetwork: true, privateLocal: false });
  assert.equal(network.length, 3);
  assert.ok(network.every(item => item.packId !== 'documents'));
  assert.ok(network.every(item => item.dataClasses.join(',') === 'public'));
});

test('recommendations skip unavailable components and preserve explicit review requirements', () => {
  const { load } = fixture();
  const { recommendedGrants } = load('features/tool-connections/tool-capability-state.ts');
  const result = recommendedGrants([capability('compute', { installation: 'unavailable' }),
    capability('documents', { grant: 'review_required' }), capability('browser', { grant: 'enabled', ready: true })], { publicNetwork: true, privateLocal: true });
  assert.equal(result.length, 0);
});

test('capability cards show deployment processing and honest states without contacting tools', () => {
  const { state, load, render } = fixture();
  state.queries.set('tool-capabilities', { data: [capability('documents'), capability('compute', { installation: 'unavailable', reasonCode: 'SANDBOX_UNAVAILABLE' })] });
  const html = render(load('features/tool-connections/ToolCapabilitiesPanel.tsx').ToolCapabilitiesPanel);
  assert.match(html, /Tools and capabilities/);
  assert.match(html, /deployment server/);
  assert.match(html, /Needs permission/);
  assert.match(html, /Unavailable/);
  assert.doesNotMatch(html, /HTTPS MCP endpoint|Input schema/);
  assert.equal(state.requests.length, 0);
});

test('reading capabilities is GET only, refresh and grants are explicit POST requests', async () => {
  const { state, load } = fixture();
  const api = load('api/tool-capabilities.ts');
  await api.listToolCapabilities();
  await api.refreshToolCapabilities();
  await api.activateToolCapabilities({ grants: [], publicNetwork: false });
  await api.revokeToolCapability('compute', 2);
  assert.deepEqual(state.requests.map(item => item.method), ['get', 'post', 'post', 'post']);
  assert.equal(state.requests[0].args[0], '/api/tool-capabilities');
  assert.equal(state.requests[3].args[0], '/api/tool-capabilities/compute/revoke');
});

test('saving a custom tool automatically discovers metadata once and never grants or invokes a tool', async () => {
  const { state, load } = fixture();
  state.responses = new Map([['/api/tool-connections', { id: 'custom', status: 'configured', revision: 1 }],
    ['/api/tool-connections/custom/discover', { connection: { id: 'custom', revision: 2 }, catalog: { id: 'candidate' } }]]);
  const result = await load('api/tool-connections.ts').saveToolConnectionWithDiscovery({ provider: 'mcp', endpoint: 'https://example.org/mcp' });
  assert.equal(result.catalog.id, 'candidate');
  assert.deepEqual(state.requests.map(item => item.args[0]), ['/api/tool-connections', '/api/tool-connections/custom/discover']);
});

test('an OAuth connection is saved before authorization without a premature discovery request', async () => {
  const { state, load } = fixture();
  state.responses = new Map([['/api/tool-connections', { id: 'oauth', status: 'authorization_required' }]]);
  const result = await load('api/tool-connections.ts').saveToolConnectionWithDiscovery({ provider: 'mcp', endpoint: 'https://example.org/mcp' });
  assert.equal(result.connection.id, 'oauth');
  assert.equal(result.catalog, null);
  assert.equal(state.requests.length, 1);
});
