import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { AGENT_TEMPLATE_IDS, LEGACY_AGENT_TEMPLATE_IDS } from '../../../shared/agent-roster.interface';
import { AGENT_SPECIALTY_CATALOG } from '../../../shared/agent-specialty-catalog';
import { ANIMAL_AVATAR_IDS } from '../../../shared/animal-avatar';
import { RESEARCH_TOOLS } from '../research-tools/research-tools.registry';

const GUIDE_KEYS = ['strengths', 'requiredInputs', 'workflow', 'outputSections', 'counterchecks', 'unknownHandling', 'exampleTasks', 'recommendedSeats'] as const;

test('twelve honest editable templates preserve their scope ceiling and native connector identity', async () => {
  assert.ok(existsSync('server/modules/agent-roster/agent-roster.rules.ts'), 'persistent agent capability rules must exist');
  const { AGENT_TEMPLATES, prepareAgent, snapshotMember, assertCeiling } = await import('./agent-roster.rules');
  assert.deepEqual(AGENT_TEMPLATES.map(t => t.id), [...AGENT_TEMPLATE_IDS]);
  assert.equal(AGENT_TEMPLATES.length, 12);
  const agent = prepareAgent({ templateId: 'bear', description: '请核对周期高点和现金流', executor: { executionMode: 'local', localAgentId: 'native-codex' } });
  assert.match(agent.config.instructions, /请核对周期高点和现金流/);
  assert.deepEqual(agent.config.allowedSources, []);
  assert.ok(agent.config.allowedToolIds.includes('get_discussion_context'));
  assert.ok(agent.config.allowedToolIds.includes('get_news'));
  assert.deepEqual(prepareAgent({ executor: { executionMode: 'model', model: 'slow' }, allowedToolIds: [] }).config.allowedToolIds, []);
  assert.doesNotThrow(() => assertCeiling([], ['get_financials'], [], ['builtin:get_financials']));
  const member = snapshotMember({ id: 'stable-person', name: '反方', currentVersionId: 'version-1' }, { id: 'version-1', config: agent.config }, { agentId: 'stable-person', agentVersionId: 'version-1', memberId: 'seat-1' });
  assert.equal(member.rosterAgentId, 'stable-person');
  assert.equal(member.rosterAgentVersionId, 'version-1');
  assert.equal(member.agentId, 'native-codex');
  assert.equal(member.id, 'seat-1');
  const defaultSeat = snapshotMember({ id: '01234567-89ab-4def-8123-0123456789ab', name: 'Stable', currentVersionId: 'version-1' }, { id: 'version-1', config: agent.config }, { agentId: '01234567-89ab-4def-8123-0123456789ab', agentVersionId: 'version-1' });
  assert.ok(defaultSeat.id.length <= 32, 'the internal seat ID must fit retained Council member identity bounds');
  assert.equal(defaultSeat.rosterAgentId, '01234567-89ab-4def-8123-0123456789ab');
});

test('capability validation rejects credentials, unexpected configuration and forged unavailable source claims', async () => {
  assert.ok(existsSync('server/modules/agent-roster/agent-roster.rules.ts'), 'persistent agent capability rules must exist');
  const { parseCreate, assertCeiling } = await import('./agent-roster.rules');
  const base = { requestKey: 'test-create', executor: { executionMode: 'model', model: 'slow' } };
  assert.throws(() => parseCreate({ ...base, executor: { ...base.executor, apiKey: 'secret' } }));
  assert.throws(() => parseCreate({ ...base, preferences: { hiddenPrompt: 'secret' } }));
  assert.throws(() => parseCreate({ ...base, executor: { executionMode: 'local', localAgentId: 'native-codex', settings: { model: 'one\ntwo' } } }), 'native model configuration must reject control characters before persistence');
  assert.throws(() => assertCeiling([], [], [{ kind: 'document_version', id: 'source', revision: '1', availability: 'available' }], []));
  assert.throws(() => assertCeiling([], [], [], ['unapproved-tool']));
});

