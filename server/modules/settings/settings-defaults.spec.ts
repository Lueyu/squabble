import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PostgresJsDatabase } from '../../common/platform';
import type { QuoteService } from '../quote/quote.service';
import { LlmService } from '../research-core/llm.service';
import { SettingsService } from './settings.service';
import { encryptSecret } from './settings-security';
import type { LlmBudgetService } from '../llm-budget/llm-budget.service';

const unusedBudgets = {
  reserve: async () => { throw new Error('Unconfigured models must not reserve budget'); },
} as unknown as LlmBudgetService;

function testSettings(row: Record<string, unknown> | null, price: string | null = '100') {
  const db = { select: () => ({ from: () => ({ where: async () => row ? [row] : [] }) }) };
  const quotes = { getQuote: async () => price === null ? null : { price } };
  return new SettingsService(db as unknown as PostgresJsDatabase, quotes as unknown as QuoteService);
}

test('empty configuration enables honest basic analysis and public financial data without a key', async () => {
  const previous = process.env.DOUBAO_API_KEY;
  delete process.env.DOUBAO_API_KEY;
  try {
    const service = testSettings(null);
    const settings = await service.getSettings('alice');
    assert.equal(settings.llm.source, 'builtin');
    assert.equal(settings.llm.engine, 'basic');
    assert.equal(settings.llm.available, true);
    assert.equal(settings.llm.hasApiKey, false);
    assert.equal(settings.financial.provider, 'public');
    assert.equal(settings.financial.source, 'builtin');
    assert.equal(settings.financial.hasApiKey, false);
    assert.equal(await service.getLlmConfig('alice'), null);
    assert.equal(await new LlmService(service, unusedBudgets).isConfigured('alice'), false);
    assert.equal(await new LlmService(service, unusedBudgets).getExecutionInfo('alice'), null);
    assert.equal((await service.testFinancial('alice')).ok, true);
  } finally {
    if (previous === undefined) delete process.env.DOUBAO_API_KEY;
    else process.env.DOUBAO_API_KEY = previous;
  }
});

test('public quote connectivity reports unavailable and invalid data as failures', async () => {
  assert.equal((await testSettings(null, null).testFinancial('alice')).ok, false);
  assert.equal((await testSettings(null, 'NaN').testFinancial('alice')).ok, false);
  assert.equal((await testSettings(null, '0').testFinancial('alice')).ok, false);
});

test('unreadable personal model key remains configured and cannot silently fall back to basic', async () => {
  const row = { llmApiKeyEnc: encryptSecret('personal-key', 'old-master-key-1234567890') };
  const previous = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = 'new-master-key-1234567890';
  try {
    const service = testSettings(row);
    const settings = await service.getSettings('alice');
    assert.equal(settings.llm.engine, 'llm');
    assert.equal(settings.llm.available, false);
    assert.equal(settings.llm.needsReentry, true);
    assert.equal(await new LlmService(service, unusedBudgets).isConfigured('alice'), true);
    await assert.rejects(() => new LlmService(service, unusedBudgets).chatFast([], 'alice'), /No LLM API key/u);
  } finally {
    if (previous === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
    else process.env.SETTINGS_ENCRYPTION_KEY = previous;
  }
});
