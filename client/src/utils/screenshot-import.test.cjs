const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const root = path.resolve(__dirname, '../../..');
function load(file, imports = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => imports[name], Number, Date, Set, AbortController });
  return exports;
}
function helpers() {
  const file = 'client/src/pages/Import/screenshot-import.ts';
  return fs.existsSync(path.join(root, file)) ? load(file, {
    '@shared/native-image.interface': { MAX_NATIVE_IMAGE_BYTES: 8 * 1024 * 1024 },
  }) : {};
}
const agent = (patch = {}) => ({ id: 'codex', connected: true, available: true, busy: false, imageInput: true, ...patch });
const job = (patch = {}) => ({ id: 'request-1', status: 'running', phase: 'recognizing', executor: 'local', ...patch });
const request = () => ({ requestId: 'request-1', executor: 'local', agentId: 'codex', image: { mimeType: 'image/png', data: 'image' } });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('screenshot routing prefers only idle, available, connected agents with explicit image support', () => {
  const { preferredScreenshotAgent } = helpers();
  assert.equal(typeof preferredScreenshotAgent, 'function');
  assert.equal(preferredScreenshotAgent([agent({ imageInput: undefined }), agent({ busy: true }), agent({ connected: false }), agent({ available: false })]), undefined);
  assert.equal(preferredScreenshotAgent([agent({ id: 'busy', busy: true }), agent({ id: 'ready' })]).id, 'ready');
});

test('a selected batch agent may look busy with its own completed task while the next file is dispatched', async () => {
  const { ScreenshotBatchController, screenshotAgentQueueReady } = helpers();
  assert.equal(screenshotAgentQueueReady(agent({ busy: true })), true);
  assert.equal(screenshotAgentQueueReady(agent({ available: false })), false);
  const calls = []; const selected = agent();
  const batch = new ScreenshotBatchController({ create: async value => { calls.push(value.requestId); selected.busy = true;
    return job({ id: value.requestId, status: 'completed', result: { rows: [{ ticker: value.requestId, shares: 1 }] } }); },
  get: async () => job(), cancel: async () => job({ status: 'cancelled' }) });
  batch.attach(() => {}); batch.replace(['a', 'b'].map(filename => ({ filename, image: request().image })));
  await batch.start((item, index) => ({ ...request(), requestId: `job-${index}`, image: item.image }), () => screenshotAgentQueueReady(selected));
  await new Promise(setImmediate);
  assert.equal(JSON.stringify(calls), JSON.stringify(['job-0', 'job-1']));
});

test('image payload keeps its real MIME and rejects unsupported, empty or oversized uploads', () => {
  const { screenshotImage } = helpers();
  assert.equal(typeof screenshotImage, 'function');
  for (const mimeType of ['image/png', 'image/jpeg', 'image/webp']) {
    assert.equal(screenshotImage({ type: mimeType, size: 10 }, `data:${mimeType};base64,YWJj`).mimeType, mimeType);
  }
  for (const file of [{ type: 'image/gif', size: 10 }, { type: 'image/png', size: 0 }, { type: 'image/png', size: 8 * 1024 * 1024 + 1 }]) {
    assert.throws(() => screenshotImage(file, 'data:image/png;base64,YWJj'), /INVALID_IMAGE/);
  }
  assert.throws(() => screenshotImage({ type: 'image/png', size: 10 }, 'data:image/jpeg;base64,YWJj'), /INVALID_IMAGE/);
});

