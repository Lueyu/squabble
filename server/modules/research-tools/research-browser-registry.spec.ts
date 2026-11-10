import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RESEARCH_TOOLS, toolDescriptor } from './research-tools.registry';

test('the browser collection tool accepts a saved source identity and rejects arbitrary navigation and session credentials', () => {
  const tool = RESEARCH_TOOLS.find(item => item.name === 'read_browser_source');
  assert.ok(tool, 'Agents need an explicitly registered browser-source tool');
  const sourceId = '928be80d-b5f2-4d19-8fc3-3ab8aa75c486';
  assert.equal(tool.input.safeParse({ sourceId }).success, true);
  for (const extra of [{ url: 'https://unconfigured.org' }, { owner: 'another-user' },
    { storageState: '{"cookies":[]}' }, { profilePath: 'C:/private' }, { browserEndpoint: 'ws://localhost:9222' }]) {
    assert.equal(tool.input.safeParse({ sourceId, ...extra }).success, false);
  }
  assert.equal(tool.input.safeParse({ sourceId: '../../profile' }).success, false);
  assert.equal(toolDescriptor(tool).annotations.destructiveHint, false);
});
