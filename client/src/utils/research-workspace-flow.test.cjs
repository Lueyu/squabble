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
  'HTMLFormElement',
  'FormData',
  'DocumentFragment',
  'getComputedStyle',
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
  f.load('api/agent-roster.ts').agentRosterApi.list = async () => ({ items: [{ id: 'fixture-agent', name: 'Fixture researcher', status: 'active', currentVersionId: 'fixture-v1', currentVersion: { config: { templateId: 'financials' } } }] });
  api.fetchResearchSkills = async () => [
    { id: 'strategy', command: '/strategy', title: '聊出策略', titleEn: 'Clarify a strategy', description: '多轮问答', descriptionEn: 'Clarify together', version: '1.0.0', mode: 'interview', requiredTools: [] },
    { id: 'financial-verification', command: '/financials', title: '财报解读', titleEn: 'Financial results', description: '核对财报', descriptionEn: 'Verify financials', version: '1.0.0', mode: 'research', requiredTools: ['get_financials'] },
  ];
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

test('slash selection sends the chosen trusted skill in the frozen request and unknown commands never dispatch', async () => {
  await scenario('/research', undefined, async ({ type, click, calls, settle }) => {
    await type('/unknown Missing skill');
    await click('Send question');
    assert.equal(calls.length, 0);
    await type('/fin');
    const option = document.querySelector('[role=option]');
    assert.ok(option.textContent.includes('/financials'));
    await React.act(async () => option.click());
    await settle();
    assert.ok(document.body.textContent.includes('/financials · Financial results'));
    await type('Why did operating cash flow change?');
    await click('Send question');
    assert.equal(calls[0].skillId, 'financial-verification');
    assert.equal(calls[0].message, 'Why did operating cash flow change?');
  });
});

test('strategy slash opens a same-room interview, keeps the original idea and never sends a model research request', async () => {
  await scenario('/research', ({ f }) => {
    f.load('api/portfolio-workspace.ts').portfolioWorkspaceApi.accounts = async () => [];
    f.load('api/strategy-interviews.ts').strategyInterviewsApi.list = async () => [];
    f.load('api/investment-strategies.ts').investmentStrategiesApi.workspace = async () => ({ drafts: [], history: [], current: null });
  }, async ({ type, click, calls, location }) => {
    await type('/strategy Keep a dividend strategy with low turnover');
    await click('Send question');
    assert.equal(calls.length, 0);
    assert.match(location(), /research\?tab=strategies&interview=new/u);
    assert.equal(document.querySelector('textarea').value, 'Keep a dividend strategy with low turnover');
    assert.ok(document.body.textContent.includes('Choose an account'));
    await click('Chats');
    assert.equal(location(), '/research');
  });
});

test('a library deep link submits immutable source context only after an explicit question', async () => {
  await scenario('/research?sourceId=source-version-owner&versionId=pinned-v1', undefined, async ({ type, click, calls }) => {
    assert.equal(calls.length, 0);
    await type('Explain the claim in this source');
    await click('Send question');
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].context)), { kind: 'library', sourceId: 'source-version-owner', versionId: 'pinned-v1' });
  });
});

test('participant changes retain the actual moderator and reject two moderators before submission', async () => {
  await scenario('/research', ({ f }) => {
    f.load('api/agent-roster.ts').agentRosterApi.list = async () => ({ items: [
      ['Moderator', 'moderator'], ['Analyst', 'financials'], ['Other moderator', 'moderator'],
    ].map(([name, templateId], index) => ({ id: 'person-' + index, name, status: 'active', currentVersionId: 'v-' + index, currentVersion: { config: { templateId } } })) });
  }, async ({ click, calls }) => {
    await click('Analyst');
    await click('Analyst');
    assert.match(document.body.textContent, /Moderator gives the final summary/);
    assert.doesNotMatch(document.body.textContent, /Analyst gives the final summary/);
    await click('Other moderator');
    assert.match(document.body.textContent, /Choose one moderator/);
    assert.equal(document.querySelector('[role=alert]').closest('details'), null, 'selection errors remain visible while the picker is closed');
    assert.equal(document.querySelector('textarea'), null);
    assert.equal(calls.length, 0);
    await click('Other moderator');
    assert.ok(document.querySelector('textarea'));
  });
});

