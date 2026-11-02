import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthService } from './auth.service';
import { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken } from './jwt';
import http, { tokenStore } from '../../../client/src/api/http';
import bcrypt from 'bcryptjs';

process.env.JWT_SECRET = 'isolated-audit-test-secret-not-real-credentials';
process.env.REGISTER_ENABLED = 'true';

function fakeDatabase() {
  let row: Record<string, unknown> | null = null;
  return {
    select: () => ({ from: () => ({ where: async () => row ? [row] : [] }) }),
    insert: () => ({ values: (values: Record<string, unknown>) => ({ returning: async () => {
      row = { id: 'audit-user', sessionVersion: 0, ...values };
      return [row];
    } }) }),
  };
}

test('legacy bcrypt passwords remain usable', async () => {
  const password = 'legacy-secret';
  const row = { id: 'legacy-user', username: 'legacy', passwordHash: await bcrypt.hash(password, 10), sessionVersion: 0 };
  const db = { select: () => ({ from: () => ({ where: async () => [row] }) }) };
  const auth = new AuthService(db as never);
  const result = await auth.login({ username: 'legacy', password });
  assert.equal(result.user.id, row.id);
});

test('73 ASCII character passwords distinguish the final character', async () => {
  const auth = new AuthService(fakeDatabase() as never);
  const original = 'a'.repeat(72) + 'X';
  const changed = 'a'.repeat(72) + 'Y';
  assert.notEqual(original, changed);
  await auth.register({ username: 'audit-ascii', password: original });
  await assert.rejects(() => auth.login({ username: 'audit-ascii', password: changed }));
  const result = await auth.login({ username: 'audit-ascii', password: original });
  assert.equal(result.user.username, 'audit-ascii');
});

test('75-byte Chinese passwords distinguish the final character', async () => {
  const auth = new AuthService(fakeDatabase() as never);
  const original = '密'.repeat(24) + '甲';
  const changed = '密'.repeat(24) + '乙';
  assert.equal(original.length, 25);
  assert.equal(Buffer.byteLength(original), 75);
  await auth.register({ username: 'audit-unicode', password: original });
  await assert.rejects(() => auth.login({ username: 'audit-unicode', password: changed }));
  const result = await auth.login({ username: 'audit-unicode', password: original });
  assert.equal(result.user.username, 'audit-unicode');
});

test('expired access token refreshes and retries a protected request', async () => {
  const storage = new Map<string, string>();
  const redirects: string[] = [];
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    window: { location: { pathname: '/settings', assign: (path: string) => redirects.push(path) } },
  });
  process.env.ACCESS_TOKEN_TTL = '-1s';
  const user = { id: 'audit-user', username: 'audit', sessionVersion: 0 };
  const access = signAccessToken(user);
  const refresh = signRefreshToken(user);
  assert.equal(verifyAccessToken(access), null);
  assert.notEqual(verifyRefreshToken(refresh), null);
  tokenStore.save(access, refresh);
  const calls: string[] = [];
  http.defaults.adapter = async (config) => {
    calls.push(config.url ?? '');
    if (config.url === '/api/auth/refresh') {
      return { data: { accessToken: 'new-access', refreshToken: 'new-refresh' }, status: 200, statusText: 'OK', headers: {}, config };
    }
    if (config.headers.Authorization === `Bearer ${access}`) throw { response: { status: 401 }, config };
    return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
  };
  const response = await http.get('/api/settings/integrations');
  assert.deepEqual(response.data, { ok: true });
  assert.deepEqual(calls, ['/api/settings/integrations', '/api/auth/refresh', '/api/settings/integrations']);
  assert.equal(tokenStore.getAccessToken(), 'new-access');
  assert.equal(tokenStore.getRefreshToken(), 'new-refresh');
  assert.deepEqual(redirects, []);
});
