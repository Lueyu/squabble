import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentContribution } from './council.native';
import { normalizeBuilderConfig, normalizeCouncil } from '../paper-trading/agent-builder.rules';
import { AgentBuilderService } from '../paper-trading/agent-builder.service';
import type { CouncilMember } from '../../../shared/council.interface';
import type { NativeAgentConfiguration } from '../../../shared/local-agents.interface';
import { BadRequestException } from '@nestjs/common';
import { CouncilService } from './council.service';
import { LocalAgentError } from '../local-agents/local-agents.types';

const members: CouncilMember[] = [
  { id: 'researcher', name: 'Researcher', role: 'researcher', instructions: '', model: 'fast', executionMode: 'local', agentId: 'local-research' },
  { id: 'manager', name: 'Manager', role: 'manager', instructions: '', model: 'slow', executionMode: 'local', agentId: 'local-review' },
];
const config = () => normalizeBuilderConfig({ name: 'Delegated team', template: 'guard', tickers: ['AAPL'],
  minimumRating: 'Buy', maxOrderPct: 5, maxOrdersPerDay: 1, dailyLossLimitPct: 3, customPrompt: '',
  notifyOnProposal: false, council: { enabled: true, members } });

test('council normalization preserves native routing and rejects endpoint or shell-like IDs', () => {
  const normalized = normalizeCouncil({ enabled: true, members });
  assert.equal(normalized.members[0].executionMode, 'local');
  assert.equal(normalized.members[0].agentId, 'local-research');
  for (const id of ['', 'http://127.0.0.1:9000', '../agent', 'agent;command', 'x'.repeat(65)]) {
    assert.throws(() => normalizeCouncil({ enabled: true, members: [{ ...members[0], agentId: id }, members[1]] }), /registered local agent/);
  }
});

test('council profiles preserve each native member configuration and reject invalid overrides', () => {
  const agentSettings = { model: 'fixture/model', reasoningEffort: 'high' };
  const configured = { ...members[0], agentSettings };
  const normalized = normalizeCouncil({ enabled: true, members: [configured, members[1]] });
  assert.deepEqual(normalized.members[0].agentSettings, agentSettings);
  assert.notEqual(normalized.members[0].agentSettings, agentSettings, 'snapshot must not alias editable input');
  assert.equal(normalized.members[1].agentSettings, undefined);
  for (const invalid of [null, [], { model: 42 }, { model: '' }, { model: 'x'.repeat(161) },
    { reasoningEffort: 'x'.repeat(33) }, { reasoningEffort: 'high\n' }, { command: 'other' }]) {
    assert.throws(() => normalizeCouncil({ enabled: true,
      members: [{ ...configured, agentSettings: invalid as NativeAgentConfiguration }, members[1]] }), /LOCAL_INVALID_CONFIGURATION/);
  }
  assert.throws(() => normalizeCouncil({ enabled: true,
    members: [{ ...configured, executionMode: 'model' }, members[1]] }), /Native agent settings require local execution/);
});

test('builder activation validates each members native model settings against its connected runtime', async () => {
  const configured = config();
  const agentSettings = { model: 'fixture/model', reasoningEffort: 'high' };
  configured.council!.members[0].agentSettings = agentSettings;
  const validated: Array<NativeAgentConfiguration | undefined> = [];
  const service = new AgentBuilderService(null as never, {
    validateConnectionIds: async () => undefined,
  } as never, {
    validate: async (_owner: string, _id: string, settings?: NativeAgentConfiguration) => { validated.push(settings); },
  } as never, { getSettings: async () => ({ enabled: true }) } as never);
  await service.assertCanActivate('alice', configured);
  assert.deepEqual(validated, [agentSettings, undefined]);
});

test('native configuration preflight errors remain actionable HTTP errors for research and activation', async () => {
  const llm = { validateConnectionIds: async () => undefined };
  for (const code of ['LOCAL_INVALID_CONFIGURATION', 'LOCAL_CONFIGURATION_UNSUPPORTED']) {
    const agents = { validate: async () => { throw new LocalAgentError(code); } };
    const builder = new AgentBuilderService(null as never, llm as never, agents as never);
    const council = new CouncilService(null as never, llm as never, null as never, null as never,
      null as never, agents as never);
    const publicError = (error: unknown) => error instanceof BadRequestException
      && error.getStatus() === 400 && error.message === code;
    await assert.rejects(builder.assertCanActivate('alice', config()), publicError);
    await assert.rejects(council.createSession('alice', { ticker: 'AAPL', members }), publicError);
  }
});

test('external artifacts preserve unverified provenance and reject unsafe source URLs', () => {
  const output = agentContribution({ text: '', data: { content: 'Research with sources', evidenceIds: [],
    sources: [
      { title: 'Issuer filing', url: 'https://www.sec.gov/Archives/issuer', content: 'Filing excerpt' },
      { title: 'Credentials', url: 'https://user:secret@example.org/report', content: 'Do not publish' },
      { title: 'Script', url: 'javascript:alert(1)', content: 'Do not publish' },
      { title: 'File', url: 'file:///etc/passwd', content: 'Do not publish' },
    ] } }, [], { memberId: 'researcher', phase: 'opening' }, null);
  assert.equal(output.sources.length, 1);
  assert.match(output.sources[0].title, /Agent source.*unverified/);
  assert.equal(output.sources[0].sourceName, 'Native agent · unverified');
  assert.equal(output.sources[0].relevanceScore, 0);
  assert.equal(output.sources[0].sourceUrl, 'https://www.sec.gov/Archives/issuer');
  assert.deepEqual(output.contribution.evidenceIds, [output.sources[0].id]);
});

test('external artifacts cannot change candidate direction, size, price, or ticker', () => {
  const candidate = { ticker: 'AAPL', side: 'buy' as const, quantity: 2, price: 100, reason: 'fixture' };
  for (const key of ['ticker', 'side', 'quantity', 'price', 'candidate']) {
    assert.throws(() => agentContribution({ text: '', data: { content: 'Approve', evidenceIds: [],
      decision: 'approve', [key]: 'changed', sources: [] } }, [], { memberId: 'manager', phase: 'summary' }, candidate), /cannot change/);
  }
});

test('native builder activation validates owned agents without a model key while model budgets stay enabled', async () => {
  const validated: string[][] = [];
  const service = new AgentBuilderService(null as never, {
    validateConnectionIds: async (_owner: string, ids: string[]) => assert.deepEqual(ids, []),
    isConfigured: async () => { throw new Error('Native activation must not require a model key'); },
  } as never, {
    validate: async (owner: string, id: string) => { validated.push([owner, id]); },
  } as never, { getSettings: async () => ({ enabled: true }) } as never);
  await service.assertCanActivate('alice', config());
  assert.deepEqual(validated, [['alice', 'local-research'], ['alice', 'local-review']]);
});

test('native builder activation permits model budgets but rejects foreign agent connections', async () => {
  const noModels = { validateConnectionIds: async () => undefined,
    isConfigured: async () => { throw new Error('Unexpected model check'); } };
  const budgeted = new AgentBuilderService(null as never, noModels as never,
    { validate: async () => undefined } as never, { getSettings: async () => ({ enabled: true }) } as never);
  await budgeted.assertCanActivate('alice', config());
  const foreign = new AgentBuilderService(null as never, noModels as never,
    { validate: async () => { throw new Error('LOCAL_AGENT_NOT_FOUND'); } } as never,
    { getSettings: async () => ({ enabled: true }) } as never);
  await assert.rejects(() => foreign.assertCanActivate('bob', config()), /LOCAL_AGENT_NOT_FOUND/);
});
