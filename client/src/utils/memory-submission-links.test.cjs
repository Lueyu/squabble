const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const React = require('react');
const { createRoot } = require('react-dom/client');
const { BrowserRouter } = require('react-router-dom');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const fixture = require('./simple-test-loader.cjs');

const sessionPath = '/api/council/sessions';
const createdAt = '2026-11-10T00:00:00Z';
const firstTask = 'a0cb3276-16a9-470f-b4cb-ba760b0b036f';
const secondTask = 'e5fcce37-62fb-4fc9-93da-007a6bd86c52';
const inaccessibleTask = '22adbc39-31a2-44c2-b752-4b32f5886806';
const tasks = new Map([[firstTask, 'Fictional first research'], [secondTask, 'Fictional second research']]);

function savedInventory(title) {
  return { messages: [{
    id: 'message', memberName: title, createdAt,
    memory: {
      counts: { requested: 0, selected: 1, prepared: 1, submitted: 1 },
      requested: [], selected: [{ id: 'saved-ref', version: 2 }],
      prepared: [{ id: 'saved-ref', version: 2 }], submitted: [{ id: 'saved-ref', version: 2 }],
      basis: 'exact', submission: 'api', usedTokens: 30, budgetTokens: 100, omissions: [],
    },
  }] };
}

async function withMemoryPage(address, check) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' + address });
  const { document, location } = dom.window;
  Object.assign(globalThis, { window: dom.window, document, IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.HTMLFormElement = dom.window.HTMLFormElement;
  const { state, load } = fixture({ realQuery: true });
  state.responses = {
    get(path) {
      if (path === sessionPath) {
        return { items: [...tasks].map(([id, title]) => ({ id, title, createdAt })) };
      }
      if (path.startsWith(sessionPath + '/')) {
        const id = path.slice(sessionPath.length + 1);
        const title = tasks.get(id);
        if (!title) throw Object.assign(new Error('Council session not found'), { response: { status: 404 } });
        return savedInventory(title);
      }
      return { items: [], total: 0, memories: [], theses: [] };
    },
  };
  const Page = load('pages/Workspace/MemoryWorkspacePage.tsx').default;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const root = createRoot(document.getElementById('root'));
  const select = () => document.querySelector('select');
  async function choose(id) {
    await React.act(async () => {
      select().value = id;
      select().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
  }
  async function waitFor(condition, message) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (condition()) return;
      await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    }
    assert.fail(message);
  }
  const detailRequests = () => state.requests
    .filter(({ args }) => args[0].startsWith(sessionPath + '/'))
    .map(({ method, args }) => [method, args[0]]);
  try {
    await React.act(async () => root.render(React.createElement(QueryClientProvider, { client },
      React.createElement(BrowserRouter, null, React.createElement(Page)))));
    await waitFor(() => select()?.querySelector(`option[value="${firstTask}"]`), 'research choices are available');
    return await check({ document, location, waitFor, select, choose, detailRequests });
  } finally {
    await React.act(async () => root.unmount());
    client.clear();
    dom.window.close();
    for (const key of ['window', 'document', 'HTMLFormElement', 'IS_REACT_ACT_ENVIRONMENT']) delete globalThis[key];
  }
}

const getDetail = id => ['get', sessionPath + '/' + id];

test('the selected task is in the address, survives a fresh mount, and can be switched or cleared', async () => {
  const address = await withMemoryPage('/memory?tab=usage&keep=fixture', async page => {
    assert.deepEqual(page.detailRequests(), []);
    await page.choose(firstTask);
    await page.waitFor(() => page.document.querySelector('summary')?.textContent.includes('Submitted 1'), 'first inventory appears');
    assert.match(page.document.querySelector('details').textContent, /saved-ref v2/);
    assert.equal(new URLSearchParams(page.location.search).get('sessionId'), firstTask);
    assert.deepEqual(page.detailRequests(), [getDetail(firstTask)]);
    return page.location.pathname + page.location.search;
  });
  await withMemoryPage(address, async page => {
    await page.waitFor(() => page.document.querySelector('article h3')?.textContent.includes(tasks.get(firstTask)), 'linked task restored');
    assert.equal(page.select().value, firstTask);
    await page.choose(secondTask);
    await page.waitFor(() => page.document.querySelector('article h3')?.textContent.includes(tasks.get(secondTask)), 'second inventory appears');
    const params = new URLSearchParams(page.location.search);
    assert.equal(params.get('sessionId'), secondTask);
    assert.equal(params.get('tab'), 'usage');
    assert.equal(params.get('keep'), 'fixture');
    assert.deepEqual(page.detailRequests(), [getDetail(firstTask), getDetail(secondTask)]);
    await page.choose('');
    assert.equal(new URLSearchParams(page.location.search).has('sessionId'), false);
    assert.equal(page.document.querySelector('details'), null);
  });
});

test('an inaccessible link keeps its task selected, shows a read error, and retries that exact task', async () => {
  const address = '/memory?tab=usage&sessionId=' + inaccessibleTask;
  await withMemoryPage(address, async page => {
    const error = () => page.document.querySelector('[role="alert"]');
    await page.waitFor(error, 'the linked task shows a read error');
    assert.match(error().textContent, /Could not load submission records for this task/);
    assert.equal(page.select().value, inaccessibleTask);
    assert.equal(page.document.querySelector('details'), null);
    assert.equal(page.location.pathname + page.location.search, address);
    assert.deepEqual(page.detailRequests(), [getDetail(inaccessibleTask)]);
    const retry = [...page.document.querySelectorAll('button')].find(button => button.textContent === 'Retry records');
    assert.ok(retry);
    await React.act(async () => retry.click());
    await page.waitFor(() => page.detailRequests().length === 2 && error(), 'the same task still reports its error');
    assert.deepEqual(page.detailRequests(), [getDetail(inaccessibleTask), getDetail(inaccessibleTask)]);
  });
});
