/** Internal owner/source identity. Never interpreted as a filesystem path. */
export interface BrowserSourceKey {
  ownerId: string;
  sourceId: string;
}

export type BrowserSourceErrorCode = 'NEEDS_AUTH' | 'UNAVAILABLE' | 'BUSY'
  | 'BLOCKED' | 'TIMEOUT' | 'CANCELLED' | 'RESPONSE_TOO_LARGE' | 'NETWORK_ERROR';

export class BrowserSourceError extends Error {
  constructor(readonly code: BrowserSourceErrorCode) {
    super(code);
    this.name = 'BrowserSourceError';
  }
}

export interface BrowserAvailability {
  available: boolean;
  canOpenInteractive: boolean;
  reason?: string;
}

export interface BrowserSourceReadRequest {
  key: BrowserSourceKey;
  url: string;
  /** Decrypted only inside the service/runtime boundary; never return to clients. */
  storageState?: string;
  signal?: AbortSignal;
}

export interface BrowserSourceReadResult {
  url: string;
  title: string;
  html: Buffer;
  text: string;
  observedAt: string;
  mimeType: 'text/html';
  provenance: 'browser-rendered';
  /** Internal only: encrypt and strip before archiving or returning a snapshot. Never log or expose to clients/Agents. */
  refreshedStorageState?: string;
}

export interface BrowserSourceRuntimePort {
  availability(): Promise<BrowserAvailability>;
  loginWindowOpen(key: BrowserSourceKey): boolean;
  open(key: BrowserSourceKey, url: string, storageState?: string): Promise<{ expiresAt: string }>;
  /** Raw state is returned only to the encrypting persistence service. */
  confirm(key: BrowserSourceKey): Promise<{ storageState: string; url?: string; title?: string }>;
  read(request: BrowserSourceReadRequest): Promise<BrowserSourceReadResult>;
  close(key: BrowserSourceKey): Promise<void>;
  shutdown(): Promise<void>;
}
