import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { DoclingClient } from './docling-client';
import { MineruClient } from './mineru-client';
import { LocalDocumentHttp } from './local-document-http';
import JSZip from 'jszip';

async function server(run: (base: string, requests: string[]) => Promise<void>) {
  const requests: string[] = [];
  const instance = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks); requests.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/convert/file/async') {
      assert.match(req.headers['content-type']!, /^multipart\/form-data/u); assert.match(body.toString(), /name="files"/u);
      assert.match(body.toString(), /name="to_formats"/u);
      assert.match(body.toString(), /name="ocr_engine"\r\n\r\nrapidocr/u);
      assert.match(body.toString(), /name="ocr_lang"\r\n\r\niso:zh/u);
      res.end(JSON.stringify({ task_id: 'doc-1', task_status: 'pending' }));
    } else if (req.url === '/v1/status/poll/doc-1') res.end(JSON.stringify({ task_status: 'success' }));
    else if (req.url === '/v1/result/doc-1') res.end(JSON.stringify({ status: 'success', document: { md_content: 'Revenue 12', json_content: { texts: [] } } }));
    else if (req.url === '/v1/tasks') {
      const parsed = JSON.parse(body.toString()); assert.equal(parsed.files[0].file_name, 'fixture.pdf');
      assert.equal(parsed.files[0].bytes, 8); assert.equal(parsed.files[0].url, undefined);
      res.end(JSON.stringify({ task_id: 'mine-1', files: [{ file_id: 'file-1', upload: { url: '/v1/upload/file-1', headers: {} } }] }));
    } else if (req.url === '/v1/upload/file-1') { assert.equal(req.method, 'PUT'); assert.equal(body.toString(), '%PDF-1.7'); res.end('{}'); }
    else if (req.url === '/v1/tasks/mine-1') res.end(JSON.stringify({ task_id: 'mine-1', status: 'completed',
      files: [{ file_id: 'file-1', status: 'completed', result_url: '/v1/files/result-1/content' }] }));
    else if (req.url === '/v1/files/result-1/content') { res.setHeader('Content-Type', 'application/zip'); res.end('PKfictional'); }
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  try { const address = instance.address(); assert.ok(address && typeof address === 'object'); await run(`http://127.0.0.1:${address.port}`, requests); }
  finally { await new Promise<void>(resolve => instance.close(() => resolve())); }
}
test('Docling uploads bytes and resumes asynchronous results through the official endpoints', async () => server(async base => {
  const client = new DoclingClient(new LocalDocumentHttp(base));
  const receipt = await client.submit({ fileName: 'fixture.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.7') });
  assert.equal(receipt.taskId, 'doc-1');
  assert.equal(await client.status(receipt), 'completed');
  assert.equal((await client.result(receipt)).markdown, 'Revenue 12');
}));
test('MinerU unpacks the current default archive names without executing archived assets', async () => {
  const zip = new JSZip(); zip.file('markdown.md', 'Revenue 20');
  zip.file('middle_json.json', JSON.stringify({ schema: 'docvortex.middle', schema_version: '2.0', pages: [] }));
  zip.file('structured_content.json', JSON.stringify({ pages: [] })); zip.file('images/chart.svg', '<svg/>');
  const archive = await zip.generateAsync({ type: 'nodebuffer' });
  const client = new MineruClient(new LocalDocumentHttp('http://127.0.0.1:8000'));
  const result = await client.unpack(archive); assert.equal(result.markdown, 'Revenue 20');
  assert.deepEqual(result.archive, archive);
});
test('MinerU submits a file manifest, PUTs scoped bytes and polls the exact returned file id', async () => server(async (base, requests) => {
  const client = new MineruClient(new LocalDocumentHttp(base));
  const receipt = await client.submit({ fileName: 'fixture.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.7') });
  assert.equal(await client.status(receipt), 'completed');
  assert.equal((await client.result(receipt)).archive.toString(), 'PKfictional');
  assert.deepEqual(requests, ['POST /v1/tasks', 'PUT /v1/upload/file-1', 'GET /v1/tasks/mine-1', 'GET /v1/tasks/mine-1', 'GET /v1/files/result-1/content']);
  assert.throws(() => new LocalDocumentHttp('https://example.com'), /LOCAL/);
  await assert.rejects(new LocalDocumentHttp(base).bytes('http://169.254.169.254/private'), /SCOPE/);
}));
