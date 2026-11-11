const { chromium } = require('playwright');

(async () => {
  if (process.getuid?.() === 0) throw new Error('BROWSER_ROOT_REJECTED');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<main id="result">pending</main><script>document.querySelector("main").textContent="dynamic Chromium ready"</script>');
    if (await page.locator('main').textContent() !== 'dynamic Chromium ready') throw new Error('BROWSER_RENDER_FAILED');
    console.log(JSON.stringify({ ready: true, uid: process.getuid(), chromiumSandbox: true, version: browser.version(), executable: chromium.executablePath() }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
