/** Channel artifacts are public, sourced records; no private model reasoning is stored here. */
export type ChannelId = string;
export type ChannelWeight = 'tap' | 'nudge' | 'poke';
export type ChannelStance = 'plain_fact' | 'I_told_you' | 'admit_wrong' | 'unsure_honest' | 'quiet_win' | 'watchful' | 'mood';
export type ChannelSpeaker = 'laozhou' | 'ajie' | 'xiaoqi';
export type ChannelVibe = 'quiet' | 'deskmate' | 'chatty';
export type RuleStatus = 'proposed' | 'applying' | 'active' | 'failed' | 'partially_filled' | 'superseded';
export type ChannelPosture = 'alarm' | 'accompany' | 'close' | 'standalone';
export type FindingOutcome = 'critical_counterevidence' | 'partially_weakened' | 'no_counterevidence_found' | 'unable_to_verify';
export type ChannelDeliveryCause = 'monitor' | 'user_reply' | 'process' | 'closing_ritual' | 'background_finding';
export type ChannelEventKind = 'monitor.near' | 'monitor.breached' | 'monitor.persisted' | 'monitor.recovered'
  | 'thesis.changed' | 'fact.corrected' | 'source.missing' | 'catalyst.countdown' | 'strategy.changed'
  | 'paper.execution_changed' | 'user.question' | 'research.day_closed' | 'research.finding';

export interface ChannelSource {
  id: string; kind: 'filing' | 'market_data' | 'news' | 'ledger' | 'tool_result';
  title: string; uri: string; publishedAt: string | null; observedAt: string;
  verification: 'retrieved' | 'checked' | 'unverified'; locator?: string; originId?: string;
}
export interface ChannelEvidenceCard {
  id: string; kind: 'evidence' | 'gap'; summary: string; sources: ChannelSource[];
  asOf: string; gaps: string[]; supports: Array<{ factId?: string; thesisId?: string; scope: string }>;
}
export type ChannelPrimaryAnchor = { kind: 'report_section'; reportId: string; reportRevision: number; sectionId: string }
  | { kind: 'fact'; factId: string; factRevision: number };
export interface ChannelAnchors {
  primary: ChannelPrimaryAnchor; triggerEventId: string; thesis?: { id: string; revision: number };
  replyToBubbleId?: string; priorOwnBubbleId?: string; relationshipMemoryIds?: string[] | null;
}
export interface ChannelAction {
  id: string; label: string; kind: 'ask_one_fact' | 'view_evidence' | 'review_proposal' | 'apply_proposal' | 'dismiss_proposal' | 'snooze_episode';
  targetId: string; expectedRevision: number; expiresAt?: string;
}
interface ChannelBubbleBase {
  id: string; ownerId: string; speaker: ChannelSpeaker; episodeId: string; posture: ChannelPosture;
  anchors: ChannelAnchors; text: string; evidence: ChannelEvidenceCard;
  templateId: string; templateRevision: number; semanticDeltaId: string; createdAt: string;
  correctionOf?: string; deliveryCause: ChannelDeliveryCause;
  /** Projection-only provenance badge; never an investment conclusion. */
  sourceState?: 'current' | 'superseded' | 'corrected';
}
export type ChannelBubble = ChannelBubbleBase & (
  { stance: 'mood'; weight: 'tap'; layer: 2; action?: never }
  | { stance: Exclude<ChannelStance, 'mood'>; weight: ChannelWeight; layer: 2 | 3 | 4; action?: ChannelAction[] }
);
export interface ChannelEvent {
  id: string; ownerId: string; entityId: string; episodeId: string; sequence: number;
  occurredAt: string; observedAt: string; kind: ChannelEventKind;
  factRefs: Array<{ id: string; revision: number }>; runtimeRevision?: number; correctsEventId?: string;
  semanticDeltaId: string; findingId?: string;
}
/** Inherits semanticDeltaId from ChannelEvent; it is the same field, never a second identity. */
export interface BackgroundFindingEvent extends Omit<ChannelEvent, 'kind'> { kind: 'research.finding'; findingId: string }
export interface ChannelEpisode {
  id: string; revision: number; entityId: string; phase: 'idle' | 'alarm' | 'accompany' | 'closed';
  severity: 'ordinary' | 'important' | 'critical'; lastEventSequence: number; consumedDeltaIds: string[];
  lastPublishedAt?: string; hadBreach: boolean; executionIds: string[]; userDecisionIds: string[];
}
export interface TemplateRef { templateId: string; templateRevision: number }
export interface TemplateSlot {
  name: string;
  source: { kind: 'fact'; factKey: string } | { kind: 'runtime'; field: string } | { kind: 'report'; assertionId: string };
  format: 'decimal' | 'money' | 'duration' | 'time' | 'approved_label';
  /** Approved labels are finite registry values, never arbitrary source prose. */
  approvedLabels?: string[];
}
export interface ChannelTemplate {
  id: string; revision: number; kind: 'bubble' | 'evidence_card'; status: 'draft' | 'active' | 'retired';
  body: string; slotSchema: TemplateSlot[]; allowedStances: ChannelStance[]; allowedWeights: ChannelWeight[];
  family: string; isFactualStatusOnly: boolean;
  subject: 'information_quality' | 'research_process' | 'verified_fact' | 'research_judgment' | 'runtime_status';
  changesConclusion: boolean; impliesInvestmentAdvice: boolean; reviewedAt: string | null;
  retiredAt: string | null; contentHash: string; speaker?: ChannelSpeaker;
}
export interface ChannelFact {
  id: string; revision: number; ownerId: string; value: string | number | boolean | null;
  key: string; observedAt: string; sourceId?: string; correctedBy?: string;
  expiresAt?: string;
  subject: ChannelTemplate['subject'];
}
export interface BackgroundFinding {
  id: string; ownerId: string; episodeId: string; researchRunId: string; createdAt: string;
  kind: 'critical_counterevidence' | 'partially_weakened' | 'material_gap' | 'verified_discrepancy';
  anchor: ChannelPrimaryAnchor; thesis?: { id: string; revision: number }; affectedPremiseIds: string[];
  evidenceCardId: string; semanticDeltaId: string; reverseCheckOutcome?: FindingOutcome;
  template: TemplateRef; slots: Record<string, string | number>; weight: 'nudge' | 'poke';
  review: { state: 'pending' | 'approved' | 'rejected'; reviewedAt?: string; reviewerId?: string };
}
export type FindingCandidate = Omit<BackgroundFinding, 'review'>;
export interface FindingSeal {
  findingId: string; ownerId: string; compilerVersion: string; payloadHash: string; dependencyDigest: string;
  grantedAt: string; review: BackgroundFinding['review'];
}
export type ChannelPredicate = { kind: 'event'; eventKind: ChannelEventKind; entityId: string }
  | { kind: 'cross'; factKey: string; operator: 'above' | 'below'; threshold: { kind: 'report_value'; assertionId: string; value: string }
    | { kind: 'active_rule'; ruleId: string; field: string }; hysteresis: string }
  | { kind: 'persist'; conditionId: string; durationSeconds: number; requireFreshObservation: true };