test('duplicate starts cannot dispatch twice and unknown submission outcome recovers by GET only', async () => {
  const { ScreenshotJobController } = helpers();
  assert.equal(typeof ScreenshotJobController, 'function');
  const pending = deferred(); const calls = [];
  const controller = new ScreenshotJobController({
    create: value => { calls.push(['POST', value.requestId]); return pending.promise; },
    get: async id => { calls.push(['GET', id]); return job(); }, cancel: async () => job({ status: 'cancelled' }),
  });
  controller.attach(() => {});
  const started = controller.start(request());
  await controller.start({ ...request(), requestId: 'duplicate' });
  pending.reject(new Error('connection lost'));
  await started;
  assert.equal(controller.snapshot.uncertain, true);
  await controller.start(request());
  await controller.refresh();
  assert.equal(JSON.stringify(calls), JSON.stringify([['POST', 'request-1'], ['GET', 'request-1']]));
  assert.equal(controller.snapshot.job.status, 'running');
});

test('old results cannot populate a replacement image and stale accepted submission is cancelled', async () => {
  const { ScreenshotJobController } = helpers();
  assert.equal(typeof ScreenshotJobController, 'function');
  const pending = deferred(); const cancelled = [];
  const controller = new ScreenshotJobController({ create: () => pending.promise, get: async () => job(),
    cancel: async id => { cancelled.push(id); return job({ status: 'cancelled' }); } });
  controller.attach(() => {});
  const started = controller.start(request());
  controller.reset();
  pending.resolve(job({ status: 'completed', result: { broker: null, rows: [{ ticker: 'OLD', shares: 1 }] } }));
  await started;
  assert.equal(controller.snapshot.job, null);
  assert.equal(controller.snapshot.requestId, null);
  assert.ok(cancelled.includes('request-1'));
});

test('a poll that completes after cancellation cannot replace cancelled state', async () => {
  const { ScreenshotJobController } = helpers();
  assert.equal(typeof ScreenshotJobController, 'function');
  const pending = deferred();
  const controller = new ScreenshotJobController({ create: async () => job(), get: () => pending.promise,
    cancel: async () => job({ status: 'cancelled', phase: 'done' }) });
  controller.attach(() => {});
  await controller.start(request());
  const polling = controller.refresh();
  await controller.cancel();
  pending.resolve(job({ status: 'completed', phase: 'done' }));
  await polling;
  assert.equal(controller.snapshot.job.status, 'cancelled');
});

test('unmount invalidates results and polling failures never resubmit provider work', async () => {
  const { ScreenshotJobController } = helpers();
  assert.equal(typeof ScreenshotJobController, 'function');
  const pending = deferred(); let posts = 0; let notified = 0;
  const controller = new ScreenshotJobController({ create: async () => { posts++; return job(); }, get: () => pending.promise,
    cancel: async () => job({ status: 'cancelled' }) });
  controller.attach(() => { notified++; });
  await controller.start(request());
  const polling = controller.refresh(); controller.dispose(); const before = notified;
  pending.reject(new Error('offline')); await polling;
  assert.equal(posts, 1); assert.equal(notified, before);
});

test('legacy API keys are removed and new keys are never persisted', () => {
  const { loadScreenshotProvider, saveScreenshotProvider } = helpers();
  assert.equal(typeof loadScreenshotProvider, 'function');
  const storage = new Map([['sq-ocr-key', 'old-secret']]);
  const localStorage = { getItem: key => storage.get(key), removeItem: key => storage.delete(key), setItem: (key, value) => storage.set(key, value) };
  const provider = loadScreenshotProvider(localStorage);
  assert.equal(provider.apiKey, 'old-secret'); assert.equal(storage.has('sq-ocr-key'), false);
  saveScreenshotProvider(localStorage, { apiKey: 'new-secret', model: 'vision', baseUrl: 'https://example.test/v1' });
  assert.equal(storage.has('sq-ocr-key'), false);
});

test('review validation accepts unknown cost but requires valid shares, ticker and per-share cost', () => {
  const { validScreenshotRows } = helpers();
  assert.equal(typeof validScreenshotRows, 'function');
  assert.equal(validScreenshotRows([{ ticker: 'TEST', shares: '2.5', avgCost: null, currency: 'USD' }]), true);
  for (const patch of [{ ticker: '' }, { shares: '' }, { shares: 0 }, { shares: -1 }, { shares: Infinity }, { avgCost: -1 }]) {
    assert.equal(validScreenshotRows([{ ticker: 'TEST', shares: 2, avgCost: null, ...patch }]), false);
  }
});