test('animal identity is validated independently and frozen across role changes', async () => {
  const { parseCreate, prepareAgent, snapshotMember } = await import('./agent-roster.rules');
  const input = { requestKey: 'animal', avatar: 'news', executor: { executionMode: 'model' as const, model: 'slow' as const } };
  assert.equal(parseCreate(input).avatar, 'news');
  assert.throws(() => parseCreate({ ...input, avatar: 'untrusted-image-url' }));
  const prepared = prepareAgent(input);
  assert.equal(prepared.avatar, 'news');
  const profile = { id: 'friend', name: 'Friend', currentVersionId: 'v1', avatar: 'news' as const };
  const version = { id: 'v1', config: prepared.config };
  assert.equal(snapshotMember(profile, version, { agentId: 'friend', agentVersionId: 'v1', role: 'manager' }).avatar, 'news');
  assert.equal(snapshotMember(profile, version, { agentId: 'friend', agentVersionId: 'v1', role: 'challenger' }).avatar, 'news');
});

test('English template defaults persist English identity, work instructions and preferences', async () => {
  const { prepareAgent } = await import('./agent-roster.rules');
  const prepared = prepareAgent({ templateId: 'financials', executor: { executionMode: 'model', model: 'slow' }, preferences: { language: 'en' } });
  assert.equal(prepared.name, 'Financials friend');
  assert.match(prepared.config.instructions, /cash flow/u);
  assert.equal(prepared.config.preferences.language, 'en');
  assert.equal(prepared.avatar, 'technical');
});

test('every new specialty is accepted by create parsing and every unknown id is rejected', async () => {
  const { parseCreate, templateId } = await import('./agent-roster.rules');
  const base = { requestKey: 'new-specialty', executor: { executionMode: 'model', model: 'slow' } };
  for (const id of ['business', 'industry', 'growth', 'macro', 'events', 'quantitative', 'portfolio']) {
    assert.equal(parseCreate({ ...base, templateId: id }).templateId, id, `new preset ${id} must parse`);
  }
  assert.throws(() => parseCreate({ ...base, templateId: 'goldbug' }), 'unknown preset id must be rejected');
  assert.equal(templateId.safeParse('quantitative').success, true);
  assert.equal(templateId.safeParse('moderator').success, true);
});

test('legacy omission keeps exactly the original five presets for old clients', async () => {
  const { LEGACY_AGENT_TEMPLATE_IDS: legacy } = await import('./agent-roster.rules');
  assert.deepEqual(legacy, ['financials', 'valuation', 'bear', 'risk', 'moderator']);
  assert.deepEqual(LEGACY_AGENT_TEMPLATE_IDS, legacy);
  assert.ok(LEGACY_AGENT_TEMPLATE_IDS.every(id => AGENT_TEMPLATE_IDS.includes(id)));
  assert.deepEqual(AGENT_TEMPLATE_IDS.slice(0, 5), LEGACY_AGENT_TEMPLATE_IDS);
});

test('recommended addition accepts one through twelve distinct preset ids and rejects more or duplicates', async () => {
  const { parseRoster, recommendedSchema } = await import('./agent-roster.rules');
  const base = { requestKey: 'recommended-batch', executor: { executionMode: 'model', model: 'slow' } };
  assert.doesNotThrow(() => parseRoster(recommendedSchema, { ...base, templateIds: [...AGENT_TEMPLATE_IDS] }));
  assert.doesNotThrow(() => parseRoster(recommendedSchema, { ...base, templateIds: ['quantitative'] }));
  assert.throws(() => parseRoster(recommendedSchema, { ...base, templateIds: ['business', 'business'] }), 'duplicate ids must be rejected');
  assert.throws(() => parseRoster(recommendedSchema, { ...base, templateIds: [...AGENT_TEMPLATE_IDS, 'business'] }), 'thirteen ids must exceed the twelve-id bound');
  assert.throws(() => parseRoster(recommendedSchema, { ...base, templateIds: ['not-a-template'] }));
});

