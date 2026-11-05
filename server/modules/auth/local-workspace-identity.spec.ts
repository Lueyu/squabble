import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { AuthGlobalGuard } from '../../common/platform/auth.guard';
import { AuthController } from './auth.controller';
import { LocalWorkspaceService } from './local-workspace.service';

test('local guard uses stable workspace identity instead of missing or stale JWTs', async () => {
  const prior = process.env.AUTH_MODE;
  process.env.AUTH_MODE = 'local';
  try {
    const identity = { userId: 'workspace-id', username: 'workspace' };
    const guard = new AuthGlobalGuard({ getAllAndOverride: () => true } as never,
      { select: () => assert.fail('Local requests must not read a JWT account') } as never,
      { identity: async () => identity } as LocalWorkspaceService);
    for (const headers of [{}, { authorization: 'Bearer stale-token' }]) {
      const req = { headers, userContext: undefined };
      assert.equal(await guard.canActivate({ getHandler() {}, getClass() {}, switchToHttp: () => ({ getRequest: () => req }) } as never), true);
      assert.deepEqual(req.userContext, identity);
    }
  } finally { if (prior === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = prior; }
});

test('local mode disables account mutations while leaving the mode endpoint available', async () => {
  const prior = process.env.AUTH_MODE;
  process.env.AUTH_MODE = 'local';
  try {
    const controller = new AuthController(new Proxy({}, { get: () => () => assert.fail('Account service must not run') }) as never,
      { consume: () => assert.fail('Account limiter must not run') } as never);
    assert.deepEqual(controller.mode(), { mode: 'local' });
    for (const action of ['register', 'login', 'refresh', 'recover', 'recoveryCode'] as const) {
      await assert.rejects(controller[action]({} as never, {}), /Account sign-in is disabled/);
    }
  } finally { if (prior === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = prior; }
});

const url = process.env.AUTH_TEST_DATABASE_URL;
test('workspace setup is stable, preserves existing users, and requires explicit selection with multiple users', { skip: !url }, async () => {
  const schema = `local_workspace_test_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url!, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create schema "${schema}"`);
  const client = postgres(url!, { max: 4, connection: { search_path: schema }, onnotice: () => {} });
  const priorMode = process.env.AUTH_MODE;
  const priorOwner = process.env.LOCAL_WORKSPACE_USER_ID;
  process.env.AUTH_MODE = 'local';
  delete process.env.LOCAL_WORKSPACE_USER_ID;
  try {
    await client.unsafe(`create table users (
      id uuid primary key default gen_random_uuid(), username varchar(32) not null unique,
      password_hash text not null, recovery_code_hash text, session_version integer not null default 0,
      display_name varchar(64), email_notify varchar(255), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    )`);
    const db = drizzle(client);
    const first = new LocalWorkspaceService(db);
    const results = await Promise.all([first.identity(), new LocalWorkspaceService(db).identity()]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].username, 'local-workspace');
    const original = await client`select * from users`;
    assert.equal(original.length, 1);
    assert.equal(original[0].recovery_code_hash, null);
    assert.match(original[0].password_hash, /^local-disabled:/);
    assert.deepEqual(await new LocalWorkspaceService(db).identity(), results[0]);
    await client`update users set username='existing-owner', password_hash='existing-hash'`;
    assert.equal((await new LocalWorkspaceService(db).identity()).username, 'existing-owner');
    const selected = randomUUID();
    await client`insert into users (id,username,password_hash) values (${selected}, 'second-owner', 'second-hash')`;
    await assert.rejects(new LocalWorkspaceService(db).identity(), /LOCAL_WORKSPACE_USER_ID/);
    process.env.LOCAL_WORKSPACE_USER_ID = selected;
    assert.deepEqual(await new LocalWorkspaceService(db).identity(), { userId: selected, username: 'second-owner' });
    assert.equal((await client`select password_hash from users where id=${original[0].id}`)[0].password_hash, 'existing-hash');
    assert.equal((await client`select count(*)::integer as count from users`)[0].count, 2);
    process.env.LOCAL_WORKSPACE_USER_ID = randomUUID();
    await assert.rejects(new LocalWorkspaceService(db).identity(), /not found/);
    process.env.LOCAL_WORKSPACE_USER_ID = 'not-a-uuid';
    await assert.rejects(new LocalWorkspaceService(db).identity(), /UUID/);
  } finally {
    if (priorMode === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = priorMode;
    if (priorOwner === undefined) delete process.env.LOCAL_WORKSPACE_USER_ID; else process.env.LOCAL_WORKSPACE_USER_ID = priorOwner;
    await client.end();
    await admin.unsafe(`drop schema "${schema}" cascade`);
    await admin.end();
  }
});