test('batch selection enforces count, total size and each image format without partial acceptance', () => {
  const { screenshotSelectionError } = helpers();
  const file = (name, size = 10, type = 'image/png') => ({ name, size, type });
  assert.equal(screenshotSelectionError([file('a'), file('b')]), null);
  assert.equal(screenshotSelectionError([]), 'FILE_COUNT');
  assert.equal(screenshotSelectionError(Array.from({ length: 20 }, (_, i) => file(String(i), 8 * 1024 * 1024))), null);
  assert.equal(screenshotSelectionError(Array.from({ length: 21 }, (_, i) => file(String(i)))), 'FILE_COUNT');
  assert.equal(screenshotSelectionError([file('a', 10, 'image/gif')]), 'INVALID_IMAGE');
});

test('removing queued and processed screenshots uses stable IDs and removes only their review rows', async () => {
  const { ScreenshotBatchController } = helpers();
  const ids = ['first', 'second', 'third'];
  const batch = new ScreenshotBatchController({ create: async value => job({ id: value.requestId, status: 'completed', result: {
    rows: [{ ticker: value.requestId, shares: 1 }],
  } }), get: async () => job(), cancel: async () => job({ status: 'cancelled' }) });
  batch.attach(() => {});
  batch.replace(ids.map(id => ({ id, filename: 'same.png', image: request().image })));
  assert.equal(batch.remove('second'), true);
  await batch.start((item) => ({ ...request(), requestId: item.id, image: item.image }), () => true);
  await new Promise(setImmediate);
  assert.equal(batch.snapshot.rows.length, 2);
  assert.equal(batch.remove('first'), true);
  assert.equal(batch.snapshot.rows.length, 1);
  assert.equal(batch.snapshot.rows[0].sourceId, 'third');
  assert.equal(batch.snapshot.files.length, 1);
});

test('cancel during async image reading aborts and never sends a paid POST', async () => {
  const { ScreenshotBatchController } = helpers();
  const startedRead = deferred(); const pendingRead = deferred(); let posts = 0; let aborted = false;
  const batch = new ScreenshotBatchController({ create: async () => { posts++; return job(); },
    get: async () => job(), cancel: async () => job({ status: 'cancelled' }) });
  batch.attach(() => {}); batch.replace([{ id: 'one', filename: 'one.png', file: { type: 'image/png', size: 10 } }]);
  const started = batch.start(async (_item, _index, signal) => { signal.addEventListener('abort', () => { aborted = true; });
    startedRead.resolve(); return pendingRead.promise; });
  await startedRead.promise;
  assert.equal(batch.snapshot.files[0].status, 'reading');
  assert.equal(batch.remove('one'), false);
  batch.cancel();
  pendingRead.resolve(request()); await started;
  assert.equal(aborted, true);
  assert.equal(posts, 0);
});

test('removing a queued screenshot after start skips its job without interrupting the active one', async () => {
  const { ScreenshotBatchController } = helpers();
  const first = deferred(); const calls = [];
  const batch = new ScreenshotBatchController({ create: value => { calls.push(value.requestId); return value.requestId === 'first' ? first.promise
    : Promise.resolve(job({ id: value.requestId, status: 'completed', result: { rows: [{ ticker: value.requestId, shares: 1 }] } })); },
  get: async () => job(), cancel: async () => job({ status: 'cancelled' }) });
  batch.attach(() => {});
  batch.replace(['first', 'middle', 'last'].map(id => ({ id, filename: `${id}.png`, image: request().image })));
  const started = batch.start(item => ({ ...request(), requestId: item.id, image: item.image }));
  await new Promise(setImmediate);
  assert.equal(batch.remove('middle'), true);
  first.resolve(job({ id: 'first', status: 'completed', result: { rows: [{ ticker: 'FIRST', shares: 1 }] } }));
  await started; await new Promise(setImmediate);
  assert.equal(JSON.stringify(calls), JSON.stringify(['first', 'last']));
});

