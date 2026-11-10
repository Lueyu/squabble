const { execFileSync } = require('node:child_process');
const { readFile, realpath } = require('node:fs/promises');
const { chromium } = require('playwright-core');

function sandboxProfile(executablePath) {
  if (!/^\/[a-zA-Z0-9_./-]+\/chrome$/u.test(executablePath) || executablePath.includes('/../')) {
    throw new Error('Expected one exact absolute Chromium executable path');
  }
  // Chromium upstream's per-binary exception retains Chromium's own enabled sandbox.
  return `abi <abi/4.0>,\ninclude <tunables/global>\nprofile squabble-ci-browser "${executablePath}" flags=(unconfined) {\n  userns,\n}\n`;
}

async function probeSandbox(executablePath) {
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, timeout: 15_000,
      args: ['--disable-background-networking', '--no-first-run'] });
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    const page = await context.newPage();
    await page.goto('about:blank', { timeout: 5000 });
  } finally { await browser?.close(); }
}

async function installProfile(executablePath) {
  if (process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('Automatic AppArmor setup is restricted to the Linux GitHub Actions runner');
  }
  const filename = '/etc/apparmor.d/squabble-ci-browser';
  execFileSync('sudo', ['-n', 'tee', filename], { input: sandboxProfile(executablePath), stdio: ['pipe', 'ignore', 'pipe'], timeout: 10_000 });
  execFileSync('sudo', ['-n', 'apparmor_parser', '-r', filename], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
}

async function checkBrowserSandbox(dependencies = {}) {
  const executablePath = dependencies.executablePath ?? await realpath(chromium.executablePath());
  const probe = dependencies.probe ?? probeSandbox;
  const log = dependencies.log ?? console.log;
  try {
    await probe(executablePath);
    log('Chromium sandbox preflight passed');
    return;
  } catch (error) {
    // This standalone probe has no account, proxy credentials or saved state. Preserve its actual launch cause.
    log(`Chromium sandbox preflight failed: ${error instanceof Error ? error.stack : String(error)}`);
    const cause = error instanceof Error ? error.message : String(error);
    const namespaceDenied = /AppArmor/iu.test(cause) && /userns|user[\s-]+namespaces?/iu.test(cause)
      && /No usable sandbox|denied|restricted|disabled|Operation not permitted/iu.test(cause);
    if (!namespaceDenied) throw error;
    let restriction;
    try {
      restriction = await (dependencies.readRestriction
        ?? (() => readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8')))();
    } catch { throw error; }
    if (restriction.trim() !== '1') throw error;
    log(`Confirmed sandbox namespace denial with AppArmor restriction=1; allowing only ${executablePath}`);
    await (dependencies.installProfile ?? installProfile)(executablePath);
    await probe(executablePath);
    log('Chromium sandbox preflight passed after the per-binary AppArmor userns profile');
  }
}

module.exports = { checkBrowserSandbox, sandboxProfile };
if (require.main === module) {
  checkBrowserSandbox().catch(error => { console.error(error); process.exitCode = 1; });
}
