const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', {
  url: 'http://localhost/research',
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'Element',
  'Node',
  'Event',
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: dom.window[key],
    writable: true,
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter, useLocation } = require('react-router-dom');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const fixture = require('./simple-test-loader.cjs');

function session(id, title) {
  return {
    id,
    title,
    revision: 3,
    status: 'completed',
    mode: 'single',
    stage: 'completed',
    createdAt: '2026-11-10T00:00:00Z',
    updatedAt: '2026-11-10T00:00:00Z',
    messages: [
      {
        id: id + '-answer',
        role: 'researcher',
        memberName: 'Saved member',
        memberId: 'saved',
        content: title + ' original finding',
        revision: 3,
        createdAt: '2026-11-10T00:00:00Z',
      },
    ],
    reports: [],
    members: [],
    memberStates: [],
    actualExecutors: [],
    unavailableMembers: [],
    outcome: null,
  };
}
async function scenario(path, configure, run) {
  const f = fixture({ realQuery: true });
  let sequence = 0;
  f.state.randomUUID = () => 'intent-' + ++sequence;
  for (const family of ['dialog', 'sheet']) {
    const ui = f.load(`components/ui/${family}.tsx`);
    const name = family === 'dialog' ? 'Dialog' : 'Sheet';
    ui[name] = ({ open, children }) =>
      open
        ? React.createElement('section', { role: 'dialog' }, children)
        : null;
    for (const part of ['Content', 'Header', 'Title', 'Description'])
      ui[name + part] = ({ children }) =>
        React.createElement('div', null, children);
  }
  const api = f.load('api/research-conversations.ts');
  const saved = [
    session('first', 'First saved research'),
    session('second', 'Second saved research'),
  ];
  api.fetchResearchConversations = async () => saved;
  api.fetchResearchConversation = async (id) =>
    saved.find((item) => item.id === id);
  const calls = [];
  api.createResearchConversation = async (input) => {
    calls.push(input);
    return session('created', 'New accepted research');
  };
  api.postResearchConversationMessage = async (id, input) => {
    calls.push({ id, ...input });
    return session(id, 'Follow-up accepted');
  };
  api.deleteResearchConversation = async (id, input) => {
    calls.push({ id, ...input });
    saved.splice(
      saved.findIndex((item) => item.id === id),
      1,
    );
    return { id, deleted: true };
  };
  configure?.({ api, calls, f, saved });
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        refetchInterval: false,
      },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  const Page = f.load('pages/Analysis/ResearchWorkspacePage.tsx').default;
  function Location() {
    const value = useLocation();
    return React.createElement('output', null, value.pathname + value.search);
  }
  const root = createRoot(document.getElementById('root'));
  const settle = () =>
    React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  const button = (name) =>
    [...document.querySelectorAll('button')].find(
      (item) =>
        item.getAttribute('aria-label') === name || item.textContent === name,
    );
  const click = async (name) => {
    const target = button(name);
    assert.ok(target, 'Missing button: ' + name);
    assert.equal(target.disabled, false);
    await React.act(async () => target.click());
    await settle();
  };
  const type = async (value) =>
    React.act(async () => {
      const field = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      ).set.call(field, value);
      field.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  try {
    await React.act(async () =>
      root.render(
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(
            MemoryRouter,
            { initialEntries: [path] },
            React.createElement(Page),
            React.createElement(Location),
          ),
        ),
      ),
    );
    await settle();
    await run({
      calls,
      click,
      type,
      button,
      settle,
      saved,
      client,
      api,
      location: () => document.querySelector('output').textContent,
    });
  } finally {
    await React.act(async () => root.unmount());
    client.clear();
  }
}

