import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request } from 'express';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { AuthRateLimiter } from './auth-rate-limiter';

function controllerForTest(onRegister: () => void): AuthController {
  const service = {
    register: async () => { onRegister(); return { accessToken: 'created' }; },
  } as AuthService;
  const limiter = { consume: () => undefined } as AuthRateLimiter;
  return new AuthController(service, limiter);
}

function requestForTest(headers: Record<string, string>): Request {
  return { headers } as unknown as Request;
}

test('first-user registration rejects a cross-site browser form before account creation', async () => {
  const previous = process.env.REGISTER_ENABLED;
  process.env.REGISTER_ENABLED = 'first-user';
  let created = false;
  try {
    const controller = controllerForTest(() => { created = true; });
    const request = requestForTest({
      host: '127.0.0.1:3000',
      origin: 'https://attacker.example',
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'cross-site',
    });
    await assert.rejects(() => controller.register(request, {
      username: 'attacker', password: 'attacker-password-123',
    }));
    assert.equal(created, false);
  } finally {
    if (previous === undefined) delete process.env.REGISTER_ENABLED;
    else process.env.REGISTER_ENABLED = previous;
  }
});

test('first-user registration accepts same-origin JSON requests', async () => {
  const previous = process.env.REGISTER_ENABLED;
  process.env.REGISTER_ENABLED = 'first-user';
  let created = false;
  try {
    const controller = controllerForTest(() => { created = true; });
    const request = requestForTest({
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    });
    await controller.register(request, { username: 'owner', password: 'owner-password-123' });
    assert.equal(created, true);
  } finally {
    if (previous === undefined) delete process.env.REGISTER_ENABLED;
    else process.env.REGISTER_ENABLED = previous;
  }
});

test('open desktop registration still rejects cross-site requests', async () => {
  const previousMode = process.env.REGISTER_ENABLED;
  const previousOrigin = process.env.SQUABBLE_DESKTOP_ORIGIN;
  process.env.REGISTER_ENABLED = 'true';
  process.env.SQUABBLE_DESKTOP_ORIGIN = 'http://127.0.0.1:3000';
  let created = false;
  try {
    const controller = controllerForTest(() => { created = true; });
    await assert.rejects(() => controller.register(requestForTest({
      host: '127.0.0.1:3000',
      origin: 'https://attacker.example',
      'content-type': 'application/json',
      'sec-fetch-site': 'cross-site',
    }), { username: 'attacker', password: 'attacker-password-123' }));
    assert.equal(created, false);
  } finally {
    if (previousMode === undefined) delete process.env.REGISTER_ENABLED;
    else process.env.REGISTER_ENABLED = previousMode;
    if (previousOrigin === undefined) delete process.env.SQUABBLE_DESKTOP_ORIGIN;
    else process.env.SQUABBLE_DESKTOP_ORIGIN = previousOrigin;
  }
});

for (const [name, headers] of [
  ['foreign Origin on a JSON request', {
    host: 'localhost:3000', origin: 'https://attacker.example',
    'content-type': 'application/json', 'sec-fetch-site': 'same-origin',
  }],
  ['DNS-rebound Host on a JSON request', {
    host: 'attacker.example:3000', origin: 'http://attacker.example:3000',
    'content-type': 'application/json', 'sec-fetch-site': 'same-origin',
  }],
  ['cross-site fetch metadata on a JSON request', {
    host: 'localhost:3000', origin: 'http://localhost:3000',
    'content-type': 'application/json', 'sec-fetch-site': 'cross-site',
  }],
] as const) {
  test(`first-user registration rejects ${name}`, async () => {
    const previous = process.env.REGISTER_ENABLED;
    process.env.REGISTER_ENABLED = 'first-user';
    let created = false;
    try {
      const controller = controllerForTest(() => { created = true; });
      await assert.rejects(() => controller.register(requestForTest(headers), {
        username: 'attacker', password: 'attacker-password-123',
      }));
      assert.equal(created, false);
    } finally {
      if (previous === undefined) delete process.env.REGISTER_ENABLED;
      else process.env.REGISTER_ENABLED = previous;
    }
  });
}
