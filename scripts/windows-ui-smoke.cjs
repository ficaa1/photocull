// Invoke with Windows Node.js: node windows-ui-smoke.cjs PATH_TO_PhotoCull.exe PATH_TO_FIXTURES
const { _electron: electron } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function main() {
  assert.equal(process.platform, 'win32');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-win-ui-'));
  const photos = path.join(root, 'photos'); await fs.mkdir(photos);
  const fixtureRoot = path.resolve(process.argv[3]);
  await fs.copyFile(path.join(fixtureRoot, 'fixtures', 'iss030e122639.NEF'), path.join(photos, '000_raw.NEF'));
  await fs.copyFile(path.join(fixtureRoot, 'ui-photos', 'DSC_0001.jpg'), path.join(photos, '001_photo.jpg'));
  const errors = [];
  let app;
  try {
    const env = { ...process.env, PHOTOCULL_SMOKE_TEST: '1', PHOTOCULL_DATA_DIR: path.join(root, 'state') };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: path.resolve(process.argv[2]), args: ['--disable-gpu'], cwd: root, env, timeout: 30000 });
    const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
    await page.locator('#empty-open').waitFor();
    await page.evaluate(folder => window.loadTestFolder(folder), photos);
    await page.waitForFunction(() => document.querySelector('#review-image').dataset.complete === 'yes', { timeout: 30000 });
    assert.equal(await page.locator('#count-all').textContent(), '2');
    await page.keyboard.press('4'); await page.keyboard.press('p');
    await page.waitForFunction(() => document.querySelector('#count-pick').textContent === '1');
    await page.keyboard.press('x');
    await page.waitForFunction(() => document.querySelector('#count-reject').textContent === '1');
    await page.locator('#settings-open').click();
    await page.locator('[data-settings-tab="metadata"]').click();
    await page.locator('#metadata-export summary').click(); await page.locator('#export-xmp').click();
    await page.locator('#metadata-results:not([hidden])').waitFor();
    assert.match(await page.locator('#metadata-results').textContent(), /2 written/);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(fixtureRoot, 'photocull-windows.png') });
    const report = { passed: true, platform: 'win32', electron: await app.evaluate(({ app }) => process.versions.electron),
      checks: ['native packaged Windows GUI startup', 'RAW embedded preview in Windows renderer', 'keyboard pick, reject and rating', 'XMP export from Windows GUI'], errors };
    await fs.writeFile(path.join(fixtureRoot, 'windows-ui-smoke.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { if (app) await app.close(); await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
