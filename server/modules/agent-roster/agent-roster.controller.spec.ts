import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { NEED_LOGIN_KEY } from '../../common/platform/need-login.decorator';
import type { Request } from 'express';

test('every roster endpoint requires login and mutations reject conflicting request key headers', async () => {
  assert.ok(existsSync('server/modules/agent-roster/agent-roster.controller.ts'), 'owned roster HTTP endpoints must exist');
  const { AgentRosterController } = await import('./agent-roster.controller');
  assert.equal(Reflect.getMetadata(NEED_LOGIN_KEY, AgentRosterController), true);
  const calls: unknown[][] = [];
  const controller = new AgentRosterController({ create: (...args: unknown[]) => { calls.push(args); return { ok: true }; } } as never);
  const req = { userContext: { userId: 'authenticated-owner' }, get: (key: string) => key === 'x-request-key' ? 'header-key' : undefined } as Request;
  assert.throws(() => controller.create(req, { requestKey: 'different-key' }));
  assert.deepEqual(controller.create(req, { requestKey: 'header-key' }), { ok: true });
  assert.deepEqual(calls, [['authenticated-owner', { requestKey: 'header-key' }]]);
});
