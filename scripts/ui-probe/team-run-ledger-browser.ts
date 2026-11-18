import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { eq } from 'drizzle-orm';
import { AuthGlobalGuard } from '../../server/common/platform/auth.guard';
import { signAccessToken } from '../../server/modules/auth/jwt';
import { TeamRunController } from '../../server/modules/team-runs/team-run.controller';
import { TeamRunService } from '../../server/modules/team-runs/team-run.service';
import { acceptedReport, setup } from '../../server/modules/team-runs/team-run-test.fixture';
import { PortfolioAssetsService } from '../../server/modules/paper-trading/portfolio-assets.service';
import { DEFAULT_INVESTMENT_CONFIG } from '../../server/modules/paper-trading/investment-policy.rules';
import { recordTeamSignalLinks, copyTeamExecutionLinks } from '../../server/database/team-execution-links';
import { paperOrders, paperTrades } from '../../server/database/schema';
import { teamDecisions } from '../../server/database/teams.schema';
import { teamRunCycles } from '../../server/database/team-run.schema';
import { start } from './fixture-server.cjs';

type Fixture = Awaited<ReturnType<typeof setup>>;

// tsx omits design metadata; register the production controller's single dependency.
Reflect.defineMetadata('design:paramtypes', [TeamRunService], TeamRunController);
class BrowserRunModule {}
Module({})(BrowserRunModule);

async function connect(context: BrowserContext, shell: string, api: string, f: Fixture) {
  const token = signAccessToken({ id: f.owner, username: 'run-fixture' });
  const assets = new PortfolioAssetsService(f.db);
  const base = `/api/teams/${f.teamId}`;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== shell) return route.abort();
    if (url.pathname.startsWith(base + '/run-agreement')) {
      return route.fulfill({ response: await route.fetch({ url: api + url.pathname,
        headers: { ...route.request().headers(), authorization: 'Bearer ' + token } }) });
    }
    if (url.pathname === base) return route.fulfill({ json: await f.service.detail(f.owner, f.teamId) });
    if (url.pathname === base + '/commissions') return route.fulfill({ json: await f.commissions.list(f.owner, f.teamId, {}) });
    if (url.pathname.startsWith(base + '/commissions/')) return route.fulfill({ json: await f.commissions.detail(f.owner, f.teamId, url.pathname.split('/').pop()!) });
    if (url.pathname === '/api/ai-investment/accounts') return route.fulfill({ json: await f.workspace.list(f.owner) });
    if (url.pathname === `/api/ai-investment/accounts/${f.account.id}/assets`) return route.fulfill({ json: await assets.read(f.owner, f.account.id) });
    if (url.pathname.startsWith('/api/research-documents/versions/')) return route.fulfill({ json: await f.documents.view(f.owner, url.pathname.split('/').pop()!) });
    return route.continue();
  });
  await context.routeWebSocket('**/*', socket => socket.close());
}