test('review rejects normalized duplicate tickers including Hong Kong aliases and more than 200 rows', () => {
  const { screenshotReviewProblem } = helpers();
  const row = ticker => ({ ticker, shares: 1, avgCost: null });
  assert.equal(screenshotReviewProblem([row('0700'), row('700.HK')]), 'DUPLICATE_TICKER');
  assert.equal(screenshotReviewProblem([row('AAPL'), row(' aapl ')]), 'DUPLICATE_TICKER');
  assert.equal(screenshotReviewProblem([row('600519.SS'), row('600519.SH')]), 'DUPLICATE_TICKER');
  assert.equal(screenshotReviewProblem([row('AAPL'), row('MSFT')]), null);
  assert.equal(screenshotReviewProblem(Array.from({ length: 201 }, (_, i) => row(`T${i}`))), 'ROW_LIMIT');
});

test('batch recognition runs in order, pauses after failure and preserves earlier rows until explicitly resumed', async () => {
  const { ScreenshotBatchController } = helpers();
  const calls = []; const pending = [];
  const batch = new ScreenshotBatchController({
    create: value => { calls.push(value.requestId); const next = deferred(); pending.push(next); return next.promise; },
    get: async () => job(), cancel: async () => job({ status: 'cancelled' }),
  });
  batch.attach(() => {});
  batch.replace(['a.png', 'b.png', 'c.png'].map(filename => ({ filename, image: { mimeType: 'image/png', data: filename } })));
  batch.start((item, index) => ({ ...request(), requestId: `job-${index}`, image: item.image }));
  await new Promise(setImmediate);
  assert.equal(JSON.stringify(calls), JSON.stringify(['job-0']));
  pending[0].resolve(job({ id: 'job-0', status: 'completed', result: { rows: [{ ticker: 'AAPL', shares: 1 }] } }));
  await pending[0].promise; await new Promise(setImmediate);
  assert.equal(JSON.stringify(calls), JSON.stringify(['job-0', 'job-1']), JSON.stringify(batch.snapshot));
  pending[1].resolve(job({ id: 'job-1', status: 'failed', error: { code: 'NO_HOLDINGS' } }));
  await pending[1].promise; await new Promise(setImmediate);
  assert.equal(batch.snapshot.paused, true);
  assert.equal(batch.snapshot.rows[0].sourceFile, 'a.png');
  assert.equal(batch.snapshot.files[2].status, 'queued');
  batch.resume();
  await new Promise(setImmediate);
  assert.equal(JSON.stringify(calls), JSON.stringify(['job-0', 'job-1', 'job-2']));
});

test('uncertain batch submission requires GET recovery and cancel fences pending work', async () => {
  const { ScreenshotBatchController } = helpers();
  const calls = []; const pending = deferred();
  const batch = new ScreenshotBatchController({ create: value => { calls.push(['POST', value.requestId]); return pending.promise; },
    get: async id => { calls.push(['GET', id]); return job({ id, status: 'completed', result: { rows: [{ ticker: 'MSFT', shares: 2 }] } }); },
    cancel: async id => { calls.push(['DELETE', id]); return job({ id, status: 'cancelled' }); } });
  batch.attach(() => {});
  batch.replace(['a', 'b'].map(filename => ({ filename, image: request().image })));
  batch.start((item, index) => ({ ...request(), requestId: `job-${index}`, image: item.image }));
  pending.reject(new Error('lost')); await pending.promise.catch(() => {}); await new Promise(setImmediate);
  assert.equal(batch.snapshot.paused, true);
  await batch.recover();
  assert.equal(batch.snapshot.rows.length, 1);
  assert.equal(calls.filter(call => call[0] === 'POST').length, 1);
  batch.cancel();
  assert.equal(batch.snapshot.files[1].status, 'cancelled');
  batch.resume();
  assert.equal(calls.filter(call => call[0] === 'POST').length, 1);
});

