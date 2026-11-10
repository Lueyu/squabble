const assert = require('node:assert/strict');
const { test } = require('node:test');
const { checkBrowserSandbox, sandboxProfile } = require('./check-browser-sandbox.cjs');

test('sandbox probe repairs only a confirmed namespace restriction and retries with sandbox enabled', async () => {
  let probes = 0;
  const installed = [];
  await checkBrowserSandbox({
    executablePath: '/home/runner/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome',
    probe: async () => { if (++probes === 1) throw new Error('No usable sandbox! AppArmor user namespaces'); },
    readRestriction: async () => '1\n',
    installProfile: async executable => installed.push(executable),
    log: () => {},
  });
  assert.equal(probes, 2);
  assert.deepEqual(installed, ['/home/runner/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome']);
});

test('unrelated launch failures and unrestricted kernels fail directly without changing AppArmor', async () => {
  for (const [message, restriction] of [
    ['Missing shared library', '1'],
    ['No usable sandbox! AppArmor disabled user namespaces', '0'],
    ['No usable sandbox!', '1'],
  ]) {
    let installed = false;
    await assert.rejects(checkBrowserSandbox({
      executablePath: '/fixture/chrome', probe: async () => { throw new Error(message); },
      readRestriction: async () => restriction, installProfile: async () => { installed = true; }, log: () => {},
    }), new RegExp(message));
    assert.equal(installed, false);
  }
});

test('CI profile names one exact binary and grants only the userns exception to default unconfined mode', () => {
  const profile = sandboxProfile('/home/runner/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome');
  assert.match(profile, /profile squabble-ci-browser "\/home\/runner\/.cache\/ms-playwright\/chromium-1254\/chrome-linux64\/chrome"/u);
  assert.match(profile, /userns,/u);
  assert.doesNotMatch(profile, /\*|sysctl|no-sandbox/u);
  assert.throws(() => sandboxProfile('/home/runner/**/chrome'));
});
