import type { ModelConnection } from '@shared/model-connections.interface';
import type { ResearchExecutionReadiness } from '@shared/research-execution.interface';
import type { TeamRunAgreement, TeamRunCycle } from '@shared/team-run.interface';
import type { TeamSummary } from '@shared/team-workspace.interface';

export const IMPORT_ONBOARDING_PATH = '/import?accountId=real&onboarding=1';
export const LOCAL_ONBOARDING_PATH = '/settings/agents?onboarding=1';
export const MODEL_ONBOARDING_PATH = '/settings/models?onboarding=1';
export const TEAM_ONBOARDING_PATH = '/teams?guided=1';
export type OnboardingStep = 'holdings' | 'connection' | 'team';

export type AiConnection =
  | { kind: 'local'; connection: ResearchExecutionReadiness }
  | { kind: 'model'; connection: ModelConnection };

export function usableAiConnection(locals: readonly ResearchExecutionReadiness[], models: readonly ModelConnection[]): AiConnection | null {
  const local = locals.find(row => row.connected && row.executable);
  if (local) return { kind: 'local', connection: local };
  const model = models.find(row => row.available && row.testState === 'passed' && row.testedAt);
  return model ? { kind: 'model', connection: model } : null;
}

export function teamOnboardingPath(id: string, panel: 'overview' | 'organization' = 'overview') {
  return `/teams/${encodeURIComponent(id)}?panel=${panel}&onboarding=1`;
}

export interface OnboardingFacts {
  hasHoldings: boolean;
  connection: AiConnection | null;
  connectionPath: string;
  team: Pick<TeamSummary, 'id'> | null;
  agreementState: TeamRunAgreement['state'] | null;
  latestCycleState?: TeamRunCycle['state'];
  hasCreationProgress: boolean;
}

export function onboardingNext(facts: OnboardingFacts) {
  if (facts.hasCreationProgress) return { step: 'team', path: TEAM_ONBOARDING_PATH } as const;
  const needsAttention = facts.agreementState === 'suspended' || facts.latestCycleState === 'blocked' || facts.latestCycleState === 'uncertain';
  if (facts.agreementState === 'running' && !needsAttention) return null;
  if (facts.team) {
    return { step: 'team', path: teamOnboardingPath(facts.team.id), agreementState: facts.agreementState, needsAttention } as const;
  }
  if (!facts.hasHoldings) return { step: 'holdings', path: IMPORT_ONBOARDING_PATH } as const;
  if (!facts.connection) return { step: 'connection', path: facts.connectionPath } as const;
  return { step: 'team', path: TEAM_ONBOARDING_PATH } as const;
}