test('recovered running job resumes GET polling without dispatching the next screenshot', async () => {
  const { ScreenshotBatchController } = helpers();
  const calls = []; let reads = 0;
  const batch = new ScreenshotBatchController({
    create: async value => { calls.push(['POST', value.requestId]); if (value.requestId === 'job-0') throw new Error('lost');
      return job({ id: value.requestId, status: 'completed', result: { rows: [{ ticker: 'MSFT', shares: 1 }] } }); },
    get: async id => { calls.push(['GET', id]); reads++; return reads === 1 ? job({ id, status: 'running' })
      : job({ id, status: 'completed', result: { rows: [{ ticker: 'AAPL', shares: 1 }] } }); },
    cancel: async id => job({ id, status: 'cancelled' }),
  });
  batch.attach(() => {});
  batch.replace(['a', 'b'].map(filename => ({ filename, image: request().image })));
  await batch.start((item, index) => ({ ...request(), requestId: `job-${index}`, image: item.image }));
  assert.equal(batch.snapshot.paused, true);
  await batch.recover();
  assert.equal(batch.snapshot.paused, false);
  assert.equal(calls.filter(call => call[0] === 'POST').length, 1);
  await batch.recover();
  assert.equal(batch.snapshot.paused, true);
  assert.equal(calls.filter(call => call[0] === 'POST').length, 1);
  batch.resume();
  await new Promise(setImmediate);
  assert.equal(calls.filter(call => call[0] === 'POST').length, 2);
  assert.equal(batch.snapshot.rows.length, 2);
});

test('malformed completed result pauses the batch instead of treating it as successful', async () => {
  const { ScreenshotBatchController } = helpers();
  const calls = [];
  const batch = new ScreenshotBatchController({ create: async value => { calls.push(value.requestId);
    return job({ id: value.requestId, status: 'completed', result: { rows: [{ shares: 1 }] } }); },
  get: async () => job(), cancel: async () => job({ status: 'cancelled' }) });
  batch.attach(() => {});
  batch.replace(['a', 'b'].map(filename => ({ filename, image: request().image })));
  await batch.start((item, index) => ({ ...request(), requestId: `job-${index}`, image: item.image }));
  assert.equal(batch.snapshot.files[0].status, 'failed');
  assert.equal(batch.snapshot.files[0].error, 'INVALID_RESULT');
  assert.equal(batch.snapshot.files[1].status, 'queued');
  assert.equal(batch.snapshot.rows.length, 0);
  assert.equal(calls.length, 1);
});

