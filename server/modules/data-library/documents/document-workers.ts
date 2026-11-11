import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DocumentJobsService } from '../document-jobs.service';
import { ResearchDerivedCleanupService } from '../../research-artifacts/research-derived-cleanup.service';
import type { DocumentExtractor } from './document-client.interface';
import { DoclingClient } from './docling-client';
import { MineruClient } from './mineru-client';
import { LocalDocumentHttp } from './local-document-http';

/** Endpoints and credentials come only from deployer configuration, never upload/request bodies. */
export function configuredDocumentExtractors(): DocumentExtractor[] {
  const allowed = (process.env.DOCUMENT_ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const extractors: DocumentExtractor[] = [];
  if (process.env.DOCUMENT_DOCLING_URL) extractors.push(new DoclingClient(new LocalDocumentHttp(
    process.env.DOCUMENT_DOCLING_URL, process.env.DOCUMENT_DOCLING_KEY, allowed)));
  if (process.env.DOCUMENT_MINERU_URL) extractors.push(new MineruClient(new LocalDocumentHttp(
    process.env.DOCUMENT_MINERU_URL, process.env.DOCUMENT_MINERU_KEY, allowed, 'bearer')));
  return extractors;
}
@Injectable()
export class DocumentWorkers implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>; private running = false;
  constructor(private readonly jobs: DocumentJobsService, private readonly cleanup: ResearchDerivedCleanupService) {}
  onModuleInit(): void {
    if (process.env.DATA_LIBRARY_SYNC_DISABLED === 'true') return;
    this.timer = setInterval(() => { void this.tick(); }, 15_000); this.timer.unref();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }
  private async tick(): Promise<void> {
    if (this.running) return; this.running = true;
    try { await this.jobs.runDue(); await this.cleanup.runDue(); } catch { /* Durable jobs and tombstones remain eligible on the next tick. */ }
    finally { this.running = false; }
  }
}