export interface ChannelBrief {
  id: string; revision: number; reportId: string; reportRevision: number;
  when: ChannelPredicate; agent: ChannelSpeaker; text: TemplateRef & { slots: TemplateSlot[] };
  card: TemplateRef & { sourceEvidenceCardIds: string[]; includeTriggerFacts: true };
  anchor: { reportSectionId: string; assertionId?: string; thesisId?: string; priorOwnBubbleId?: string };
  stance: ChannelStance; weight: ChannelWeight; layer: 2 | 3 | 4; posture: ChannelPosture;
  requiredChecks: string[]; validFrom: string; expiresAt: string; status: 'ready' | 'invalidated' | 'expired';
}
export interface ChannelRuntimeSnapshot {
  accountId: string | null; accountKind: 'paper'; revision: number; confirmedAt: string;
  monitoringStatus: 'observing' | 'running' | 'paused' | 'stopped';
  monitoringReason: string | null;
  current: { strategyId: string | null; strategyRevision: number | null;
    rules: Array<{ id: string; label: string; status: Exclude<RuleStatus, 'partially_filled'>; value: string;
      effective: boolean; effectiveReason: 'paused' | 'expired' | 'not_started' | 'stopped' | 'observation_only' | null }>;
    positions: Array<{ symbol: string; quantity: string }>; cash: Array<{ currency: string; amount: string }>;
    valuationAsOf: string | null };
  proposals: Array<{ id: string; revision: number; status: Exclude<RuleStatus, 'partially_filled'>; before: string; after: string; reasonCardId: string }>;
  executions: Array<{ id: string; symbol: string; strategyId: string | null; strategyRevision: number; status: 'queued' | 'working' | 'partially_filled' | 'filled' | 'failed' | 'cancelled';
    requestedQuantity: string; filledQuantity: string; remainingQuantity: string; updatedAt: string }>;
}
export interface ChannelProjection {
  runtime: ChannelRuntimeSnapshot; vibe: ChannelVibe; pinned: ChannelBubble | null; pendingCount: number;
  episodes: Array<{ episode: ChannelEpisode; bubbles: ChannelBubble[] }>;
  visibleTaps: ChannelBubble[]; progress: { runningCount: number; gapCount: number };
  report: { id: string; title: string; createdAt: string; href: string } | null;
  deferredQuestions: DeferredQuestion[]; sourcesAvailable: boolean;
}
export interface SupplementRequest {
  id: string; ownerId: string; userMessageId: string; requestKey: string; factQuestion: string; selectedToolId: string;
  maxToolCalls: 1; claimedToolCalls: 0 | 1; deferredQuestionIds: string[];
  /** Frozen once before selection; counts and indexes are derived from this list. */
  originalQuestions: ReadonlyArray<{ id: string; text: string }>;
  status: 'needs_scope' | 'running' | 'answered' | 'not_verified' | 'failed'; conclusion?: string; evidenceCardId?: string;
}
export interface DeferredQuestion {
  id: string; ownerId: string; originatingRequestId: string; text: string;
  status: 'pending' | 'selected' | 'dismissed'; createdAt: string;
}
interface DecisionReflectionBase { id: string; decisionId: string; recordedAt: string }
export type DecisionReflection =
  | DecisionReflectionBase & { kind: 'reason_at_adoption'; author: 'system_snapshot'; userMessageId?: never;
    snapshot: { strategyId: string | null; strategyRevision: number | null; runtimeRevision: number;
      reportRefs: Array<{ id: string; revision: number }>; evidenceIds: string[]; knownGapIds: string[] }; text?: never }
  | DecisionReflectionBase & { kind: 'reason_at_adoption' | 'later_reflection'; author: 'user'; userMessageId?: string; userInputRecordId: string; text: string }
  | DecisionReflectionBase & { kind: 'reason_at_adoption'; author: 'unrecorded'; userMessageId?: never; text?: never };
export interface RelationshipMemoryEvent {
  id: string; ownerId: string; speaker?: ChannelSpeaker; kind: 'shared_history' | 'user_stated_preference' | 'persona_trait';
  recordedAt: string; sourceMessageId?: string; sourceBubbleId?: string; exactUserQuote?: string; content: string; supersedesId?: string;
}
