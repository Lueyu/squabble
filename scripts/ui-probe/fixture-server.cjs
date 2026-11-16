'use strict';

// Serves only a local build and fictional, process-local HTTP state. This module
// imports no server application code and has no upstream transport.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const templates = require('./agent-templates.json');
const createFixtureSupport = require('./fixture-support.cjs');

const FIXED_TIME = '2026-11-13T01:00:00.000Z';
const defaultDist = path.resolve(__dirname, '../../dist/client');
const executor = {
  executionMode: 'model', connectionId: '11111111-1111-4111-8111-111111111111', model: 'fast',
};

function agentDraft(input = {}) {
  const template = templates.find(item => item.id === (input.templateId || 'financials'));
  const english = input.preferences?.language === 'en';
  return {
    name: input.name ?? template[english ? 'nameEn' : 'name'],
    specialty: input.specialty ?? template[english ? 'specialtyEn' : 'specialty'],
    description: input.description ?? template[english ? 'descriptionEn' : 'description'],
    avatar: input.avatar ?? template.avatar,
    config: {
      schemaVersion: 1, templateId: template.id,
      instructions: input.instructions ?? template[english ? 'instructionsEn' : 'instructions'],
      executor: input.executor ?? executor, allowedToolIds: template.allowedToolIds,
      allowedSources: [], preferences: { language: 'zh-CN', responseStyle: 'concise', userPreferences: '', ...input.preferences },
    },
  };
}

