const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { serve, SandboxBroker } = require('./broker.cjs');
const digest = value => createHash('sha256').update(value).digest('hex');
const dependencies = { worker: '1.0.0', python: '3.12.10', quantstats: '0.0.86', pandas: '2.3.3', numpy: '2.3.5', matplotlib: '3.10.7', backtrader: '1.9.78.123' };
function packet(code, kind = 'exploratory', parameters = {}) {
  const raw = Buffer.from(JSON.stringify([{ return: '0.1' }, { return: '-0.1' }, { return: null }]));
  return { version: 1, jobId: randomUUID(), maxRuntimeMs: 60000, maxOutputBytes: 1024 * 1024,
    manifest: { version: 1, kind, templateId: kind === 'statistics' ? 'returns-v1' : 'free-code-v1', templateVersion: '1',
      codeHash: digest(code), seed: 7, parameters, dependencies, effectiveDataClasses: ['public'], permittedUses: ['research'],
      limits: { maxOutputBytes: 1024 * 1024 }, datasets: [{ datasetVersionId: randomUUID(), contentHash: 'a'.repeat(64),
        fileSha256: digest(raw), path: 'dataset-0.json', rowCount: 3, dataClasses: ['public'], permittedUses: ['research'] }] },
    files: [{ name: 'dataset-0.json', base64: raw.toString('base64') }, { name: 'code.py', base64: Buffer.from(code).toString('base64') }] };
}

