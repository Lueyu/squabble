const test = require('node:test');
const assert = require('node:assert/strict');

test('source export preserves custom local services and document origins', () => {
  const { mergeSourceHostSettings } = require('./source-host-settings.cjs');
  const existing = { DATABASE_URL: 'postgres://fictional', MODEL_CONNECTION: 'keep-private',
    TOOL_MCP_LOCAL_SERVICES_JSON: JSON.stringify([{ id: 'custom', endpoint: 'http://127.0.0.1:9010/mcp' }, { id: 'aktools', endpoint: 'http://127.0.0.1:8088/mcp' }]),
    DOCUMENT_ALLOWED_ORIGINS: 'http://127.0.0.1:8000,http://docling-old:5001' };
  const result = mergeSourceHostSettings(existing, { TOOL_MCP_LOCAL_SERVICES_JSON: '[{"id":"aktools","endpoint":"http://127.0.0.1:8081/mcp"}]', DOCUMENT_ALLOWED_ORIGINS: 'http://127.0.0.1:5002' });
  assert.deepEqual(JSON.parse(result.TOOL_MCP_LOCAL_SERVICES_JSON), [{ id: 'custom', endpoint: 'http://127.0.0.1:9010/mcp' }, { id: 'aktools', endpoint: 'http://127.0.0.1:8081/mcp' }]);
  assert.equal(result.DOCUMENT_ALLOWED_ORIGINS, 'http://127.0.0.1:8000,http://docling-old:5001,http://127.0.0.1:5002');
  assert.equal(existing.DATABASE_URL, 'postgres://fictional');
  assert.equal(existing.MODEL_CONNECTION, 'keep-private');
});

test('malformed or unsafe existing registry and origins fail before any export', () => {
  const { mergeSourceHostSettings } = require('./source-host-settings.cjs');
  const managed = { TOOL_MCP_LOCAL_SERVICES_JSON: '[{"id":"aktools","endpoint":"http://127.0.0.1:8081/mcp"}]', DOCUMENT_ALLOWED_ORIGINS: 'http://127.0.0.1:5002' };
  for (const value of ['not-json', '{}', '[{"id":"custom","endpoint":"file:///tmp/mcp"}]', '[{"id":"custom","endpoint":"http://user:secret@localhost:9000/mcp"}]']) {
    assert.throws(() => mergeSourceHostSettings({ TOOL_MCP_LOCAL_SERVICES_JSON: value }, managed), /EXISTING_MCP_REGISTRY_INVALID/u);
  }
  assert.throws(() => mergeSourceHostSettings({ DOCUMENT_ALLOWED_ORIGINS: 'http://localhost:8000/a' }, managed), /EXISTING_DOCUMENT_ORIGINS_INVALID/u);
});

test('existing registry values with apostrophes round-trip through source env syntax', () => {
  const { environmentValue } = require('./source-host-settings.cjs');
  const value = JSON.stringify([{ id: "o'neil", endpoint: 'http://127.0.0.1:9010/mcp' }]);
  assert.equal(require('dotenv').parse(`TOOL_MCP_LOCAL_SERVICES_JSON=${environmentValue(value)}\n`).TOOL_MCP_LOCAL_SERVICES_JSON, value);
});