function screenshotPage(initialBatch = null, agents = [agent()], { failFirstCommit = false } = {}) {
  let stateCursor = 0, refCursor = 0, effectCursor = 0, sequence = 0;
  const states = [], refs = [], effects = [], calls = [], invalidated = [], records = new Map();
  if (initialBatch) records.set(initialBatch.id, initialBatch);
  const jsx = (type, props) => ({ type, props: props ?? {} });
  function ImportSavedNextSteps() {}
  const imports = {
    react: {
      useState(initial) { const index = stateCursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
        return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
      useRef(initial) { const index = refCursor++; return refs[index] ??= { current: initial }; },
      useEffect(fn, deps) { const index = effectCursor++; const previous = effects[index];
        if (!previous || deps.some((value, i) => value !== previous.deps[i])) effects[index] = { fn, deps, pending: true, cleanup: previous?.cleanup }; },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-router-dom': { useNavigate: () => value => calls.push(['navigate', value]) },
    'react-i18next': { useTranslation: () => ({ t: key => key, i18n: { language: 'zh-CN' } }) },
    '@tanstack/react-query': {
      useQuery({ queryKey }) { const data = queryKey[0] === 'settings' ? agents : queryKey[1] === 'batches' ? [...records.values()] : queryKey[1] === 'batch' ? records.get(queryKey[2]) : { holdingsRevision: 'fixture', changes: [] };
        return { data, isPending: false, refetch: async () => ({ data }) }; },
      useQueryClient: () => ({ setQueryData: (key, value) => records.set(key[2], value), invalidateQueries: ({ queryKey }) => invalidated.push(queryKey) }),
    },
    '@/api/local-agents': { fetchLocalAgents: async () => agents },
    '@/api/import-batches': {
      IMPORT_QUERY_KEYS: [['import'], ['holdings'], ['today'], ['current-research']],
      fetchImportBatches: async () => [...records.values()], fetchImportBatch: async id => records.get(id),
      createImportBatch: async input => { calls.push(['create', input]); const batch = { ...fixtureBatch(), id: input.id, status: 'draft', images: [], rows: [], executor: input.executor }; records.set(batch.id, batch); return batch; },
      uploadImportImage: async (id, value) => { calls.push(['upload', value]); const batch = records.get(id); batch.images.push({ ...value, status: 'queued' }); return batch; },
      startImportBatch: async id => { calls.push(['start', id]); const batch = records.get(id); batch.status = 'running'; return batch; },
      cancelImportBatch: async id => { calls.push(['cancel', id]); return records.get(id); },
      commitImportBatch: async (id, value) => { calls.push(['commit', value]); if (failFirstCommit && calls.filter(call => call[0] === 'commit').length === 1) throw Error('Uncertain receipt'); return { id: 'receipt', created: value.rowIds.length, updated: 0 }; },
      editImportRow: async (id, rowId, patch) => { const batch = records.get(id); Object.assign(batch.rows.find(row => row.id === rowId), patch); return batch; },
      retryImportImage: async (id, imageId) => { calls.push(['retry', imageId]); return records.get(id); },
      recoverImportBatch: async id => { calls.push(['recover', id]); return records.get(id); },
    },
    './screenshot-import': helpers(),
    './ImportSavedNextSteps': { ImportSavedNextSteps },
    '@/utils/local-agent-settings': { agentSettingsProblem: () => null, cleanAgentSettings: value => value },
    sonner: { toast: { error() {}, success() {} } },
  };
  for (const name of ['button', 'input', 'label']) imports[`@/components/ui/${name}`] = new Proxy({}, { get: (_, key) => String(key) });
  imports['lucide-react'] = new Proxy({}, { get: (_, key) => String(key) });
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, 'client/src/pages/Import/ScreenshotImport.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => imports[name], Date, Map,
    crypto: { randomUUID: () => `id-${++sequence}` },
    localStorage: { getItem: () => null, removeItem() {}, setItem() {} },
    FileReader: class { readAsDataURL(file) { this.result = `data:${file.type};base64,YWJj`; this.onload?.(); } },
  });
  const render = () => { stateCursor = 0; refCursor = 0; effectCursor = 0; return exports.default(); };
  const flush = () => { for (const effect of effects) if (effect.pending) { effect.pending = false; effect.cleanup?.(); effect.cleanup = effect.fn(); } };
  return { render, flush, calls, invalidated, unmount: () => effects.forEach(effect => effect.cleanup?.()) };
}
function fixtureBatch(patch = {}) { return { id: 'saved-batch', revision: 3, status: 'running', createdAt: '2026-11-06T00:00:00Z', executor: { executor: 'local', agentId: 'codex' },
  receipts: [], images: [{ id: 'image-one', filename: 'page.png', status: 'completed', fileAvailable: true, rowCount: 1 }],
  rows: [{ id: 'row-one', ticker: 'TEST', shares: 7, avgCost: null, sourceImageIds: ['image-one'], revision: 0, confirmed: true }], ...patch }; }
