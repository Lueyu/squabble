const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./simple-test-loader.cjs');
const { TEAM_ERROR_CODES } = fixture().load('../../shared/team-workspace.interface.ts');

test('team HTTP codes produce actionable bilingual guidance instead of machine codes', () => {
  const { friendlyError } = fixture().load('utils/error-message.ts');
  for (const code of TEAM_ERROR_CODES) {
    const error = { isAxiosError: true, response: { data: { error: { code, message: code } } } };
    const zh = friendlyError(error, true, { zh: '未完成', en: 'Incomplete' });
    const en = friendlyError(error, false, { zh: '未完成', en: 'Incomplete' });
    assert.doesNotMatch(zh, /TEAM_/);
    assert.doesNotMatch(en, /TEAM_/);
    assert.match(zh, /[\u4e00-\u9fff]/);
    assert.notEqual(zh, en);
  }
});

test('team guidance follows stable code even when server includes a diagnostic message', () => {
  const { friendlyError } = fixture().load('utils/error-message.ts');
  const error = { isAxiosError: true, response: { data: { error: {
    code: 'TEAM_REVISION_CONFLICT', message: 'Draft changed', actualRevision: 7 } } } };
  assert.match(friendlyError(error, true, { zh: '未完成', en: 'Incomplete' }), /修订|版本/);
  assert.match(friendlyError({ isAxiosError: true, response: { data: { error: { message: 'TEAM_RESEARCH_COMMAND_REQUIRED' } } } }, false,
    { zh: '未完成', en: 'Incomplete' }), /team|commission/i);
});

test('commission source-permission errors identify the configured role and explain how to correct it', () => {
  const { friendlyError } = fixture().load('utils/error-message.ts');
  const error = { isAxiosError: true, response: { data: { error: {
    code: 'TEAM_SCOPE_REVOKED', message: 'A work recipient lacks its published source permission', roleId: 'role-b', field: 'sourceGrantIds' } } } };
  const labels = { 'role-b': '现金流复核员' };
  const zh = friendlyError(error, true, { zh: '未完成', en: 'Incomplete' }, labels);
  assert.match(zh, /现金流复核员/);
  assert.match(zh, /发布/);
  assert.match(friendlyError(error, false, { zh: '未完成', en: 'Incomplete' }, labels), /published|publish/i);
});
