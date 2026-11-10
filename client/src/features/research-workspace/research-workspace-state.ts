import type { ResearchContext } from '@shared/simple-conversation.interface';
import { createRequestIntent } from '@/utils/simple-experience';

export interface ResearchWorkspaceRequest {
  intent: ReturnType<typeof createRequestIntent>;
  /** Retain exact wire input until delivery is acknowledged or explicitly rejected. */
  submission?: {
    message: string;
    context?: ResearchContext;
    replyTo?: string;
    requestKey: string;
  };
}

export interface ResearchWorkspaceComposer {
  draft: string;
  onDraftChange: (value: string) => void;
  request: ResearchWorkspaceRequest;
  onAccepted: (sessionId: string) => void;
}