test('new research keeps selected identities in a collapsed keyboard-accessible picker without repeating the room header', async () => {
  await scenario('/research?agent=selected', ({ f }) => {
    f.load('api/agent-roster.ts').agentRosterApi.list = async () => ({ items: [
      { id: 'selected', name: 'Cashflow cat', specialty: 'Read every long cash-flow statement in detail', avatar: 'technical', status: 'active', availability: 'configured', currentVersionId: 'cat-v1', currentVersion: { config: { templateId: 'financials' } } },
      { id: 'offline', name: 'Offline bear', specialty: 'Challenge evidence', avatar: 'risk', status: 'active', availability: 'unavailable', currentVersionId: 'bear-v1', currentVersion: { config: { templateId: 'bear' } } },
    ] });
  }, async ({ calls, click, settle }) => {
    const picker = document.querySelector('details.research-participant-picker');
    assert.ok(picker, 'participant options use a native disclosure');
    assert.equal(picker.open, false, 'new chats keep the full roster collapsed');
    const summary = picker.querySelector('summary');
    assert.match(summary.textContent, /Cashflow cat/);
    assert.match(summary.textContent, /Adjust agents/);
    assert.doesNotMatch(summary.textContent, /Offline bear|cash-flow statement/);
    assert.equal(document.querySelector('.research-room-header'), null, 'the containing research workspace already names this room');
    assert.ok(document.querySelector('textarea'), 'the composer remains in the primary pane');
    await React.act(async () => summary.click());
    await settle();
    assert.equal(picker.open, true);
    assert.equal(picker.querySelector('[aria-label="Offline bear"]').disabled, true);
    assert.match(picker.textContent, /Restore connection/);
    await React.act(async () => summary.click());
    assert.equal(picker.open, false);
    assert.equal(calls.length, 0, 'opening the picker never dispatches research');
    await click('Open First saved research');
    assert.equal(document.querySelector('details.research-participant-picker'), null, 'saved participant snapshots cannot be edited');
    assert.match(document.querySelector('.research-room-header').textContent, /First saved research/);
  });
});

test('a single-agent deep link shows that selected identity in the empty room and blocks unavailable agents up front', async () => {
  await scenario('/research?agent=selected', ({ f }) => {
    f.load('api/agent-roster.ts').agentRosterApi.list = async () => ({ items: [
      { id: 'selected', name: 'Cashflow cat', specialty: 'Read cash flow', avatar: 'technical', status: 'active', availability: 'configured', currentVersionId: 'cat-v1', currentVersion: { config: { templateId: 'financials' } } },
      { id: 'offline', name: 'Offline bear', specialty: 'Challenge evidence', avatar: 'risk', status: 'active', availability: 'unavailable', currentVersionId: 'bear-v1', currentVersion: { config: { templateId: 'bear' } } },
    ] });
  }, async ({ calls }) => {
    const empty = document.querySelector('[data-research-empty]');
    assert.ok(empty);
    assert.match(empty.textContent, /Cashflow cat/);
    assert.doesNotMatch(empty.textContent, /researches independently before comparing/);
    assert.deepEqual([...empty.querySelectorAll('[data-persona]')].map(node => node.dataset.persona), ['technical']);
    assert.equal(document.querySelector('[aria-label="Offline bear"]').disabled, true);
    assert.match(document.body.textContent, /Restore connection/);
    assert.equal(calls.length, 0);
  });
});

test('saved chat keeps its frozen animal when a financial researcher becomes the discussion manager', async () => {
  await scenario('/research?session=first', ({ saved }) => {
    saved[0].members = [{ id: 'saved', name: 'Frozen cat', avatar: 'technical', role: 'manager', roleTitle: 'Portfolio lead' }];
    saved[0].messages[0].role = 'manager';
    saved[0].messages[0].memberName = 'Frozen cat';
  }, async () => {
    const message = document.querySelector('.council-message');
    assert.equal(message.dataset.persona, 'technical');
    assert.match(message.textContent, /Frozen cat/);
    assert.match(message.textContent, /Portfolio lead/);
  });
});

test('an unknown research request remains recoverable when its selected agent later becomes unavailable', async () => {
  let unavailable = false;
  await scenario('/research?agent=selected', ({ f, api, calls }) => {
    f.load('api/agent-roster.ts').agentRosterApi.list = async () => ({ items: [{ id: 'selected', name: 'Cashflow cat', specialty: 'Cash flow', avatar: 'technical', status: 'active', availability: unavailable ? 'unavailable' : 'configured', currentVersionId: 'cat-v1', currentVersion: { config: { templateId: 'financials' } } }] });
    api.createResearchConversation = async input => {
      calls.push(input);
      if (calls.length === 1) throw new Error('Response lost');
      return session('created', 'Accepted original request');
    };
  }, async ({ type, click, client, settle, calls }) => {
    await type('Keep this exact question'); await click('Send question');
    unavailable = true;
    await React.act(async () => client.invalidateQueries({ queryKey: ['agent-roster'] })); await settle();
    assert.ok(document.querySelector('textarea'), 'The original request must remain recoverable');
    await click('Send question');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
  });
});

test('a definitive rejection of an old request locks new questions when the agent is unavailable', async () => {
  let unavailable = false;
  await scenario('/research?agent=selected', ({ f, api, calls }) => {
    f.load('api/agent-roster.ts').agentRosterApi.list = async () => ({ items: [{ id: 'selected', name: 'Cashflow cat', status: 'active', availability: unavailable ? 'unavailable' : 'configured', currentVersionId: 'v1', currentVersion: { config: { templateId: 'financials' } } }] });
    api.createResearchConversation = async input => {
      calls.push(input);
      if (calls.length === 1) throw new Error('Unknown response');
      throw { response: { status: 422 } };
    };
  }, async ({ type, click, client, settle, calls }) => {
    await type('Original question'); await click('Send question');
    unavailable = true;
    await React.act(async () => client.invalidateQueries({ queryKey: ['agent-roster'] })); await settle();
    await click('Send question');
    assert.equal(Boolean(document.querySelector('textarea')), false);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
  });
});
