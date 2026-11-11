import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TavilyAdapter } from './tavily.adapter';
import { ExaAdapter } from './exa.adapter';
import { ProviderHttp } from './search-provider.contract';
import { ToolTransportPolicy } from '../tool-transport-policy';

class CapturePolicy extends ToolTransportPolicy {
  requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  failure = false;
  async fetch(input: string | URL, init: RequestInit = {}) {
    this.requests.push({ url: String(input), body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
    if (this.failure) throw new Error('upstream private failure fixture-secret');
    return new Response(JSON.stringify({ results: [{ title: 'Original disclosure', url: 'https://issuer.org/report',
      content: 'cash flow', highlights: ['cash flow'] }] }), { headers: { 'Content-Type': 'application/json' } });
  }
}

test('Tavily/Exa discover locally then perform one fixed native call with bounded sources and unknown publication dates', async () => {
  const policy = new CapturePolicy([]), http = new ProviderHttp(policy), tavily = new TavilyAdapter(http), exa = new ExaAdapter(http);
  const connection = { id: 'fixture', provider: 'tavily', endpoint: null, secret: 'fixture-secret' };
  const [tavilyTool] = await tavily.discover(connection), [exaTool] = await exa.discover({ ...connection, provider: 'exa' });
  assert.equal(policy.requests.length, 0);
  const result = await tavily.invoke(connection, tavilyTool, { query: '公司 现金流', topK: 5, language: 'zh', domains: ['issuer.org'] }, { invocationId: '1' });
  assert.equal(policy.requests.length, 1); assert.equal(policy.requests[0].url, 'https://api.tavily.com/search');
  assert.equal(policy.requests[0].headers.get('authorization'), 'Bearer fixture-secret');
  assert.equal(policy.requests[0].body.include_answer, false); assert.equal(policy.requests[0].body.max_results, 5);
  assert.deepEqual(policy.requests[0].body.include_domains, ['issuer.org']);
  assert.equal((result.output as { sources: Array<{ publishedAt: string | null }> }).sources[0].publishedAt, null);
  assert.equal(result.dataAsOf, null); assert.equal(result.usage?.[0].amount, null);
  await exa.invoke({ ...connection, provider: 'exa' }, exaTool, { query: 'cash flow', topK: 3 }, { invocationId: '2' });
  assert.equal(policy.requests[1].url, 'https://api.exa.ai/search'); assert.equal(policy.requests[1].headers.get('x-api-key'), 'fixture-secret');
  assert.deepEqual(policy.requests[1].body.contents, { highlights: true }); assert.equal(policy.requests[1].body.type, 'auto');
  assert.equal(policy.requests[1].body.numResults, 3);
});

test('paid search failure is unknown, redacted and never triggers retry/fallback; invalid args and missing auth do not dispatch', async () => {
  const policy = new CapturePolicy([]), adapter = new TavilyAdapter(new ProviderHttp(policy));
  const connection = { id: 'fixture', provider: 'tavily', endpoint: null, secret: 'fixture-secret' }, [tool] = await adapter.discover(connection);
  await assert.rejects(adapter.invoke(connection, tool, { query: 'x', topK: 100 }, { invocationId: 'invalid' }), /INVALID_TOOL_ARGUMENTS/u);
  await assert.rejects(adapter.invoke({ ...connection, secret: null }, tool, { query: 'x', topK: 1 }, { invocationId: 'auth' }), /TOOL_AUTHORIZATION_REQUIRED/u);
  assert.equal(policy.requests.length, 0);
  policy.failure = true;
  await assert.rejects(adapter.invoke(connection, tool, { query: 'x', topK: 1 }, { invocationId: 'failure' }), /TOOL_PROVIDER_UNKNOWN/u);
  assert.equal(policy.requests.length, 1);
});
