// node raw-ui-smoke.cjs EXECUTABLE CASE_FOLDER REPORT_FOLDER
// EXECUTABLE may be '-' for this development checkout's Electron.
const { _electron: electron } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
async function main() {
  const executable = process.argv[2], cases = path.resolve(process.argv[3]), reports = path.resolve(process.argv[4]);
  await fs.mkdir(reports, { recursive: true });
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-raw-ui-'));
  const errors = []; const checks = []; let app, page;
  async function launch() {
    const env = { ...process.env, PHOTOCULL_SMOKE_TEST: '1', PHOTOCULL_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ ...(executable === '-' ? { args: [path.resolve(__dirname, '..'), '--disable-gpu'] } : { executablePath: path.resolve(executable), args: ['--disable-gpu'], cwd: path.dirname(path.resolve(executable)) }), env, timeout: 30000 });
    page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
    await page.locator('#settings-open').waitFor();
  }
  async function policy(value) { await page.locator('#settings-open').click(); await page.locator('#raw-rendering').selectOption(value); await page.locator('#settings-save').click(); }
  async function open(name) { await page.evaluate(folder => window.loadTestFolder(folder), path.join(cases, name)); }
  async function complete() { await page.waitForFunction(() => document.querySelector('#review-image').dataset.complete === 'yes', null, { timeout: 90000 }); }
  async function source(pattern) { await page.waitForFunction(text => document.querySelector('#preview-source').textContent.includes(text), pattern, { timeout: 90000 }); }
  try {
    await launch();
    await policy('off');
    await open('no-previews'); await page.locator('#image-error:not([hidden])').waitFor({ timeout: 60000 });
    assert.equal((await page.evaluate(() => window.photocull.stats())).renders, 0); checks.push('rendering off rejects previewless RAW');
    await policy('missing'); await complete(); await source('Rendered RAW');
    checks.push('sensor rendering displays stripped Sony RAW');
    await page.locator('#zoom-percent').selectOption('100'); await complete(); await source('full size');
    const size = await page.locator('#review-image').evaluate(img => [img.naturalWidth, img.naturalHeight]); assert.ok(Math.max(...size) > 6000);
    checks.push('full-size RAW rendering for zoom');
    await page.screenshot({ path: path.join(reports, `raw-full-${process.platform}.png`) });
    await app.close(); app = null; await launch();
    await open('no-previews'); await complete(); await source('Rendered RAW');
    assert.equal((await page.evaluate(() => window.photocull.stats())).renders, 0); checks.push('rendered image reused across application restart');
    await open('small-preview'); await complete(); await source('ThumbnailImage');
    assert.match(await page.locator('#preview-status').textContent(), /Limited resolution/);
    await policy('small'); await complete(); await source('Rendered RAW'); checks.push('small embedded preview upgraded on request');
    await open('corrupt'); await page.locator('#retry-preview:not([hidden])').waitFor({ timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('#image-loading').hidden);
    const before = await page.evaluate(() => window.photocull.stats());
    await page.locator('#retry-preview').click();
    await page.waitForFunction(n => window.photocull.stats().then(s => s.renders > n && s.renderFailures > n), before.renderFailures, { timeout: 60000 });
    await page.locator('#retry-preview:not([hidden])').waitFor({ timeout: 60000 }); checks.push('corrupt RAW shows retry and can be retried');
    await app.close(); app = null; await launch(); await open('corrupt');
    await page.locator('#retry-preview:not([hidden])').waitFor({ timeout: 60000 });
    const after = await page.evaluate(() => window.photocull.stats());
    assert.equal(after.renders, 0); assert.ok(after.blockedRenders > 0); checks.push('unsupported RAW suppressed after restart');
    assert.equal((await page.evaluate(() => window.photocull.settings())).rawRendering, 'small'); checks.push('render policy persists');
    assert.deepEqual(errors, []);
    const report = { passed: true, platform: process.platform, checks, fullImagePixels: size, stats: after, errors };
    await fs.writeFile(path.join(reports, `raw-ui-${process.platform}.json`), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  } finally { if (app) await app.close(); await fs.rm(data, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
