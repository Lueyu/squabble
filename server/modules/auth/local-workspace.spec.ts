import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authMode, validateLocalWorkspaceConfig, localWorkspaceRequestGuard } from './local-workspace';

test('local mode is explicit and refuses public listeners and proxy trust', () => {
  assert.equal(authMode({}), 'account');
  assert.equal(authMode({ AUTH_MODE: 'account' }), 'account');
  assert.equal(authMode({ AUTH_MODE: 'local' }), 'local');
  assert.throws(() => authMode({ AUTH_MODE: 'disabled' }), /AUTH_MODE/);
  for (const host of [undefined, '0.0.0.0', '::', '192.168.1.1', 'my-computer']) {
    assert.throws(() => validateLocalWorkspaceConfig({ AUTH_MODE: 'local', SERVER_HOST: host }), /loopback/);
  }
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    assert.doesNotThrow(() => validateLocalWorkspaceConfig({ AUTH_MODE: 'local', SERVER_HOST: host }));
  }
  assert.throws(() => validateLocalWorkspaceConfig({ AUTH_MODE: 'local', SERVER_HOST: '127.0.0.1', TRUST_PROXY: 'true' }), /TRUST_PROXY/);
  assert.doesNotThrow(() => validateLocalWorkspaceConfig({ AUTH_MODE: 'account', SERVER_HOST: '0.0.0.0' }));
});

test('local request boundary permits configured frontend and rejects foreign origins, hosts and addresses', () => {
  const guard = localWorkspaceRequestGuard({ AUTH_MODE: 'local', SERVER_HOST: '127.0.0.1', SERVER_PORT: '3002',
    LOCAL_APP_ORIGINS: 'http://localhost:8080,http://127.0.0.1:8080' });
  function allowed(headers: Record<string, string>, remoteAddress = '127.0.0.1') {
    let passed = false;
    const response = { statusCode: 200, end() {} };
    guard({ headers, socket: { remoteAddress } } as never, response as never, () => { passed = true; });
    assert.equal(response.statusCode, passed ? 200 : 403);
    return passed;
  }
  assert.equal(allowed({ host: '127.0.0.1:3002' }), true);
  assert.equal(allowed({ host: 'localhost:3002', origin: 'http://localhost:3002', 'sec-fetch-site': 'same-origin' }, '::1'), true);
  assert.equal(allowed({ host: '127.0.0.1:3002', origin: 'http://localhost:8080', 'sec-fetch-site': 'same-origin' }, '::ffff:127.0.0.1'), true);
  for (const headers of [
    { host: 'attacker.test:3002' }, { host: '127.0.0.1:3003' },
    { host: '127.0.0.1:3002', origin: 'https://attacker.test' },
    { host: '127.0.0.1:3002', origin: 'null' },
    { host: '127.0.0.1:3002', origin: 'http://localhost:9000' },
    { host: '127.0.0.1:3002', 'sec-fetch-site': 'cross-site' },
    { host: '127.0.0.1:3002', 'sec-fetch-site': 'same-site' },
  ]) assert.equal(allowed(headers), false);
  assert.equal(allowed({ host: '127.0.0.1:3002' }, '192.168.1.5'), false);
  assert.equal(allowed({ host: '127.0.0.1:3002', 'x-forwarded-for': '127.0.0.1' }, '192.168.1.5'), false);
});

test('local app origins must be literal loopback origins without paths or credentials', () => {
  for (const origin of ['http://evil.test', 'http://localhost.evil.test', 'http://localhost:8080/path',
    'http://user@localhost:8080', 'null', 'http://0.0.0.0:8080']) {
    assert.throws(() => validateLocalWorkspaceConfig({ AUTH_MODE: 'local', SERVER_HOST: '127.0.0.1', LOCAL_APP_ORIGINS: origin }), /LOCAL_APP_ORIGINS/);
  }
});
