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
    skillId?: string | null;
    agents?: import('@shared/agent-roster.interface').AgentSelection[];
  };
}

export interface ResearchWorkspaceComposer {
  agents?: import('@shared/agent-roster.interface').AgentSelection[];
  skillId?: string | null;
  onSkillChange: (id: string | null) => void;
  onStrategy: (message: string) => void;
  draft: string;
  onDraftChange: (value: string) => void;
  request: ResearchWorkspaceRequest;
  onAccepted: (sessionId: string) => void;
}