function nodes(tree) { return Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : []; }
function content(tree) { return Array.isArray(tree) ? tree.map(content).join('') : tree && typeof tree === 'object' ? content(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree); }

test('durable screenshot UI restores the last server batch and leaves recognition running when unmounted', () => {
  const page = screenshotPage(fixtureBatch()); page.render(); page.flush(); const tree = page.render();
  assert.ok(content(tree).includes('TEST')); assert.ok(content(tree).includes('page.png'));
  page.unmount(); assert.equal(page.calls.length, 0);
});

test('the primary screenshot save keeps partial progress without queuing research and offers friends next', async () => {
  const page = screenshotPage(fixtureBatch()); page.render(); page.flush(); const tree = page.render();
  const button = nodes(tree).find(node => node.type === 'Button' && content(node) === '保存持仓');
  assert.ok(button, 'reviewed holdings need a primary save action');
  assert.equal(button.props.disabled, false); await button.props.onClick();
  const commit = page.calls.find(call => call[0] === 'commit')[1];
  assert.equal(commit.analyze, false); assert.equal(JSON.stringify(commit.rowIds), JSON.stringify(['row-one']));
  assert.equal(page.calls.filter(call => ['navigate', 'start', 'create'].includes(call[0])).length, 0, 'saving does not schedule or start a research journey');
  const saved = page.render();
  assert.ok(nodes(saved).some(node => node.type?.name === 'ImportSavedNextSteps'), 'saved receipt exposes an explicit continuation');
  assert.ok(page.invalidated.some(key => key[0] === 'holdings')); assert.ok(page.invalidated.some(key => key[0] === 'today'));
});

test('explicit screenshot research preserves the saved import handoff and opens its existing report page', async () => {
  const page = screenshotPage(fixtureBatch()); page.render(); page.flush(); const tree = page.render();
  const button = nodes(tree).find(node => node.type === 'Button' && content(node) === '保存并开始研究');
  assert.ok(button);
  await button.props.onClick();
  assert.equal(page.calls.find(call => call[0] === 'commit')[1].analyze, true);
  assert.ok(page.calls.some(call => call[0] === 'navigate' && call[1] === '/research/portfolio'));
});

test('unknown screenshot save results retain the original intent and prevent switching to research on retry', async () => {
  const page = screenshotPage(fixtureBatch(), [agent()], { failFirstCommit: true });
  page.render(); page.flush();
  await nodes(page.render()).find(node => node.type === 'Button' && content(node) === '保存持仓').props.onClick();
  const retry = page.render();
  assert.equal(nodes(retry).find(node => node.type === 'Button' && content(node) === '保存并开始研究').props.disabled, true);
  await nodes(retry).find(node => node.type === 'Button' && content(node) === '核对本次保存结果').props.onClick();
  const commits = page.calls.filter(call => call[0] === 'commit');
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0][1], commits[1][1]);
  assert.equal(commits[1][1].analyze, false);
  assert.equal(page.calls.filter(call => call[0] === 'navigate').length, 0);
});

test('unknown original screenshot tasks expose query recovery and never retry extraction', async () => {
  const page = screenshotPage(fixtureBatch({ status: 'paused', pauseReason: 'TASK_STATUS_UNKNOWN', images: [{ id: 'image-one', filename: 'page.png', status: 'unknown' }] }));
  page.render(); page.flush(); const tree = page.render();
  await nodes(tree).find(node => node.type === 'Button' && content(node).includes('查询原任务')).props.onClick();
  assert.equal(page.calls.filter(call => call[0] === 'recover').length, 1);
  assert.equal(page.calls.filter(call => ['start', 'retry', 'create'].includes(call[0])).length, 0);
});

