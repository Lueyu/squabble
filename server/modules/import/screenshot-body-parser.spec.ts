import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { Controller, Module, Post, Req } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request } from 'express';
import { importBodyParsers } from './screenshot-body-parser';

class FixtureController {
  echo(req: Request) { return { length: req.body?.imageBase64?.length }; }
}
class FixtureModule {}
Controller('api/import')(FixtureController);
Post(['screenshot-jobs', 'ocr/extract', 'commit', 'screenshot-jobs/id'])(FixtureController.prototype, 'echo', Object.getOwnPropertyDescriptor(FixtureController.prototype, 'echo')!);
Req()(FixtureController.prototype, 'echo', 0);
Module({ controllers: [FixtureController] })(FixtureModule);

test('only screenshot POST uploads can exceed the ordinary 1MiB body limit', async () => {
  const app = await NestFactory.create<NestExpressApplication>(FixtureModule, { bodyParser: false, logger: false });
  app.use(...importBodyParsers());
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  try {
    const body = JSON.stringify({ imageBase64: 'A'.repeat(2 * 1024 * 1024) });
    for (const [path, method, expected] of [
      ['/api/import/screenshot-jobs', 'POST', 201], ['/api/import/ocr/extract', 'POST', 201],
      ['/api/import/commit', 'POST', 413], ['/api/import/screenshot-jobs/id', 'POST', 413],
      ['/api/import/screenshot-jobs', 'PUT', 413],
    ] as const) {
      const response = await fetch(origin + path, { method, body, headers: { 'content-type': 'application/json' } });
      assert.equal(response.status, expected, `${method} ${path}`);
      if (expected === 201) assert.equal((await response.json()).length, 2 * 1024 * 1024);
      else await response.text();
    }
    const small = await fetch(origin + '/api/import/screenshot-jobs', { method: 'POST', body: '{"imageBase64":"test"}', headers: { 'content-type': 'application/json' } });
    assert.equal(small.status, 201); assert.equal((await small.json()).length, 4);
  } finally { await app.close(); }
});