test('real Docker jobs isolate exploratory code, fixed statistics, outputs, cancellation and broker recovery',
  { skip: process.env.SANDBOX_REAL_TESTS !== '1', timeout: 480000 }, async context => {
    const directory = await mkdtemp(join(tmpdir(), 'squabble-sandbox-real-'));
    const config = { directory: join(directory, 'journal'), tokenFile: join(directory, 'token'), port: 0 };
    const { server, broker } = await serve(config);
    const origin = `http://127.0.0.1:${server.address().port}`, token = (await readFile(config.tokenFile, 'utf8')).trim();
    const request = async (route, method = 'GET', body) => {
      const response = await fetch(`${origin}${route}`, { method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json(); if (!response.ok) throw new Error(value.errorCode); return value;
    };
    const execute = async input => {
      const created = await request('/v1/jobs', 'POST', input);
      assert.equal(created.state, 'created');
      assert.equal((await request('/v1/jobs', 'POST', input)).sandboxId, created.sandboxId);
      await assert.rejects(request('/v1/jobs', 'POST', { ...input, maxOutputBytes: input.maxOutputBytes - 1 }), /CONFLICT/);
      await request(`/v1/jobs/${input.jobId}/start`, 'POST');
      let receipt;
      do { await new Promise(resolve => setTimeout(resolve, 100)); receipt = await request(`/v1/jobs/${input.jobId}`); }
      while (['created', 'running', 'cancel_requested'].includes(receipt.state));
      assert.equal(receipt.terminationConfirmed, true, JSON.stringify(receipt));
      return receipt.state === 'succeeded' ? request(`/v1/jobs/${input.jobId}/result`) : receipt;
    };
    const result = output => {
      assert.ok(output.files, JSON.stringify(output));
      return JSON.parse(Buffer.from(output.files.find(file => file.name === 'result.json').base64, 'base64'));
    };
    try {
      assert.equal(broker.readiness.status, 'ready', JSON.stringify(broker.readiness));
      assert.equal((await fetch(`${origin}/v1/jobs`)).status, 401);
      const security = await execute(packet(`import os, socket\nfrom pathlib import Path\nchecks = {'uid': os.getuid(), 'socket': Path('/var/run/docker.sock').exists(), 'secrets': any(key in os.environ for key in ['DATABASE_URL','JWT_SECRET','SANDBOX_TOKEN_FILE'])}\nfor key, target in [('public',('1.1.1.1',443)),('host',('host.docker.internal',8093))]:\n try:\n  socket.create_connection(target, timeout=.3).close(); checks[key] = False\n except OSError:\n  checks[key] = True\ntry:\n Path('/root-write-test').write_text('bad'); checks['rootReadonly'] = False\nexcept OSError:\n checks['rootReadonly'] = True\nchecks['memory'] = Path('/sys/fs/cgroup/memory.max').read_text().strip()\nchecks['pids'] = Path('/sys/fs/cgroup/pids.max').read_text().strip()\nPath('/job/secret').write_text('fictional-job-only')\nresult = checks`));
      assert.deepEqual(result(security).result, { uid: 10001, socket: false, secrets: false, public: true, host: true,
        rootReadonly: true, memory: '2147483648', pids: '64' });
      const isolated = await execute(packet("from pathlib import Path\nresult = {'otherJobVisible': Path('/job/secret').exists()}"));
      assert.deepEqual(result(isolated).result, { otherJobVisible: false });
      const statistics = await execute(packet('# Squabble fixed template returns-v1 version 1\n', 'statistics',
        { returnColumn: 'return', benchmarkColumn: null, frequency: 'daily', annualizationFactor: 252, riskFreeRate: 0 }));
      assert.equal(result(statistics).missingPeriods, 1);
      assert.equal(result(statistics).positivePeriodRatio, 0.5);
      context.diagnostic('Exploratory security, cross-job isolation and fixed statistics passed on the real Linux engine.');
      const dates = ['2020-01-02', '2020-01-03', '2020-01-06'];
      const ids = Object.fromEntries(['prices', 'calendar', 'rules', 'universe', 'actions', 'fx', 'benchmark'].map(name => [name, randomUUID()]));
      const parameters = { templateId: 'fixed-shares-v1', instrumentId: 'DEMO', quantity: 1, initialCash: 100,
        baseCurrency: 'USD', from: dates[0], to: dates[2], signalDate: dates[0], signalAvailableAt: `${dates[0]}T21:00:00Z`, outOfSampleFrom: dates[2],
        universeVersionId: ids.universe, priceDatasetVersionId: ids.prices, calendarVersionId: ids.calendar,
        marketRulesVersionId: ids.rules, corporateActionsVersionId: ids.actions, fxVersionId: ids.fx,
        benchmark: { datasetVersionId: ids.benchmark, returnColumn: 'return' }, cashFlowDatasetVersionId: null,
        frequency: 'daily', annualizationFactor: 252, riskFreeRate: 0 };
      const market = {
        prices: dates.map(date => ({ date, instrumentId: 'DEMO', availableAt: `${date}T21:00:00Z`, open: '10', high: '10', low: '10', close: '10', volume: '1000', currency: 'USD', adjustment: 'unadjusted', halted: false, limitUp: false, limitDown: false })),
        calendar: [{ type: 'coverage', year: 2020, complete: true }, ...dates.map(date => ({ type: 'session', date, closeAt: `${date}T21:00:00Z` }))],
        rules: [{ effectiveFrom: dates[0], effectiveTo: dates[2], lotSize: 1, settlementSessions: 0,
          commissionRate: '0', minimumCommission: '0', sellTaxRate: '0', dividendTaxRate: '0', slippageBps: '0', feeCurrency: 'USD', allowOddLotLiquidation: false }],
        universe: [{ instrumentId: 'DEMO', listedAt: '2019-01-01', delistedAt: null }], actions: [], fx: [], benchmark: dates.map(date => ({ date, return: '0' })) };
      const backtest = packet('# Squabble fixed template fixed-shares-v1 version 1\n', 'backtest', parameters);
      backtest.manifest.templateId = 'fixed-shares-v1'; backtest.manifest.datasets = [];
      backtest.files = backtest.files.filter(file => file.name === 'code.py');
      for (const [index, [name, rows]] of Object.entries(market).entries()) {
        const bytes = Buffer.from(JSON.stringify(rows)), filename = `dataset-${index}.json`;
        backtest.files.push({ name: filename, base64: bytes.toString('base64') });
        backtest.manifest.datasets.push({ datasetVersionId: ids[name], contentHash: 'a'.repeat(64), fileSha256: digest(bytes), path: filename,
          rowCount: rows.length, dataClasses: ['public'], permittedUses: ['research'], coverage: { status: 'complete' },
          adjustment: name === 'prices' ? 'unadjusted' : 'unknown', schema: name === 'universe' ? { universeCoverage: 'historical' } : {} });
      }
      const backtested = result(await execute(backtest));
      assert.equal(backtested.trades[0].date, dates[1]); assert.equal(backtested.finalCash, 90);
      context.diagnostic('Fixed Backtrader next-session execution passed on fictional versioned market inputs.');
      const forked = result(await execute(packet("import subprocess, sys\nchildren = []\nlimited = False\ntry:\n for _ in range(100): children.append(subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']))\nexcept OSError:\n limited = True\nfinally:\n for child in children: child.kill()\nresult = {'limited': limited, 'spawned': len(children)}")));
      assert.equal(forked.result.limited, true); assert.ok(forked.result.spawned < 64);
      const oom = await execute(packet('result = len(bytearray(3 * 1024 * 1024 * 1024))'));
      assert.equal(oom.state, 'failed');
      const linked = await execute(packet("from pathlib import Path\n(Path(output_dir) / 'escape.json').symlink_to('/etc/passwd')\nresult = 1"));
      assert.equal(linked.state, 'failed');
      const large = await execute(packet("result = 'x' * (2 * 1024 * 1024)"));
      assert.equal(large.state, 'failed');
      const timed = packet('while True: pass'); timed.maxRuntimeMs = 1000;
      assert.equal((await execute(timed)).state, 'failed');
      const cancelled = packet('import time\ntime.sleep(60)');
      await request('/v1/jobs', 'POST', cancelled);
      await request(`/v1/jobs/${cancelled.jobId}/start`, 'POST');
      const receipt = await request(`/v1/jobs/${cancelled.jobId}/cancel`, 'POST');
      assert.equal(receipt.terminationConfirmed, true); assert.equal(receipt.state, 'cancelled');
      const orphan = packet('result = 1'); await request('/v1/jobs', 'POST', orphan);
      clearInterval(broker.timer);
      const recovered = new SandboxBroker(config); await recovered.initialize();
      assert.equal(recovered.get(orphan.jobId).terminationConfirmed, true);
      assert.equal(recovered.get(orphan.jobId).state, 'failed');
      await recovered.close();
    } finally {
      await broker.close(); await new Promise(resolve => server.close(resolve));
      if ([...broker.jobs.values()].some(job => !job.terminationConfirmed)) context.diagnostic(`Retained unknown-resource journal: ${directory}`);
      else await rm(directory, { recursive: true, force: true });
    }
  });
