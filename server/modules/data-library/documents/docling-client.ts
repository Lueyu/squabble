import type { DocumentExtractor, DocumentTaskReceipt, DocumentTaskStatus, DocumentExtractionResult, DocumentUpload } from './document-client.interface';
import { validateDocumentUpload } from './document-client.interface';
import { LocalDocumentHttp } from './local-document-http';

export class DoclingClient implements DocumentExtractor {
  readonly id = 'docling'; readonly version = '1.38.2';
  constructor(private readonly http: LocalDocumentHttp) {}
  async submit(file: DocumentUpload, onReceipt?: (receipt: DocumentTaskReceipt) => Promise<void>): Promise<DocumentTaskReceipt> {
    validateDocumentUpload(file);
    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(file.data)], { type: file.mime }), file.fileName);
    form.append('to_formats', 'md'); form.append('to_formats', 'json');
    form.append('image_export_mode', 'placeholder'); form.append('do_picture_description', 'false');
    // The pinned engine requires the explicit ISO prefix; bare zh-Hans is
    // interpreted as an unsupported engine-native code by RapidOCR.
    form.append('do_ocr', 'true'); form.append('ocr_engine', 'rapidocr'); form.append('ocr_lang', 'iso:zh');
    const result = await this.http.json('v1/convert/file/async', { method: 'POST', body: form });
    if (typeof result.task_id !== 'string' || !result.task_id || result.task_id.length > 200) throw new Error('DOCLING_INVALID_RECEIPT');
    const receipt = { taskId: result.task_id }; await onReceipt?.(receipt); return receipt;
  }
  async status(receipt: DocumentTaskReceipt): Promise<DocumentTaskStatus> {
    const result = await this.http.json(`v1/status/poll/${encodeURIComponent(receipt.taskId)}`);
    const states: Record<string, DocumentTaskStatus> = { pending: 'pending', started: 'running', success: 'completed',
      failure: 'failed', cancelled: 'cancelled', canceled: 'cancelled' };
    const state = states[String(result.task_status)]; if (!state) throw new Error('DOCLING_UNKNOWN_STATE'); return state;
  }
  async result(receipt: DocumentTaskReceipt): Promise<DocumentExtractionResult> {
    const raw = await this.http.json(`v1/result/${encodeURIComponent(receipt.taskId)}`);
    if (raw.status !== 'success' || !raw.document || typeof raw.document !== 'object') throw new Error('DOCLING_EXTRACTION_FAILED');
    const document = raw.document as Record<string, unknown>;
    if (typeof document.md_content !== 'string' || !document.json_content || typeof document.json_content !== 'object') throw new Error('DOCLING_RESULT_MISSING');
    return { markdown: document.md_content, lossless: document.json_content };
  }
}