function createServer(options = {}) {
  const dist = path.resolve(options.dist || defaultDist);
  const support = createFixtureSupport();
  const requests = [];
  const unknown = [];
  const agents = templates.map((template, index) => {
    const suffix = String(index + 1).padStart(12, '0');
    const id = '22222222-2222-4222-8222-' + suffix;
    const draft = agentDraft({ templateId: template.id });
    const versionId = '33333333-3333-4333-8333-' + suffix;
    return {
      id, ...draft, status: 'active', availability: 'configured', revision: 1,
      createdAt: FIXED_TIME, updatedAt: FIXED_TIME, currentVersionId: versionId,
      currentVersion: { id: versionId, agentId: id, version: 1, config: draft.config, capabilityHash: 'a'.repeat(64), createdAt: FIXED_TIME },
    };
  });
  const holding = { id: 1, ticker: 'DEMO', name: '示例公司（虚构）', market: 'US', currency: 'USD', shares: '100', quantity: '100', costPrice: '20', costBasis: '20', lastPrice: '22', marketValue: '2200', unrealizedPnl: '200', unrealizedPnlPct: '10', updatedAt: FIXED_TIME, availableShares: '100' };
  const cash = [{ id: 1, currency: 'USD', balance: '10000', total: '10000', available: '10000', reconciliationStatus: 'confirmed', updatedAt: FIXED_TIME }];
  const mark = { valueUsd: 12200, basis: 'total_assets', holdingsValueUsd: 2200, cashValueUsd: 10000, complete: true, asOf: FIXED_TIME, readAt: FIXED_TIME, pricing: 'saved_prices', coveredPositions: 1, totalPositions: 1, gaps: [] };
  const seed = { previewId: '44444444-4444-4444-8444-444444444444', previewHash: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00Z', needsInput: [], markets: ['US'], seed: { positions: [], cash: [{ currency: 'USD', total: '10000', available: '10000' }], capturedAt: FIXED_TIME }, sourceHash: 'c'.repeat(64), gaps: [] };
  // Fictional classic organization reused by every fixture team: four seats mapped to the
  // twelve-template roster (portfolio lead, financials, business, bear), two departments,
  // the documented reporting/request/review wiring and a full work blueprint.
  const teamUuid = n => 'c0000000-0000-4000-8000-' + String(n).padStart(12, '0');
  const seatAgent = templateId => agents.find(item => item.currentVersion.config.templateId === templateId);
  const teamRoles = [teamUuid(1), teamUuid(2), teamUuid(3), teamUuid(4)].map((id, index) => {
    const spec = [{ template: 'portfolio', dept: null, responsibility: 'Lead the investment thesis', output: 'Final thesis and conditions' },
      { template: 'financials', dept: teamUuid(10), responsibility: 'Verify cash flow and accounting', output: 'Accounting bridge and cash-flow evidence' },
      { template: 'business', dept: teamUuid(10), responsibility: 'Explain the business and moat', output: 'Business evidence and counterevidence' },
      { template: 'bear', dept: teamUuid(11), responsibility: 'Challenge the strongest claim', output: 'Strongest counterevidence and unknowns' }][index];
    const friend = seatAgent(spec.template);
    return { id, departmentId: spec.dept, participation: 'enabled', responsibility: spec.responsibility, expectedOutput: spec.output,
      executor: { executionMode: 'model', connectionId: executor.connectionId, model: 'fast', settings: {} },
      agentId: friend.id, agentVersionId: friend.currentVersionId, allowedToolIds: friend.currentVersion.config.allowedToolIds, sourceGrantIds: [] };
  });
  const teamConfig = {
    schemaVersion: 1,
    departments: [
      { id: teamUuid(10), parentDepartmentId: null, purpose: '投资研究 / Investment research' },
      { id: teamUuid(11), parentDepartmentId: null, purpose: '风险检查 / Independent challenge' },
    ],
    roles: teamRoles,
    relations: [
      { id: teamUuid(100), fromRoleId: teamRoles[1].id, toRoleId: teamRoles[0].id, kind: 'reports_to', responsibilityScope: '关键财务风险' },
      { id: teamUuid(101), fromRoleId: teamRoles[1].id, toRoleId: teamRoles[2].id, kind: 'reports_to', responsibilityScope: '口径依据' },
      { id: teamUuid(102), fromRoleId: teamRoles[2].id, toRoleId: teamRoles[0].id, kind: 'reports_to', responsibilityScope: '基本面结论' },
      { id: teamUuid(103), fromRoleId: teamRoles[3].id, toRoleId: teamRoles[0].id, kind: 'reports_to', responsibilityScope: '反证结论' },
      { id: teamUuid(104), fromRoleId: teamRoles[0].id, toRoleId: teamRoles[1].id, kind: 'delegates_to', responsibilityScope: '财务请求' },
      { id: teamUuid(105), fromRoleId: teamRoles[0].id, toRoleId: teamRoles[2].id, kind: 'delegates_to', responsibilityScope: '基本面请求' },
      { id: teamUuid(106), fromRoleId: teamRoles[0].id, toRoleId: teamRoles[3].id, kind: 'delegates_to', responsibilityScope: '反证请求' },
      { id: teamUuid(107), fromRoleId: teamRoles[3].id, toRoleId: teamRoles[1].id, kind: 'reviews', responsibilityScope: '核查最强反证' },
      { id: teamUuid(108), fromRoleId: teamRoles[0].id, toRoleId: teamRoles[2].id, kind: 'reviews', responsibilityScope: '基本面复核' },
      { id: teamUuid(109), fromRoleId: teamRoles[0].id, toRoleId: teamRoles[3].id, kind: 'reviews', responsibilityScope: '反证复核' },
      { id: teamUuid(110), fromRoleId: teamRoles[3].id, toRoleId: teamRoles[0].id, kind: 'reviews', responsibilityScope: '最终结论复核' },
    ],
    defaults: { leadRoleId: teamRoles[0].id, parallelism: 1 },
    workBlueprint: {
      schemaVersion: 1,
      works: [
        { workId: 'financials', roleId: teamRoles[1].id, taskKind: 'financials', objective: '核对会计桥', expectedOutput: '现金流桥接与未知项', dependencyWorkIds: [], reviewerRoleId: teamRoles[3].id, reviewMode: 'independent' },
        { workId: 'business', roleId: teamRoles[2].id, taskKind: 'business', objective: '检验商业模式', expectedOutput: '基本面证据', dependencyWorkIds: ['financials'], reviewerRoleId: teamRoles[0].id, reviewMode: 'independent' },
        { workId: 'challenge', roleId: teamRoles[3].id, taskKind: 'challenge', objective: '寻找最强反证', expectedOutput: '反证与未知项', dependencyWorkIds: ['financials', 'business'], reviewerRoleId: teamRoles[0].id, reviewMode: 'independent' },
      ],
      summary: { reviewerRoleId: teamRoles[3].id, reviewMode: 'independent', expectedOutput: '综合结论、分歧、行动或等待理由及再核查条件' },
    },
  };
  const teamDisplay = { name: '经典投研团队（虚构）', avatar: null, departmentLabels: { [teamUuid(10)]: '投资研究部', [teamUuid(11)]: '风险检查部' },
    roleLabels: { [teamRoles[0].id]: '投资负责人', [teamRoles[1].id]: '财报专家', [teamRoles[2].id]: '基本面研究员', [teamRoles[3].id]: '反方研究员' } };
  const teamLayout = { schemaVersion: 1,
    positions: { [teamRoles[0].id]: { x: 620, y: 24 }, [teamUuid(10)]: { x: 30, y: 210, width: 528, height: 260 }, [teamUuid(11)]: { x: 600, y: 210, width: 528, height: 260 },
      [teamRoles[1].id]: { x: 24, y: 72 }, [teamRoles[2].id]: { x: 272, y: 72 }, [teamRoles[3].id]: { x: 24, y: 72 } },
    collapsedDepartmentIds: [], viewport: { x: 0, y: 0, zoom: 0.8 } };
  const teamId = 'aaaaaa00-0000-4000-8000-000000000001';
  let teamState = { semanticRevision: 2, display: teamDisplay, layout: teamLayout, config: teamConfig };
  function teamDetail() {
    return { id: teamId, status: 'active', createdAt: FIXED_TIME, updatedAt: FIXED_TIME, display: teamState.display,
      layout: teamState.layout, capabilities: { workspaceEnabled: true, researchEnabled: true },
      draft: { semanticRevision: teamState.semanticRevision, baseVersionId: null, config: teamState.config },
      publishedVersion: null, binding: null };
  }
  function teamSummary() {
    const roles = teamState.config.roles, departments = teamState.config.departments;
    return { id: teamId, name: teamState.display.name, status: 'active', description: '', currentVersionId: null, bindingAccountId: null,
      draftRevision: teamState.semanticRevision, semanticRevision: teamState.semanticRevision, createdAt: FIXED_TIME, updatedAt: FIXED_TIME,
      display: teamState.display, layout: teamState.layout,
      counts: { roles: roles.length, departments: departments.length, connections: roles.filter(role => role.executor).length },
      connectionStatus: 'mixed', cost: null };
  }
  const emptyPage = () => ({ items: [], total: 0, nextCursor: null });
  const cannedPreview = previewId => ({ previewId, previewHash: 'e'.repeat(64), expiresAt: '2099-01-01T00:00:00Z', compilerVersion: 'team-plan-v3-work-blueprint',
    guards: { semanticRevision: teamState.semanticRevision, currentVersionId: null, bindingRevision: 0, bindingId: null, scopeRevision: 0,
      accountPolicyRevision: null, accountAssignmentRevision: null, capabilityFingerprint: null, sourceFingerprints: [], executorFingerprints: {} },
    result: { config: teamState.config, displaySnapshot: teamState.display, semanticRevision: teamState.semanticRevision, semanticHash: 'f'.repeat(64) }, warnings: [] });
  function answer(res, status, data) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }
  function api(req, res, url, body) {
    const p = url.pathname;
    const m = req.method;
    requests.push({ method: m, path: p });
    // Probe states are read-only. A synthetic POST preview and local team-draft
    // edits are the only allowed non-GET requests; no scan can start research,
    // AI work, imports or trading.
    const teamEdit = p.startsWith('/api/teams/') && (m === 'PUT' || m === 'PATCH' || m === 'POST');
    if (m !== 'GET' && !(m === 'POST' && p === '/api/ai-investment/preview') && !teamEdit) {
      return answer(res, 405, { error: { code: 'UI_FIXTURE_READ_ONLY' } });
    }
    if (support({ answer, agents, seed, requests, holdings: [holding] }, req, res, url, body)) return;
    if (p === '/api/auth/mode') return answer(res, 200, { mode: 'local' });
    if (p === '/api/health') return answer(res, 200, { status: 'ok' });
    if (p === '/api/experience/preferences') return answer(res, 200, { enabled: true });
    if (p === '/api/agent-roster/templates') return answer(res, 200, { items: templates });
    if (p === '/api/agent-roster') return answer(res, 200, { items: agents, total: agents.length, nextCursor: null });
    const friend = p.match(/^\/api\/agent-roster\/([^/]+)$/);
    if (friend) return answer(res, 200, agents.find(item => item.id === friend[1]) || null);
    // Fictional teams module: one classic organization editable in memory only.
    if (p === '/api/teams' && m === 'GET') return answer(res, 200, { items: [teamSummary()], total: 1, nextCursor: null });
    const teamDetailRoute = p.match(/^\/api\/teams\/([^/]+)$/);
    if (teamDetailRoute && m === 'GET') return answer(res, 200, teamDetail());
    const teamSave = p.match(/^\/api\/teams\/([^/]+)\/(draft|display|layout)$/);
    if (teamSave && m === 'PUT' || teamSave && m === 'PATCH') {
      if (body && body.config) teamState = { ...teamState, config: body.config, semanticRevision: teamState.semanticRevision + 1 };
      if (body && body.display) teamState = { ...teamState, display: body.display };
      if (body && body.layout) teamState = { ...teamState, layout: body.layout };
      return answer(res, 200, teamDetail());
    }
    if (p === '/api/teams/' + teamId + '/work-plan-preview' && m === 'POST') {
      return answer(res, 200, {
        mode: 'blueprint_v1', baseSemanticRevision: teamState.semanticRevision, semanticHash: 'f'.repeat(64),
        blueprintHash: 'g'.repeat(64), compilerVersion: 'team-work-blueprint-v1', structurallyValid: true, dispatchable: false,
        leadRoleId: teamRoles[0].id, participantRoleIds: teamRoles.map(role => role.id),
        minimumCallCount: 8, nonParticipatingRoleIds: [], unusedReviewRelationIds: [], issues: [], warnings: [],
        work: [
          { workKey: 'financials', roleId: teamRoles[1].id, taskKind: 'financials', objective: '核对会计桥', expectedOutput: '现金流桥接与未知项', dependencyWorkKeys: [], reviewerRoleId: teamRoles[3].id, reviewMode: 'independent', inputRefs: [], requestedByRoleIds: [teamRoles[0].id] },
          { workKey: 'business', roleId: teamRoles[2].id, taskKind: 'business', objective: '检验商业模式', expectedOutput: '基本面证据', dependencyWorkKeys: ['financials'], reviewerRoleId: teamRoles[0].id, reviewMode: 'independent', inputRefs: [], requestedByRoleIds: [teamRoles[0].id] },
          { workKey: 'challenge', roleId: teamRoles[3].id, taskKind: 'challenge', objective: '寻找最强反证', expectedOutput: '反证与未知项', dependencyWorkKeys: ['business', 'financials'], reviewerRoleId: teamRoles[0].id, reviewMode: 'independent', inputRefs: [], requestedByRoleIds: [teamRoles[0].id] },
          { workKey: 'summary', roleId: teamRoles[0].id, taskKind: 'summary', objective: '综合结论', expectedOutput: '综合结论、分歧、行动或等待理由及再核查条件', dependencyWorkKeys: ['business', 'challenge', 'financials'], reviewerRoleId: teamRoles[3].id, reviewMode: 'independent', inputRefs: [], requestedByRoleIds: [teamRoles[0].id] },
        ],
        requestKey: body?.requestKey,
      });
    }
    if (p === '/api/teams/' + teamId + '/publish-preview' && m === 'POST') return answer(res, 200, cannedPreview('publish'));
    if (p === '/api/teams/' + teamId + '/publish' && m === 'POST') return answer(res, 200, { version: { id: 'e'.repeat(36), teamId, version: 1, semanticRevision: teamState.semanticRevision, semanticHash: 'f'.repeat(64), config: teamState.config, displaySnapshot: teamState.display, createdAt: FIXED_TIME }, team: teamDetail(), requestKey: body?.requestKey });
    if (p === '/api/teams/' + teamId + '/source-grants' && m === 'GET') return answer(res, 200, emptyPage());
    if (p === '/api/teams/' + teamId + '/decisions' && m === 'GET') return answer(res, 200, emptyPage());
    if (p === '/api/teams/' + teamId + '/commissions' && m === 'GET') return answer(res, 200, emptyPage());
    if (p === '/api/teams/' + teamId + '/versions' && m === 'GET') return answer(res, 200, emptyPage());
    if (p === '/api/team-runs/' + teamId) return answer(res, 200, { agreement: null, recentCycles: [] });
    if (p === '/api/settings/model-connections') return answer(res, 200, { items: [{ id: executor.connectionId, name: '演示连接（虚构）', available: true, hasApiKey: true, fastModel: 'fictional-fast', slowModel: 'fictional-slow', provider: 'openai-compatible' }] });
    if (p === '/api/settings/integrations') return answer(res, 200, {
      llm: { source: 'builtin', engine: 'basic', available: true, hasApiKey: false, needsReentry: false,
        baseUrl: '', fastModel: '', slowModel: '', maskedApiKey: '', route: { mode: 'basic' } },
      financial: { provider: 'public', source: 'builtin', available: true,
        hasApiKey: false, needsReentry: false, maskedApiKey: '' },
    });
    if (p === '/api/settings/local-agents' || p === '/api/a2a-agents') return answer(res, 200, { items: [] });
    if (p === '/api/data-library/sources') return answer(res, 200, { items: [], nextCursor: null });
    if (p === '/api/portfolio/groups') return answer(res, 200, { items: [] });
    if (p === '/api/portfolio/dashboard/overview') return answer(res, 200, { accountValue: '12200', totalMv: '2200', cost: '2000', cash: '10000', totalPl: '200', totalPct: '10', baseCurrency: 'USD', totalMvByCurrency: { USD: '2200' }, cashByCurrency: { USD: '10000' }, dailyPl: '0', dailyPct: '0', groups: [] });
    if (p === '/api/multi-agent/latest-ratings') return answer(res, 200, { items: [] });
    if (p === '/api/multi-agent/runs') return answer(res, 200, { items: [], total: 0 });
    if (p === '/api/quote/batch') return answer(res, 200, { items: [], quotes: [], errors: [] });
    if (p === '/api/data-library/financial') return answer(res, 200, { providers: [] });
    if (p === '/api/research-memory/inventory') return answer(res, 200, { memories: [], theses: [], preferences: { autoArchive: false, recallEnabled: false }, total: 0, offset: 0, limit: 24 });
    if (p === '/api/research-memory/preferences') return answer(res, 200, { autoArchive: false, recallEnabled: false });
    if (p === '/api/channel/memory') return answer(res, 200, { items: [] });
    if (p === '/api/portfolio/holdings') return answer(res, 200, { items: [holding], total: 1 });
    if (p === '/api/cash') return answer(res, 200, { items: cash });
    if (p === '/api/ai-investment/comparison') return answer(res, 200, { currency: 'USD', period: url.searchParams.get('period') || '1M', from: '2026-11-01', to: '2026-11-13', granularity: 'daily', methodology: 'saved_valuations_no_external_flows', series: [{ accountId: 'real', name: '实盘', kind: 'real', colorIndex: 0, status: 'real', createdAt: FIXED_TIME, valuationAsOf: FIXED_TIME, equityUsd: 12200, returnPct: null, returnFrom: null, strategyCount: 0, points: [{ timestamp: FIXED_TIME, date: '2026-11-13', equityUsd: 12200, returnPct: null, gaps: [] }], gaps: [], currentMark: mark }] });
    if (p === '/api/portfolio-history') return answer(res, 200, { basis: 'current_positions_historical_prices', currency: 'USD', period: '1M', maximumDays: 365, from: '2026-11-01', to: '2026-11-13', readAt: FIXED_TIME, refreshing: false, includesCash: false, priceBasis: 'provider_close', corporateActions: 'not_reconstructed', series: [{ accountId: 'real', name: '实盘', kind: 'real', holdingsAsOf: FIXED_TIME, points: [{ date: '2026-11-13', valueUsd: 2200, knownValueUsd: 2200, coveredPositions: 1, totalPositions: 1, priceAsOf: [], fxAsOf: [], gaps: [] }], coverage: { completePoints: 1, totalPoints: 1, coveredPositions: 1, totalPositions: 1 }, gaps: [] }], gaps: [] });
    if (p === '/api/research-conversations' || p === '/api/research-conversations/skills') return answer(res, 200, { items: [] });
    if (p === '/api/notifications') return answer(res, 200, { items: [], unreadCount: 0 });
    if (p.includes('strategies') || p.includes('watchlist') || p.includes('transactions')) return answer(res, 200, { items: [], total: 0 });
    if (p.includes('preparation')) return answer(res, 200, { status: 'none' });
    if (p.includes('settings')) return answer(res, 200, {});
    if (p.includes('fx')) return answer(res, 200, { items: [], rates: { USD: 1 }, USD: 1 });
    unknown.push({ method: m, path: p });
    return answer(res, 404, { error: { code: 'UI_FIXTURE_UNMAPPED', message: m + ' ' + p } });
  }
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/__fixture__/state') return answer(res, 200, { requests, unknown });
      if (url.pathname === '/__fixture__/health') return answer(res, 200, { fixture: true, fictional: true, fixedTime: FIXED_TIME });
      if (url.pathname.startsWith('/api/')) {
        let content = '';
        for await (const chunk of req) {
          content += chunk;
          if (content.length > 1e6) return answer(res, 413, { error: { code: 'UI_FIXTURE_BODY_LIMIT' } });
        }
        return api(req, res, url, content ? JSON.parse(content) : undefined);
      }
      let target = path.resolve(dist, '.' + decodeURIComponent(url.pathname));
      if (!target.startsWith(dist + path.sep)) target = path.join(dist, 'index.html');
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        if (path.extname(url.pathname)) return answer(res, 404, { error: { code: 'UI_FIXTURE_ASSET_MISSING' } });
        target = path.join(dist, 'index.html');
      }
      if (!fs.existsSync(target)) return answer(res, 503, { error: { code: 'UI_FIXTURE_BUILD_MISSING', message: 'Run npm run build:client first.' } });
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
      res.writeHead(200, { 'content-type': mime[path.extname(target)] || 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(target).pipe(res);
    } catch (error) {
      answer(res, 500, { error: { code: 'UI_FIXTURE_ERROR', message: error.message } });
    }
  });
}

async function start(options = {}) {
  const server = createServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4173, '127.0.0.1', resolve);
  });
  return { server, url: 'http://127.0.0.1:' + server.address().port };
}

module.exports = { createServer, start };
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  start({ port: get('--port') === undefined ? 4173 : Number(get('--port')), dist: get('--dist') })
    .then(({ url }) => console.log('Fictional UI fixture listening on ' + url + '; no upstream forwarding.'))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
