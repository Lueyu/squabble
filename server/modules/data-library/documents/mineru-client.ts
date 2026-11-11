import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import JSZip from 'jszip';
import type { DocumentExtractor, DocumentTaskReceipt, DocumentTaskStatus, DocumentExtractionResult, DocumentUpload } from './document-client.interface';
import { validateDocumentUpload } from './document-client.interface';
import { LocalDocumentHttp } from './local-document-http';
import { guardZip } from '../data-library.extract';

export class MineruClient implements DocumentExtractor {
  readonly id = 'mineru'; readonly version = '4.2.0';
  constructor(private readonly http: LocalDocumentHttp) {}
  async submit(file: DocumentUpload, onReceipt?: (receipt: DocumentTaskReceipt) => Promise<void>): Promise<DocumentTaskReceipt> {
    validateDocumentUpload(file);
    const result = await this.http.json('v1/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ file_name: file.fileName, bytes: file.data.length,
        sha256sum: createHash('sha256').update(file.data).digest('hex') }], output_formats: ['default'] }) });
    if (typeof result.task_id !== 'string' || !Array.isArray(result.files) || result.files.length !== 1) throw new Error('MINERU_INVALID_RECEIPT');
    const entry = result.files[0] as Record<string, unknown>;
    if (typeof entry.file_id !== 'string') throw new Error('MINERU_INVALID_RECEIPT');
    const receipt = { taskId: result.task_id, fileId: entry.file_id };
    await onReceipt?.(receipt);
    if (entry.upload) {
      const upload = entry.upload as Record<string, unknown>;
      if (typeof upload.url !== 'string' || !upload.headers || typeof upload.headers !== 'object') throw new Error('MINERU_INVALID_UPLOAD');
      const headers = new Headers();
      for (const [name, value] of Object.entries(upload.headers)) {
        if (typeof value !== 'string' || /^(host|cookie|authorization|proxy-authorization)$/iu.test(name)) throw new Error('MINERU_UPLOAD_HEADERS_REJECTED');
        headers.set(name, value);
      }
      await this.http.bytes(upload.url, { method: 'PUT', body: new Uint8Array(file.data), headers }, 1024 * 1024);
    }
    return receipt;
  }
  private async file(receipt: DocumentTaskReceipt): Promise<Record<string, unknown>> {
    const raw = await this.http.json(`v1/tasks/${encodeURIComponent(receipt.taskId)}`);
    if (raw.task_id !== receipt.taskId || !Array.isArray(raw.files)) throw new Error('MINERU_TASK_MISMATCH');
    const entry = raw.files.find(value => value && typeof value === 'object' && value.file_id === receipt.fileId);
    if (!entry) throw new Error('MINERU_FILE_MISMATCH'); return entry as Record<string, unknown>;
  }
  async status(receipt: DocumentTaskReceipt): Promise<DocumentTaskStatus> {
    const entry = await this.file(receipt), status = String(entry.status);
    const states: Record<string, DocumentTaskStatus> = { 'waiting-file': 'pending', pending: 'pending', running: 'running',
      completed: 'completed', failed: 'failed', canceled: 'cancelled' };
    if (!states[status]) throw new Error('MINERU_UNKNOWN_STATE'); return states[status];
  }
  async result(receipt: DocumentTaskReceipt): Promise<DocumentExtractionResult & { archive: Buffer }> {
    const entry = await this.file(receipt);
    if (entry.status !== 'completed' || typeof entry.result_url !== 'string') throw new Error('MINERU_RESULT_UNAVAILABLE');
    const archive = await this.http.bytes(entry.result_url);
    // The full archive is preserved. ZIP contents are checked separately when the worker normalizes the result.
    return { archive, markdown: '', lossless: { archiveFormat: 'mineru-default-zip' } };
  }
  async unpack(archive: Buffer): Promise<DocumentExtractionResult> {
    guardZip(archive, 'MINERU_ARCHIVE_REJECTED');
    const zip = await JSZip.loadAsync(archive, { createFolders: false });
    const entries = Object.values(zip.files).filter(entry => !entry.dir);
    if (entries.length > 2000 || entries.some(entry => /(^\/|(^|\/)\.\.\/|\\)/u.test(entry.name))) throw new Error('MINERU_ARCHIVE_REJECTED');
    const markdown = entries.filter(entry => entry.name.endsWith('.md'));
    const structured = entries.filter(entry => /(^|\/)(middle_json|structured_content)\.json$/u.test(entry.name));
    if (markdown.length !== 1 || !structured.length) throw new Error('MINERU_ARCHIVE_CONTENT_MISSING');
    let bytes = 0;
    const contents: Record<string, unknown> = {};
    for (const entry of [...markdown, ...structured]) {
      const data = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const stream = entry.nodeStream();
        stream.on('data', (chunk: Buffer) => { bytes += chunk.length;
          if (bytes > 32 * 1024 * 1024) {
            if (stream instanceof Readable) stream.destroy(new Error('MINERU_UNPACK_TOO_LARGE'));
            else { stream.pause(); reject(new Error('MINERU_UNPACK_TOO_LARGE')); }
          } else chunks.push(chunk);
        }).on('error', reject).on('end', () => resolve(Buffer.concat(chunks)));
      });
      contents[entry.name] = entry.name.endsWith('.json') ? JSON.parse(data.toString('utf8')) : data.toString('utf8');
    }
    return { markdown: String(contents[markdown[0].name]), lossless: contents, archive };
  }
  async cancel(receipt: DocumentTaskReceipt): Promise<void> {
    await this.http.json(`v1/tasks/${encodeURIComponent(receipt.taskId)}/cancel`, { method: 'POST' });
  }
}
