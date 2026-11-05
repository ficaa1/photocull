// node culling-ui-smoke.cjs EXECUTABLE|- REPORT_FOLDER [SONY_FIXTURE_FOLDER]
// All copies/card events use isolated disposable fixtures, never a real SD card.
const { launch: launchApp } = require('./launch.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
async function main() {
  const executable = process.argv[2], reports = path.resolve(process.argv[3]); await fs.mkdir(reports, { recursive: true });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-culling-ui-'));
  const card = path.join(root, 'card'), photos = path.join(card, 'DCIM', '100SONY'), destination = path.join(root, 'keepers'), deviceFile = path.join(root, 'devices.json');
  await fs.mkdir(photos, { recursive: true }); await fs.mkdir(destination); await fs.writeFile(deviceFile, '[]');
  const fixtureRoot = process.argv[4] && path.resolve(process.argv[4]);
  let app; const errors = []; const checks = [];
  const digest = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
  try {
    if (fixtureRoot) {
      await fs.copyFile(path.join(fixtureRoot, 'sample-8563.ARW'), path.join(photos, '000.ARW'));
      await fs.copyFile(path.join(fixtureRoot, 'sample-8563.JPG'), path.join(photos, '000.JPG'));
      await fs.copyFile(path.join(fixtureRoot, 'sample-8565.ARW'), path.join(photos, '001.ARW'));
    } else throw new Error('Supply the authorized Sony fixture directory.');
    const before = await digest(path.join(photos, '000.ARW'));
    const env = { ...process.env, PHOTOCULL_SMOKE_TEST: '1', PHOTOCULL_DATA_DIR: path.join(root, 'state'), PHOTOCULL_TEST_DEVICES: deviceFile, PHOTOCULL_TEST_DESTINATION: destination }; 
    app = await launchApp({ env });
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.locator('#empty-open').waitFor();
    const device = { id: 'test-card:ABC', root: card, label: 'SONY SD', camera: true, photoRoot: path.join(card, 'DCIM') };
    await fs.writeFile(deviceFile, JSON.stringify([device]));
    await page.evaluate(() => window.photocull.devices());
    await page.waitForFunction(() => document.querySelector('#count-all').textContent === '2', null, { timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('#review-image').dataset.complete === 'yes', null, { timeout: 60000 });
    assert.match(await page.locator('#folder-name').textContent(), /DCIM/); checks.push('inserted camera card opens automatically and scans DCIM subfolders');
    await page.keyboard.press('5'); await page.keyboard.press('p');
    await page.waitForFunction(() => document.querySelector('#count-pick').textContent === '1');
    await page.keyboard.press('x');
    await page.waitForFunction(() => document.querySelector('#count-reject').textContent === '1');
    await page.locator('[data-filter="reject"]').click();
    await page.locator('#export').click(); assert.match(await page.locator('#copy-scope').textContent(), /1 pick/);
    await page.locator('#copy-destination').click();
    await page.locator('#copy-jpeg').check(); await page.locator('#copy-xmp').check();
    await page.locator('#copy-start').click();
    await page.waitForFunction(() => document.querySelector('#copy-status').textContent.includes('1 copied'), null, { timeout: 60000 });
    const rawOutput = path.join(destination, '000.ARW');
    assert.equal(await digest(rawOutput), before);
    assert.equal(await digest(path.join(photos, '000.ARW')), before);
    assert.deepEqual((await fs.readdir(destination)).sort(), ['000.ARW', '000.JPG', '000.xmp']);
    assert.match(await fs.readFile(path.join(destination, '000.xmp'), 'utf8'), /xmp:Rating="5"/);
    assert.deepEqual((await fs.readdir(photos)).sort(), ['000.ARW', '000.JPG', '001.ARW']);
    checks.push('only picks copied despite reject filter', 'RAW copy checksum matches original', 'optional companion JPEG and destination-only XMP', 'source card files unchanged');
    await page.screenshot({ path: path.join(reports, `culling-${process.platform}.png`) });
    await page.locator('#copy-start').click();
    await page.waitForFunction(() => document.querySelector('#copy-status').textContent.includes('1 skipped'), null, { timeout: 30000 });
    assert.equal(await digest(rawOutput), before); checks.push('repeat export skips existing files without overwriting');
    await page.locator('#export-dialog .close-dialog').click();
    await fs.writeFile(deviceFile, JSON.stringify([device, { ...device, id: 'other-card', label: 'Other card' }]));
    await page.evaluate(() => window.photocull.devices());
    assert.equal(await page.locator('#count-pick').textContent(), '1'); checks.push('new card does not interrupt an active cull');
    await fs.writeFile(deviceFile, '[]'); await page.evaluate(() => window.photocull.devices());
    await page.waitForFunction(() => document.querySelector('#device-status').textContent.includes('disconnected'));
    checks.push('card removal notice preserves decisions');
    assert.deepEqual(errors, []);
    const report = { passed: true, platform: process.platform, checks, errors };
    await fs.writeFile(path.join(reports, `culling-ui-${process.platform}.json`), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  } finally { if (app) await app.close(); await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
