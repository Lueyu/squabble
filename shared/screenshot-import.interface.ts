import type { OcrExtractResult } from './api.interface';
import type { NativeAgentConfiguration } from './local-agents.interface';
import type { NativeAgentImage } from './native-image.interface';

export type ScreenshotExtractRequest = {
  requestId: string;
  image: NativeAgentImage;
} & ({
  executor: 'local';
  agentId: string;
  agentSettings?: NativeAgentConfiguration;
} | {
  executor: 'vision';
  baseUrl?: string;
  model: string;
  apiKey: string;
});

export interface ScreenshotJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  phase: 'queued' | 'recognizing' | 'validating' | 'done';
  executor: 'local' | 'vision';
  createdAt: string;
  updatedAt: string;
  result?: OcrExtractResult;
  error?: { code: string };
}