test('local screenshot source never switches to a cloud provider automatically', () => {
  const page = screenshotPage(null, []); page.render(); page.flush(); let tree = page.render();
  assert.ok(!nodes(tree).some(node => node.props.id === 'vision-key'));
  nodes(tree).find(node => node.props.id === 'screenshot-executor').props.onChange({ target: { value: 'vision' } });
  tree = page.render(); assert.ok(nodes(tree).some(node => node.props.id === 'vision-key'));
  assert.equal(page.calls.length, 0);
});
test('screenshot API wrappers use job IDs for reads and cancellation', async () => {
  const calls = [];
  const api = load('client/src/api/index.ts', { './http': { default: async options => { calls.push(options); return { data: job() }; } }, '../utils/logger': {} });
  await api.createScreenshotJob(request()); await api.fetchScreenshotJob('request /1'); await api.cancelScreenshotJob('request /1');
  assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].data.requestId, 'request-1');
  assert.equal(calls[1].method, 'GET'); assert.equal(calls[1].url, '/api/import/screenshot-jobs/request%20%2F1');
  assert.equal(calls[2].method, 'DELETE'); assert.equal(calls[2].url, calls[1].url);
});

test('all screenshot error codes have matching Chinese and English messages without displaying raw provider errors', () => {
  const { SCREENSHOT_ERROR_CODES, screenshotErrorCode } = helpers();
  const zh = JSON.parse(fs.readFileSync(path.join(root, 'client/src/i18n/zh-CN.json'), 'utf8')).import.screenshotFlow;
  const en = JSON.parse(fs.readFileSync(path.join(root, 'client/src/i18n/en.json'), 'utf8')).import.screenshotFlow;
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const code of SCREENSHOT_ERROR_CODES) { assert.ok(zh.errors[code], code); assert.ok(en.errors[code], code); }
  assert.equal(screenshotErrorCode({ response: { data: { error: { message: 'LOCAL_USAGE_LIMIT' } } } }), 'LOCAL_USAGE_LIMIT');
  assert.equal(screenshotErrorCode({ response: { data: { message: 'private provider response' } } }), 'UNKNOWN');
});

test('global HTTP error envelopes retain recognized business codes behind generic error codes', () => {
  const { screenshotErrorCode } = helpers();
  assert.equal(screenshotErrorCode({ response: { status: 400, data: { error: {
    code: 'BAD_REQUEST', message: 'INVALID_IMAGE', details: {},
  } } } }), 'INVALID_IMAGE');
  assert.equal(screenshotErrorCode({ response: { status: 404, data: { error: {
    code: 'NOT_FOUND', message: 'JOB_NOT_FOUND', details: {},
  } } } }), 'JOB_NOT_FOUND');
  assert.equal(screenshotErrorCode({ response: { data: { code: 'BAD_REQUEST', error: { code: 'INVALID_REQUEST' } } } }), 'INVALID_REQUEST');
  assert.equal(screenshotErrorCode({ response: { data: { code: 'BAD_REQUEST', error: { code: 'BAD_REQUEST' }, message: 'INVALID_IMAGE' } } }), 'INVALID_IMAGE');
});

test('a lost submission followed by the global 404 envelope exposes explicit new-attempt recovery without redispatch', async () => {
  const { ScreenshotJobController } = helpers();
  let posts = 0;
  const controller = new ScreenshotJobController({ create: async () => { posts++; throw new Error('connection lost'); },
    get: async () => { throw { response: { status: 404, data: { error: { code: 'NOT_FOUND', message: 'JOB_NOT_FOUND' } } } }; },
    cancel: async () => job({ status: 'cancelled' }),
  });
  controller.attach(() => {});
  await controller.start(request()); await controller.refresh();
  assert.equal(controller.snapshot.error, 'JOB_NOT_FOUND');
  assert.equal(controller.snapshot.missing, true);
  assert.equal(controller.snapshot.uncertain, true);
  assert.equal(controller.snapshot.requestId, 'request-1');
  await controller.start(request()); assert.equal(posts, 1);
  controller.reset(); assert.equal(controller.snapshot.requestId, null);
});
