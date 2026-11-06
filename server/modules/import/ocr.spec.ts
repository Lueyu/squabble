import { test } from 'node:test';
import assert from 'node:assert/strict';
import { of, throwError, Observable } from 'rxjs';
import type { HttpService } from '@nestjs/axios';
import { OcrService } from './ocr.service';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const dto = { imageBase64: `data:image/png;base64,${png}`, apiKey: 'fixture-secret', model: 'fixture-vision', baseUrl: 'https://vision.example/v1' };
const endpoint = { normalize: async (input: string) => input };
const content = '{"broker":null,"rows":[{"ticker":"TEST","shares":1,"avgCost":null,"currency":"USD"}]}';

test('vision sends correct MIME, one call, no redirects and bounded response', async () => {
  let calls = 0;
  const service = new OcrService({ post: (url, body, config) => {
    calls++; assert.equal(url, dto.baseUrl + '/chat/completions');
    assert.equal(body.messages[0].content[1].image_url.url, dto.imageBase64);
    assert.equal(config.headers.Authorization, 'Bearer fixture-secret');
    assert.equal(config.maxRedirects, 0); assert.equal(config.proxy, false);
    assert.equal(config.timeout, 90_000); assert.equal(config.maxContentLength, 1_048_576);
    return of({ data: { choices: [{ message: { content } }] } });
  } } as HttpService, endpoint);
  assert.equal((await service.extract(dto)).rows[0].avgCost, null);
  assert.equal(calls, 1);
});

test('quota, rate limit, authentication and timeout get safe actionable codes', async () => {
  for (const [failure, expected] of [
    [{ response: { status: 429, data: { error: { code: 'insufficient_quota', message: 'fixture-secret' } } } }, 'VISION_USAGE_LIMIT'],
    [{ response: { status: 429 } }, 'VISION_RATE_LIMIT'],
    [{ response: { status: 401 } }, 'VISION_AUTH_REQUIRED'],
    [{ response: { status: 402 } }, 'VISION_USAGE_LIMIT'],
    [{ code: 'ECONNABORTED' }, 'VISION_TIMEOUT'],
    [{ response: { status: 500, data: 'private screenshot content' } }, 'VISION_FAILED'],
  ] as const) {
    let calls = 0;
    const service = new OcrService({ post: () => { calls++; return throwError(() => failure); } } as unknown as HttpService, endpoint);
    await assert.rejects(service.extract(dto), error => error instanceof Error && error.message === expected);
    assert.equal(calls, 1);
  }
});

test('invalid endpoint/image stops before HTTP; cancellation reaches transport', async () => {
  let calls = 0;
  const http = { post: (_url, _body, options) => {
    calls++;
    return new Observable(subscriber => {
      options.signal.addEventListener('abort', () => subscriber.error({ code: 'ERR_CANCELED' }), { once: true });
    });
  } } as unknown as HttpService;
  const denied = new OcrService(http, { normalize: async () => { throw new Error('private address'); } });
  await assert.rejects(denied.extract(dto), /INVALID_API_CONFIGURATION/);
  const service = new OcrService(http, endpoint);
  await assert.rejects(service.extract({ ...dto, imageBase64: 'data:image/jpeg;base64,' + png }), /INVALID_IMAGE/);
  assert.equal(calls, 0);
  const controller = new AbortController();
  const run = service.extract(dto, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(run, /VISION_FAILED/);
  assert.equal(calls, 1);
});

test('cancel does not wait for DNS and late resolution never sends a screenshot', async () => {
  let resolveDns!: (value: string) => void;
  let calls = 0;
  const service = new OcrService({ post: () => { calls++; return of({}); } } as unknown as HttpService,
    { normalize: () => new Promise(resolve => { resolveDns = resolve; }) });
  const controller = new AbortController();
  const pending = service.extract(dto, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, /VISION_FAILED/);
  resolveDns(dto.baseUrl);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
});
