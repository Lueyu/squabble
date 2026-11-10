import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import JSZip from 'jszip';
import { publicSourceUrl, fetchLibraryUrl, MAX_WEB_BYTES, type LibraryTransport } from './data-library.fetch';
import { extractDocument, extractHtml, extractJson, extractPptx, extractRss } from './data-library.extract';
import { authHeaders, decodeDataSecret, encodeDataSecret } from './data-library.secrets';
import { parseAlphaVantage } from './data-financial.service';
const publicDns = async () => [{ address: '8.8.8.8', family: 4 }];
test('public-source URL blocks private addresses, disguised addresses and credential queries', async () => {
  for (const url of ['http://good.org', 'https://user:password@good.org', 'https://127.0.0.1', 'https://[::ffff:127.0.0.1]',
    'https://good.org:8443/', 'https://good.org/?access_token=private', 'https://local.internal/']) {
    await assert.rejects(publicSourceUrl(url, publicDns));
  }
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:10.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1']) {
    await assert.rejects(publicSourceUrl('https://good.org/', async () => [{ address, family: address.includes(':') ? 6 : 4 }]));
  }
  await assert.rejects(publicSourceUrl('https://good.org/', async () => [...await publicDns(), { address: '127.0.0.1', family: 4 }]));
  assert.equal((await publicSourceUrl('https://good.org/articles', publicDns)).url.pathname, '/articles');
});
test('redirects validate every host and never send authorization cross-origin', async () => {
  let calls = 0;
  const redirect: LibraryTransport = async (_url, _headers, addresses) => { calls++; assert.equal(addresses[0].address, '8.8.8.8'); return { status: 302, headers: { location: 'https://other.org/' }, body: Buffer.alloc(0) }; };
  await assert.rejects(fetchLibraryUrl('https://good.org/', { Cookie: 'session=private' }, redirect, publicDns), /AUTH_REDIRECT_BLOCKED/u);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(fetchLibraryUrl('https://good.org/', {}, redirect, async host => host === 'good.org' ? publicDns() : [{ address: '10.0.0.1', family: 4 }]), /PRIVATE_ADDRESS_BLOCKED/u);
  assert.equal(calls, 1);
  await assert.rejects(fetchLibraryUrl('https://good.org/', {}, async () => ({ status: 401, headers: {}, body: Buffer.from('login') }), publicDns), /NEEDS_AUTH/u);
  await assert.rejects(fetchLibraryUrl('https://good.org/', {}, async () => ({ status: 200, headers: {}, body: Buffer.alloc(MAX_WEB_BYTES + 1) }), publicDns), /RESPONSE_TOO_LARGE/u);
});
test('HTML does not execute or preserve scripts/forms; login forms are not source content', () => {
  const parsed = extractHtml('<script>SECRET_TOKEN</script><nav>menu</nav><article><h1>财报</h1><p>营收增长20%</p><p>盈利改善</p></article>');
  assert.match(parsed.text, /营收增长20%/u); assert.ok(!parsed.rawContent.includes('SECRET_TOKEN')); assert.ok(!parsed.text.includes('menu'));
  assert.throws(() => extractHtml('<h1>登录</h1><form><input type="password"></form>'), /NEEDS_AUTH/u);
  assert.equal(extractJson('{"token":"private","revenue":123,"items":["growth"]}').text, '123\n\ngrowth');
  assert.throws(() => extractJson('{"status":401,"message":"login required"}'), /NEEDS_AUTH/u);
  assert.match(extractRss('<rss><channel><item><title>投资观点</title><description>保持耐心</description></item></channel></rss>').text, /保持耐心/u);
  assert.throws(() => extractRss('<!DOCTYPE rss [<!ENTITY foo "bad">]><rss/>'), /UNSAFE_XML/u);
});
test('PPTX text retains presentation order and original slide locator; image remains un-OCRed', async () => {
  const zip = new JSZip();
  zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>First</a:t></p:sld>');
  zip.file('ppt/slides/slide2.xml', '<p:sld><a:t>Second</a:t></p:sld>');
  zip.file('ppt/presentation.xml', '<p:presentation><p:sldId r:id="two"/><p:sldId r:id="one"/></p:presentation>');
  zip.file('ppt/_rels/presentation.xml.rels', '<Relationships><Relationship Id="two" Target="slides/slide2.xml"/><Relationship Id="one" Target="slides/slide1.xml"/></Relationships>');
  const result = await extractPptx(await zip.generateAsync({ type: 'nodebuffer' }));
  assert.equal(result.sections[0].text, 'Second'); assert.equal(result.sections[0].locator, 'slide:1');
  assert.equal((await extractDocument('image', Buffer.from('image'), '人工说明')).state, 'needs-text');
  const bomb = new JSZip(); bomb.file('ppt/slides/slide1.xml', 'a'.repeat(3_000_000));
  await assert.rejects(extractPptx(await bomb.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })), /ARCHIVE_TOO_LARGE/u);
});
test('credentials encrypt, fail closed after rotation, and only become host-bound allowed headers', () => {
  const previous = process.env.SETTINGS_ENCRYPTION_KEY;
  try {
    process.env.SETTINGS_ENCRYPTION_KEY = 'test-only-data-secret-123456';
    const encrypted = encodeDataSecret('session=private-value'); assert.ok(!encrypted.includes('private-value'));
    assert.equal(decodeDataSecret(encrypted), 'session=private-value');
    process.env.SETTINGS_ENCRYPTION_KEY = 'other-test-only-secret-12345'; assert.equal(decodeDataSecret(encrypted), null);
    assert.deepEqual(authHeaders('basic', 'test:password'), { Authorization: `Basic ${Buffer.from('test:password').toString('base64')}` });
    assert.throws(() => authHeaders('cookie', 'session=x\r\nHost: evil'));
  } finally { if (previous === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY; else process.env.SETTINGS_ENCRYPTION_KEY = previous; }
});
test('Alpha Vantage validates identity/dates, normalizes EOD data, and does not call rate limits success', () => {
  const parsed = parseAlphaVantage({ 'Global Quote': { '01. symbol': 'AAPL', '05. price': '123.45', '07. latest trading day': '2026-11-09' } }, 'AAPL', 'quote');
  assert.equal(parsed.asOf, '2026-11-09'); assert.equal((parsed.data as { price: number }).price, 123.45);
  assert.throws(() => parseAlphaVantage({ Information: 'premium access required' }, 'AAPL', 'quote'), /RATE_LIMIT_OR_ENTITLEMENT/u);
  assert.throws(() => parseAlphaVantage({ 'Global Quote': { '01. symbol': 'MSFT' } }, 'AAPL', 'quote'), /NO_DATA/u);
  assert.throws(() => parseAlphaVantage({ 'Global Quote': { '01. symbol': 'AAPL', '05. price': '150', '07. latest trading day': '2999-01-01' } }, 'AAPL', 'quote'), /NO_DATA/u);
  const history = parseAlphaVantage({ 'Meta Data': { '2. Symbol': 'AAPL' }, 'Time Series (Daily)': {
    '2026-11-09': { '4. close': '150' }, '2026-11-06': { '4. close': '149' } } }, 'AAPL', 'daily-history');
  assert.equal(history.asOf, '2026-11-09');
});
