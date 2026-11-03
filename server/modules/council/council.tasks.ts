import { BadRequestException } from '@nestjs/common';
import type { CouncilMember } from '../../../shared/council.interface';
import type { ResearchDelivery, ResearchGoal, ResearchSkillPin, ResearchTaskKind, ResearchWorkflowConfig } from '../../../shared/research-workflow.interface';
import { normalizeTicker } from './council.rules';
import { canonicalResearchTicker } from '../research-tools/research-valuation';
import { thesisCandidateSchema } from '../research-memory/research-memory.requests';
import { normalizeThesisContent, validateThesisReferences } from '../research-memory/research-memory.theses';

export interface TaskPlan { key: ResearchTaskKind; dependencies: ResearchTaskKind[]; memberId: string; position: number }
export function validateWorkflowInput(input: { goal?: unknown; peers?: unknown; parallelism?: unknown; recallEnabled?: unknown }, ticker: string): ResearchWorkflowConfig | undefined {
  if (input.goal === undefined) return undefined; // Historical callers retain their serial dialogue.
  if (!['comprehensive', 'financials', 'peers', 'valuation'].includes(String(input.goal))) throw new BadRequestException('Invalid research goal');
  if (input.parallelism !== undefined && input.parallelism !== 1 && input.parallelism !== 2) throw new BadRequestException('Parallelism must be 1 or 2');
  if (input.recallEnabled !== undefined && typeof input.recallEnabled !== 'boolean') throw new BadRequestException('Invalid memory preference');
  const raw = input.peers ?? [];
  if (!Array.isArray(raw) || raw.length > 3) throw new BadRequestException('Select at most three peers');
  let peers: string[];
  try { peers = raw.map(value => { const symbol = canonicalResearchTicker(normalizeTicker(value)); if (!symbol) throw new Error('Invalid peer'); return symbol; }); }
  catch { throw new BadRequestException('Invalid peer ticker'); }
  if (new Set(peers).size !== peers.length || peers.includes(canonicalResearchTicker(ticker) ?? ticker)) throw new BadRequestException('Peers must be distinct from the subject');
  if (input.goal === 'peers' && !peers.length) throw new BadRequestException('Choose at least one peer');
  return { goal: input.goal as ResearchGoal, peers, parallelism: input.parallelism === 1 ? 1 : 2, recallEnabled: input.recallEnabled !== false };
}

export function planResearchTasks(goal: ResearchGoal, members: CouncilMember[]): TaskPlan[] {
  const moderator = members.find(m => m.role === 'manager');
  const reviewers = members.filter(m => m.role !== 'manager');
  if (!moderator || !reviewers.length) throw new Error('Research requires a member and moderator');
  const financial = reviewers.find(m => m.researchFocus?.includes('financials')) ?? reviewers[0];
  const business = reviewers.find(m => m.id !== financial.id) ?? financial;
  const valuation = reviewers.find(m => m.researchFocus?.includes('valuation')) ?? financial;
  const challenger = reviewers.find(m => m.role === 'challenger') ?? business;
  const tasks: Omit<TaskPlan, 'position'>[] = [{ key: 'financials', dependencies: [], memberId: financial.id }];
  if (goal === 'comprehensive' || goal === 'peers') tasks.push({ key: 'business', dependencies: [], memberId: business.id });
  if (goal === 'comprehensive' || goal === 'valuation') tasks.push({ key: 'valuation', dependencies: tasks.map(t => t.key), memberId: valuation.id });
  tasks.push({ key: 'challenge', dependencies: tasks.some(t => t.key === 'valuation') ? ['valuation'] : tasks.map(t => t.key), memberId: challenger.id });
  tasks.push({ key: 'summary', dependencies: tasks.map(t => t.key), memberId: moderator.id });
  return tasks.map((t, position) => ({ ...t, position }));
}

export function dependentTaskKeys(tasks: Array<Pick<TaskPlan, 'key' | 'dependencies'>>, selected: ResearchTaskKind[]): ResearchTaskKind[] {
  const result = new Set(selected);
  for (const t of tasks) if (t.dependencies.some(d => result.has(d))) result.add(t.key);
  return tasks.filter(t => result.has(t.key)).map(t => t.key);
}

export function validateDelivery(raw: unknown, validIds: Set<string>, pins: ResearchSkillPin[]): ResearchDelivery {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('DELIVERY_INVALID');
  const v = raw as Record<string, unknown>;
  const text = (s: unknown, max = 6000): string => { if (typeof s !== 'string' || !s.trim() || s.length > max) throw new Error('DELIVERY_INVALID'); return s.trim(); };
  const strings = (s: unknown, max = 12): string[] => { if (!Array.isArray(s) || s.length > max) throw new Error('DELIVERY_INVALID'); return s.map(x => text(x, 2000)); };
  const evidenceIds = strings(v.evidenceIds, 20);
  const gaps = strings(v.gaps);
  if (evidenceIds.some(id => !validIds.has(id)) || (!evidenceIds.length && !gaps.length)) throw new Error('DELIVERY_CITATION_INVALID');
  if (!Array.isArray(v.skillVersions) || v.skillVersions.length !== pins.length || pins.some(pin =>
    !(v.skillVersions as Record<string, unknown>[]).some(s => s.id === pin.id && s.version === pin.version && s.hash === pin.hash))) throw new Error('DELIVERY_SKILL_VERSION_INVALID');
  const asOf = text(v.asOf, 40);
  if (!Number.isFinite(Date.parse(asOf))) throw new Error('DELIVERY_DATE_INVALID');
  const response = v.response as Record<string, unknown> | undefined;
  if (!response || typeof response !== 'object') throw new Error('DELIVERY_RESPONSE_INVALID');
  if (v.currency !== null && (typeof v.currency !== 'string' || !/^[A-Z]{3}$/.test(v.currency))) throw new Error('DELIVERY_CURRENCY_INVALID');
  let thesisCandidates: ResearchDelivery['thesisCandidates'];
  if (v.thesisCandidates !== undefined) {
    if (!Array.isArray(v.thesisCandidates) || !v.thesisCandidates.length || v.thesisCandidates.length > 5) throw new Error('DELIVERY_THESIS_INVALID');
    thesisCandidates = v.thesisCandidates.map(candidate => {
      const parsed = thesisCandidateSchema.safeParse(candidate);
      if (!parsed.success) throw new Error('DELIVERY_THESIS_INVALID');
      if (!validateThesisReferences(parsed.data, validIds)) throw new Error('DELIVERY_CITATION_INVALID');
      return { ...normalizeThesisContent(parsed.data, 'agent'), ...(parsed.data.expiresAt !== undefined ? { expiresAt: parsed.data.expiresAt } : {}) };
    });
  }
  return { conclusion: text(v.conclusion), evidenceIds, asOf, currency: v.currency as string | null, units: text(v.units, 100),
    ...(thesisCandidates ? { thesisCandidates } : {}),
    ...(['positive', 'balanced', 'cautious'].includes(String(v.researchStance))
      ? { researchStance: v.researchStance as ResearchDelivery['researchStance'] } : {}),
    assumptions: strings(v.assumptions), gaps, skillVersions: pins.map(({ id, version, hash }) => ({ id, version, hash })),
    response: { thesis: text(response.thesis), evidencePoints: strings(response.evidencePoints), risks: strings(response.risks),
      nextChecks: strings(response.nextChecks), ...(response.details ? { details: text(response.details, 20000) } : {}) } };
}
