const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { createRoot } = require('react-dom/client');
const {
  MemoryRouter,
  Routes,
  Route,
  useLocation,
} = require('react-router-dom');
const { JSDOM } = require('jsdom');
const fixture = require('./simple-test-loader.cjs');

async function scenario(run) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const previous = {
    window: global.window,
    document: global.document,
    act: global.IS_REACT_ACT_ENVIRONMENT,
  };
  global.window = dom.window;
  global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  try {
    const f = fixture();
    f.state.mutationFactory = (options) => {
      const [state, setState] = React.useState({
        isPending: false,
        isError: false,
      });
      return {
        ...state,
        mutate(value) {
          setState({ isPending: true, isError: false });
          void options
            .mutationFn(value)
            .then(async (result) => {
              await options.onSuccess?.(result, value);
              setState({ isPending: false, isError: false });
            })
            .catch((error) =>
              setState({ isPending: false, isError: true, error }),
            );
        },
      };
    };
    const dialog = f.load('components/ui/dialog.tsx');
    dialog.Dialog = ({ children, open }) =>
      open ? React.createElement('div', null, children) : null;
    for (const key of [
      'DialogContent',
      'DialogDescription',
      'DialogHeader',
      'DialogTitle',
    ])
      dialog[key] = ({ children }) =>
        React.createElement('div', null, children);
    f.load('components/ui/switch.tsx').Switch = ({
      checked,
      onCheckedChange,
      disabled,
      ...props
    }) =>
      React.createElement(
        'button',
        {
          role: 'switch',
          'aria-checked': checked,
          'aria-label': props['aria-label'],
          disabled,
          onClick: () => onCheckedChange(!checked),
        },
        checked ? 'On' : 'Off',
      );
    const strategy = {
      id: 'strategy-a',
      revision: 2,
      status: 'confirmed',
      content: { title: 'Reviewed idea', entries: [] },
      sources: [],
      preview: { canConfirm: true },
    };
    const allocation = {
      strategyId: strategy.id,
      strategyRevision: strategy.revision,
      allocationPct: 60,
      enabled: true,
      snapshot: strategy,
    };
    f.state.queries.set('portfolio-account', {
      data: {
        id: 'account-a',
        name: 'Chosen account',
        status: 'running',
        policyRevision: 7,
        investment: {
          account: { id: 'account-a' },
          policy: { baseConfig: { timezone: 'Asia/Shanghai' } },
          limits: { maxPositionPct: 20 },
        },
        combination: {
          accountId: 'account-a',
          policyRevision: 7,
          cashFloorPct: 15,
          allocations: [allocation],
          draft: null,
        },
      },
    });
    f.state.queries.set('investment-strategies', {
      data: { current: strategy, drafts: [], history: [] },
    });
    f.state.responses = new Map([
      [
        '/api/ai-investment/accounts/account-a/strategies/preview',
        {
          accountId: 'account-a',
          expectedPolicyRevision: 7,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          previewHash: 'reviewed-hash',
          canApply: true,
          allocations: [allocation],
          allocatedPct: 60,
          issues: [],
        },
      ],
    ]);
    const Page = f.load(
      'features/investment-strategies/AccountStrategyCombinationPage.tsx',
    ).default;
    function Location() {
      const location = useLocation();
      return React.createElement('output', null, location.pathname);
    }
    await React.act(async () =>
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: ['/paper/account-a/strategies'] },
          React.createElement(
            Routes,
            null,
            React.createElement(Route, {
              path: '/paper/:accountId/strategies',
              element: React.createElement(Page),
            }),
            React.createElement(Route, {
              path: '/paper/:accountId',
              element: React.createElement('p', null, 'Account detail'),
            }),
          ),
          React.createElement(Location),
        ),
      ),
    );
    const button = (label) =>
      [...document.querySelectorAll('button')].find(
        (value) => value.textContent === label,
      );
    await run({ f, button });
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    global.window = previous.window;
    global.document = previous.document;
    global.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
}

test('saving a combination writes only the chosen account draft without applying or changing route', async () =>
  scenario(async ({ f, button }) => {
    await React.act(async () => button('Save draft').click());
    assert.equal(f.state.requests.length, 1);
    assert.equal(
      f.state.requests[0].args[0],
      '/api/ai-investment/accounts/account-a/strategies/draft',
    );
    assert.equal(f.state.requests[0].args[1].expectedPolicyRevision, 7);
    assert.match(document.body.textContent, /running combination is unchanged/);
    assert.equal(
      document.querySelector('output').textContent,
      '/paper/account-a/strategies',
    );
  }));

test('preview is invalidated by enablement edits and only a fresh explicit apply can publish', async () =>
  scenario(async ({ f, button }) => {
    assert.equal(button('Apply to “Chosen account”'), undefined);
    await React.act(async () =>
      button('Preview changes and execution').click(),
    );
    assert.ok(button('Apply to “Chosen account”'));
    assert.equal(
      f.state.requests.filter((request) => request.args[0].endsWith('/apply'))
        .length,
      0,
    );
    await React.act(async () =>
      document.querySelector('[role="switch"]').click(),
    );
    assert.equal(
      button('Apply to “Chosen account”'),
      undefined,
      'editing removes authority from the previous preview',
    );
    await React.act(async () =>
      button('Preview changes and execution').click(),
    );
    await React.act(async () => button('Apply to “Chosen account”').click());
    const apply = f.state.requests.filter((request) =>
      request.args[0].endsWith('/apply'),
    );
    assert.equal(apply.length, 1);
    assert.equal(
      apply[0].args[0],
      '/api/ai-investment/accounts/account-a/strategies/apply',
    );
    assert.equal(apply[0].args[1].previewHash, 'reviewed-hash');
    assert.equal(apply[0].args[1].allocations[0].enabled, false);
    assert.equal(
      document.querySelector('output').textContent,
      '/paper/account-a',
    );
  }));