test('research room sends in place only explicitly and retries the frozen question without losing its receipt', async () => {
  await scenario(
    '/research?question=Prefilled%20question',
    ({ api, calls }) => {
      api.createResearchConversation = async (input) => {
        calls.push(input);
        if (calls.length === 1) throw new Error('fictional lost response');
        return session('created', 'New accepted research');
      };
    },
    async ({ calls, click, location }) => {
      assert.equal(calls.length, 0);
      assert.equal(
        document.querySelector('textarea').value,
        'Prefilled question',
      );
      assert.doesNotMatch(
        document.body.textContent,
        /Your research capabilities|Continue to discussion/,
      );
      await click('Send question');
      assert.equal(
        document.querySelector('textarea').value,
        'Prefilled question',
      );
      assert.equal(document.querySelector('textarea').readOnly, true);
      await click('Open First saved research');
      await click('New research');
      assert.equal(
        document.querySelector('textarea').value,
        'Prefilled question',
      );
      assert.equal(document.querySelector('textarea').readOnly, true);
      await click('Send question');
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0], calls[1]);
      assert.equal(calls[0].context.kind, 'portfolio');
      assert.match(location(), /^\/research\?session=created$/);
      assert.match(
        document.querySelector('[role=log]').textContent,
        /New accepted research original finding/,
      );
    },
  );
});

test('an accepted send never pulls the reader away from a different history selection', async () => {
  let accept;
  await scenario(
    '/research?question=Pending%20question',
    ({ api, calls }) => {
      api.createResearchConversation = (input) => {
        calls.push(input);
        return new Promise((resolve) => {
          accept = resolve;
        });
      };
    },
    async ({ click, settle, location }) => {
      await click('Send question');
      await click('Open First saved research');
      await React.act(async () =>
        accept(session('created', 'New accepted research')),
      );
      await settle();
      assert.equal(location(), '/research?session=first');
      assert.match(
        document.querySelector('[role=log]').textContent,
        /First saved research original finding/,
      );
      await click('New research');
      assert.equal(document.querySelector('textarea').value, '');
    },
  );
});

test('the mobile history layer opens a saved task in the same pane and closes after selection', async () => {
  await scenario('/research', null, async ({ click, settle, location }) => {
    await click('Research history');
    const layer = document.querySelector('[role=dialog]');
    assert.ok(layer);
    const target = layer.querySelector(
      '[aria-label="Open Second saved research"]',
    );
    await React.act(async () => target.click());
    await settle();
    assert.equal(document.querySelector('[role=dialog]'), null);
    assert.equal(location(), '/research?session=second');
    assert.match(
      document.querySelector('[role=log]').textContent,
      /Second saved research original finding/,
    );
  });
});

test('history opens in the same research pane and preserves each unsent draft across selections', async () => {
  await scenario(
    '/research',
    null,
    async ({ click, type, location, calls }) => {
      await type('Unsent new question');
      await click('Open First saved research');
      assert.equal(location(), '/research?session=first');
      assert.match(
        document.querySelector('[role=log]').textContent,
        /First saved research original finding/,
      );
      await type('Unsent first follow-up');
      await click('Open Second saved research');
      assert.equal(document.querySelector('textarea').value, '');
      await click('Open First saved research');
      assert.equal(
        document.querySelector('textarea').value,
        'Unsent first follow-up',
      );
      await click('New research');
      assert.equal(
        document.querySelector('textarea').value,
        'Unsent new question',
      );
      assert.equal(calls.length, 0);
    },
  );
});

test('history deletion requires confirmation, retains a rejected running task, and clears only the deleted selection', async () => {
  await scenario(
    '/research?session=first',
    ({ api, calls, saved }) => {
      api.deleteResearchConversation = async (id, input) => {
        calls.push({ id, ...input });
        if (calls.length === 1)
          throw {
            response: {
              status: 409,
              data: { message: 'RESEARCH_DELETE_REQUIRES_SETTLEMENT' },
            },
          };
        saved.splice(
          saved.findIndex((item) => item.id === id),
          1,
        );
        return { id, deleted: true };
      };
    },
    async ({ click, calls, location }) => {
      await click('Delete First saved research');
      assert.match(
        document.querySelector('[role=dialog]').textContent,
        /reports.*remain/i,
      );
      assert.equal(calls.length, 0);
      await click('Cancel');
      assert.equal(calls.length, 0);
      await click('Delete First saved research');
      await click('Confirm deletion');
      assert.match(
        document.querySelector('[role=alert]').textContent,
        /stop.*settle/i,
      );
      assert.match(location(), /session=first/);
      await click('Confirm deletion');
      assert.deepEqual(calls[0], calls[1]);
      assert.equal(calls[0].expectedRevision, 3);
      assert.equal(location(), '/research');
      assert.ok(!document.body.textContent.includes('First saved research'));
      assert.ok(document.body.textContent.includes('Second saved research'));
    },
  );
});
