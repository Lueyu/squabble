const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { ESLint } = require('eslint');

// Exercise the actual project configuration. In-memory snippets do not need a
// TypeScript program: this checks dependency directions, not type resolution.
const eslint = new ESLint({
  cwd: path.resolve(__dirname, '..'),
  overrideConfig: [{ languageOptions: { parserOptions: { project: null } } }],
});

async function restrictions(filePath, source) {
  const [result] = await eslint.lintText(source, { filePath });
  assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
  assert.equal(result.messages.some(message => message.ruleId === null), false,
    'The fixture must be linted, not ignored or rejected by the parser');
  return result.messages.filter(message => message.ruleId === 'no-restricted-imports');
}

const boundaries = [
  {
    name: 'strategy features depend on shared UI and APIs, never pages',
    file: 'client/src/features/investment-strategies/InvestmentStrategyEditor.tsx',
    forbidden: [
      '../../pages/Today/TodayPage', '@/pages/Today/TodayPage',
      '@client/src/pages/Paper/AiInvestmentPage',
    ],
    allowed: ['@/components/ui/button', '@/api/investment-strategies', '@shared/user-investment-strategy.interface'],
  },
  {
    name: 'shared contracts remain independent of application implementations',
    file: 'shared/user-investment-strategy.interface.ts',
    forbidden: [
      '../server/modules/paper-trading/investment-policy.service',
      '../client/src/api/investment-strategies', '@server/database/schema',
      '@client/src/pages/Today/TodayPage', '@/api/investment-strategies',
    ],
    allowed: ['./api.interface', './research-document.interface'],
  },
  {
    name: 'research foundation does not depend on research workflows',
    file: 'server/modules/research-core/evidence.service.ts',
    forbidden: [
      '../multi-agent/pipeline.service', '@server/modules/council/council.service',
      '../experience/today.service', '../paper-trading/strategy.service',
      '../channel/channel.service', '../research-routing/portfolio-research-route.service',
      '../research-runtime/research-runtime.service', '../research-tools/research-tools.service',
      '../tool-connections/tool-connections.service', '../tool-actions/tool-actions.service',
    ],
    allowed: ['../quote/quote.service', '../settings/settings.service', './research-errors'],
  },
  {
    name: 'tool connections remain below investment workflows',
    file: 'server/modules/tool-connections/tool-connections.service.ts',
    forbidden: ['../council/council.service', '../experience/today.service', '../paper-trading/strategy.service',
      '../research-tools/research-tools.service', '../research-routing/portfolio-research-route.service'],
    allowed: ['../../common/agent-contract', '../../database/tool-connections.schema', '../settings/settings-security'],
  },
  {
    name: 'artifact storage remains independent of investment orchestration',
    file: 'server/modules/research-artifacts/research-artifacts.service.ts',
    forbidden: ['../council/council.service', '../channel/channel.service', '../research-tools/research-tools.service'],
    allowed: ['../data-library/data-dataset.service', '../../database/research-artifacts.schema'],
  },
  {
    name: 'compute consumes immutable data rather than investment workflows',
    file: 'server/modules/research-compute/research-compute.service.ts',
    forbidden: ['../paper-trading/strategy.service', '../council/council.service', '../research-tools/research-tools.service'],
    allowed: ['../research-artifacts/research-artifacts.service', '../data-library/data-dataset.service', './e2b.adapter'],
  },
  {
    name: 'executor selection is independent of its feature consumers',
    file: 'server/modules/research-routing/portfolio-research-route.service.ts',
    forbidden: ['../experience/today.service', '@server/modules/paper-trading/strategy.service', '../council/council.service', '../multi-agent/pipeline.service'],
    allowed: ['../research-core/llm.service', '../local-agents/local-agents.service'],
  },
  {
    name: 'paper trading consumes shared routing rather than the experience facade',
    file: 'server/modules/paper-trading/strategy-model.service.ts',
    forbidden: ['../experience/today.service', '@server/modules/experience/today.service'],
    allowed: ['../research-routing/portfolio-research-route.service', '../research-core/llm.service'],
  },
];

for (const boundary of boundaries) {
  test(boundary.name, async () => {
    for (const modulePath of boundary.forbidden) {
      for (const source of [
        `import { value } from '${modulePath}';`,
        `export { value } from '${modulePath}';`,
        `import type { Value } from '${modulePath}';`,
      ]) {
        assert.equal((await restrictions(boundary.file, source)).length, 1,
          `Expected forbidden dependency: ${boundary.file} -> ${source}`);
      }
    }
    for (const modulePath of boundary.allowed) {
      assert.deepEqual(await restrictions(boundary.file, `import { value } from '${modulePath}';`), [],
        `Expected allowed dependency: ${boundary.file} -> ${modulePath}`);
    }
  });
}