async function main() {
  const db = new URL(process.env.TEAM_TEST_DATABASE_URL ?? '');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(db.hostname) && /test/i.test(db.pathname), 'A disposable loopback test database is required');
  process.env.AUTH_MODE = 'account';
  process.env.JWT_SECRET = randomUUID();
  const output = path.resolve('output/playwright/team-run-ledger');
  await mkdir(output, { recursive: true });
  const f = await setup('immediate');
  try {
    const app = await NestFactory.create({ module: BrowserRunModule, controllers: [TeamRunController],
      providers: [{ provide: TeamRunService, useValue: f.runs }] }, { logger: false });
    app.useGlobalGuards(new AuthGlobalGuard(new Reflector(), f.db));
    await app.listen(0, '127.0.0.1');
    try {
      const api = await app.getUrl();
      const shell = await start({ port: 0 });
      try {
        const browser = await chromium.launch();
        try {
          const url = `${shell.url}/teams/${f.teamId}?panel=overview`;
          async function open(width: number, zh: boolean) {
            const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 960 }, serviceWorkers: 'block' });
            await connect(context, shell.url, api, f);
            await context.addInitScript(({ lang, theme }) => {
              localStorage.setItem('sq-lang', lang); localStorage.setItem('pt-theme', theme);
            }, { lang: zh ? 'zh-CN' : 'en', theme: zh ? 'light' : 'dark' });
            const page = await context.newPage();
            await page.goto(url);
            return page;
          }
          async function shot(page: Page, name: string) {
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true, animations: 'disabled' });
          }
          const page = await open(1280, false);
          const button = (name: string) => page.getByRole('button', { name, exact: true });
          await page.getByRole('heading', { name: 'Waiting for first research' }).waitFor();
          await page.getByText('No paper fills yet', { exact: true }).waitFor();
          await page.getByText('No published research yet', { exact: true }).waitFor();
          await shot(page, 'desktop-first');
          const mobile = await open(390, true);
          await mobile.getByText('暂无已发布研究', { exact: true }).waitFor();
          await shot(mobile, 'mobile-first');

          await button('Pause run').click();
          await button('Confirm pause').press('Enter');
          await page.getByRole('heading', { name: 'Automatic research and paper trading are paused' }).waitFor();
          assert.equal((await f.runs.status(f.owner, f.teamId)).agreement?.state, 'paused');
          await shot(page, 'desktop-paused');
          await page.getByText('Run rules, budget and versions', { exact: true }).click();
          await button('Adjust run rules').click();
          await button('Preview run rules').click();
          const consent = page.getByRole('checkbox', { name: 'Confirm reviewed run rules' });
          await consent.waitFor();
          assert.equal(await button('Confirm and start').isDisabled(), true);
          await consent.press('Space');
          await button('Confirm and start').press('Enter');
          await page.getByRole('heading', { name: 'Waiting for first research' }).waitFor();
          const result = await acceptedReport(f);
          await f.scheduler.runOnce(new Date('2026-11-12T09:00:00Z'));
          const [cycle] = await f.db.select().from(teamRunCycles);
          assert.equal(cycle.state, 'applied', cycle.lastError ?? '');
          await page.reload();
          await page.getByText(result.version.title, { exact: true }).waitFor();
          await page.getByText('No paper fills yet', { exact: true }).waitFor();
          await shot(page, 'desktop-applied-empty');
          await page.getByRole('link', { name: 'View cycle history' }).click();
          await page.getByRole('heading', { name: result.commission.plan.objective, exact: true }).waitFor();
          await page.goto(url);
          await page.getByRole('link', { name: 'Read full report' }).click();
          await page.waitForURL('**/analysis/reports/' + result.version.id);
          await page.getByText(result.version.title, { exact: true }).first().waitFor();

          const [decision] = await f.db.select().from(teamDecisions).where(eq(teamDecisions.id, cycle.decisionId!));
          const signalId = randomUUID();
          const trade = await f.db.transaction(async tx => {
            const [order] = await tx.insert(paperOrders).values({ owner: f.owner, accountId: f.account.id, ticker: 'TEST', quantity: '7', side: 'buy', status: 'filled' }).returning();
            await recordTeamSignalLinks(tx, f.owner, { ...DEFAULT_INVESTMENT_CONFIG, teamDecisionRefs: [{
              decisionId: decision.id, proposalId: decision.proposalId, proposalRevision: decision.proposalRevision,
            }] }, signalId);
            await copyTeamExecutionLinks(tx, f.owner, 'signal', signalId, 'order', order.id);
            const [row] = await tx.insert(paperTrades).values({ owner: f.owner, accountId: f.account.id, orderId: order.id, ticker: 'TEST', quantity: '7', side: 'buy', price: '13.25', cashAfter: '800' }).returning();
            await copyTeamExecutionLinks(tx, f.owner, 'order', order.id, 'trade', row.id);
            return row;
          });
          await page.goto(url);
          await page.getByRole('link', { name: 'View trade ledger' }).waitFor();
          await shot(page, 'desktop-filled');
          await mobile.reload();
          await mobile.getByRole('link', { name: '查看交易账本' }).waitFor();
          await shot(mobile, 'mobile-filled');
          await mobile.getByRole('region', { name: '最近研究' }).scrollIntoViewIfNeeded();
          await shot(mobile, 'mobile-research');
          await page.getByRole('link', { name: 'View trade ledger' }).click();
          const ledger = new URL(page.url());
          assert.equal(ledger.searchParams.get('accountId'), f.account.id);
          assert.equal(ledger.searchParams.get('tradeId'), trade.id);
          await page.locator('#asset-trade-' + trade.id).waitFor();
          console.log(`Verified PostgreSQL-backed run controls, first cycle, installation, report, history and fill. Screenshots in ${output}`);
        } finally { await browser.close(); }
      } finally { shell.server.closeAllConnections(); await new Promise<void>(resolve => shell.server.close(resolve)); }
    } finally { await app.close(); }
  } finally { await f.dispose(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