test('the specialty catalog is complete, bilingual, registry-backed and compute-free', async () => {
  const registered = new Set(RESEARCH_TOOLS.map(tool => tool.name));
  const computeTools = new Set(RESEARCH_TOOLS.filter(tool => tool.effect === 'compute').map(tool => tool.name));
  assert.deepEqual(AGENT_SPECIALTY_CATALOG.map(t => t.id), [...AGENT_TEMPLATE_IDS]);
  for (const template of AGENT_SPECIALTY_CATALOG) {
    assert.ok(ANIMAL_AVATAR_IDS.includes(template.avatar), `${template.id} avatar must be a legal animal id`);
    assert.ok(template.name.endsWith('股友'), `${template.id} Chinese name must end with 股友`);
    assert.ok(template.nameEn.endsWith('friend'), `${template.id} English name must end with friend`);
    assert.match(template.instructions, /有明确范围的投资研究/u, `${template.id} must embed the Chinese common constraints`);
    assert.match(template.instructionsEn, /bounded investment research/u, `${template.id} must embed the English common constraints`);
    assert.ok(template.instructions.length < 16000, `${template.id} Chinese instructions must fit the ceiling`);
    assert.ok(template.instructionsEn.length < 16000, `${template.id} English instructions must fit the ceiling`);
    assert.ok(template.instructions.includes('\n\n'), `${template.id} instructions must append the specialty body after the common constraints`);
    for (const key of GUIDE_KEYS) {
      assert.ok(template.guide[key].length > 0, `${template.id} zh guide.${key} must not be empty`);
      assert.ok(template.guideEn[key].length > 0, `${template.id} en guide.${key} must not be empty`);
      assert.equal(template.guide[key].length, template.guideEn[key].length, `${template.id} guide.${key} must correspond across languages`);
    }
    assert.ok(template.allowedToolIds.length > 0, `${template.id} must have a default tool ceiling`);
    assert.equal(new Set(template.allowedToolIds).size, template.allowedToolIds.length, `${template.id} tool list must be de-duplicated`);
    for (const tool of template.allowedToolIds) {
      assert.ok(registered.has(tool), `${template.id} default tool ${tool} must exist in the research registry`);
      assert.ok(!computeTools.has(tool), `${template.id} must not default compute tools such as ${tool}`);
    }
    assert.equal(template.allowedToolIds.includes('run_statistics'), false);
    assert.equal(template.allowedToolIds.includes('run_backtest'), false);
  }
});

test('specialty default ceilings follow the §6 mapping', async () => {
  const { AGENT_TEMPLATES } = await import('./agent-roster.rules');
  const byId = Object.fromEntries(AGENT_TEMPLATES.map(t => [t.id, t]));
  const c = ['get_discussion_context', 'get_research_memory'];
  const l = ['search_data_library', 'read_dataset_summary'];
  const f = ['get_financials'];
  const p = ['get_portfolio_quotes', 'get_portfolio_financials'];
  const d = ['get_financial_source_data'];
  const q = ['get_quotes'];
  const v = ['get_valuation', 'get_peer_comparison', 'get_valuation_scenarios'];
  const n = ['get_news'];
  const expected = {
    financials: [...c, ...l, ...f, ...p, ...d, ...q],
    valuation: [...c, ...l, ...f, ...p, ...d, ...q, ...v],
    bear: [...c, ...l, ...f, ...q, ...n, 'get_valuation', 'get_portfolio_quotes'],
    risk: [...c, ...l, ...f, ...p, ...q, ...n],
    moderator: [...c],
    business: [...c, ...l, ...f, ...n, ...d, 'get_peer_comparison'],
    industry: [...c, ...l, ...f, ...n, ...d, 'get_peer_comparison'],
    growth: [...c, ...l, ...f, ...n, ...d, 'get_peer_comparison', 'get_valuation_scenarios'],
    macro: [...c, ...l, ...p, ...n],
    events: [...c, ...l, ...n, ...f, ...q],
    quantitative: [...c, ...l, ...q, ...d, 'get_portfolio_quotes'],
    portfolio: [...c, ...l, ...f, ...p, ...q, ...n, 'get_valuation', 'get_peer_comparison'],
  };
  for (const [id, tools] of Object.entries(expected)) {
    assert.deepEqual(new Set(byId[id].allowedToolIds), new Set(tools), `${id} default ceiling must match §6`);
  }
});
