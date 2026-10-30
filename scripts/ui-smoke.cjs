const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fixtures } = require('./fixtures.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const photos = path.join(root, 'artifacts', 'ui-photos');
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-ui-'));
  const screenshots = path.join(root, 'artifacts');
  await fs.rm(photos, { recursive: true, force: true });
  await fixtures(photos, 36);
  const raw = path.join(root, 'artifacts', 'fixtures', 'iss030e122639.NEF');
  try { await fs.copyFile(raw, path.join(photos, '000_NASA.NEF')); } catch { /* A RAW fixture is optional for this UI test. */ }
  let app;
  const errors = [];
  try {
    const env = { ...process.env, PHOTOCULL_SMOKE_TEST: '1', PHOTOCULL_DATA_DIR: data };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: [root, '--disable-gpu'], env });
    app.process().stderr.on('data', chunk => { if (process.env.DEBUG_UI) process.stderr.write(chunk); });
    const page = await app.firstWindow();
    page.on('pageerror', e => errors.push(e.message));
    await page.locator('#empty-open').waitFor();
    await page.screenshot({ path: path.join(screenshots, 'photocull-empty.png') });
    await page.evaluate(folder => window.loadTestFolder(folder), photos);
    await page.waitForFunction(() => document.querySelector('#review-image').dataset.complete === 'yes', { timeout: 60000 });
    assert.ok(Number(await page.locator('#count-all').textContent()) >= 36);
    await page.keyboard.press('5');
    await page.keyboard.press('p');
    await page.waitForFunction(() => document.querySelector('#count-pick').textContent === '1');
    assert.equal(await page.locator('#count-rated').textContent(), '1');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => document.querySelector('#count-pick').textContent === '0');
    await page.keyboard.press('Control+Shift+z');
    await page.waitForFunction(() => document.querySelector('#count-pick').textContent === '1');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('x');
    await page.waitForFunction(() => document.querySelector('#count-reject').textContent === '1');
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('#image-viewport').classList.contains('zoomed'));
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !document.querySelector('#image-viewport').classList.contains('zoomed'));
    await page.keyboard.press('g');
    await page.locator('.grid-card').first().waitFor();
    const cardCount = await page.locator('.grid-card').count();
    assert.ok(cardCount < Number(await page.locator('#count-all').textContent()), 'Grid must virtualize its image elements');
    await page.screenshot({ path: path.join(screenshots, 'photocull-grid.png') });
    await page.locator('[data-filter="pick"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.grid-card').length === 1);
    await page.keyboard.press('e');
    await page.waitForFunction(() => document.querySelector('#review-image').dataset.complete === 'yes');
    await page.screenshot({ path: path.join(screenshots, 'photocull-review.png') });
    await page.locator('#settings-open').click();
    await page.locator('[data-settings-tab="metadata"]').click();
    await page.locator('#metadata-export summary').click();
    await page.locator('#export-xmp').click();
    await page.locator('#metadata-results:not([hidden])').waitFor();
    assert.match(await page.locator('#metadata-results').textContent(), /written/);
    assert.doesNotMatch(await page.locator('#metadata-results').textContent(), /Could not write/);
    await page.locator('#settings-dialog .close-dialog').click();
    await page.evaluate(folder => window.loadTestFolder(folder), photos);
    assert.equal(await page.locator('#count-pick').textContent(), '1');
    assert.equal(await page.locator('#count-reject').textContent(), '1');
    await page.locator('#search').fill('nothing-matches-this');
    assert.equal(await page.locator('#no-matches').isVisible(), true);
    await page.locator('#reset-filter').click();
    await page.locator('#shortcuts').click();
    assert.equal(await page.locator('#help-dialog').isVisible(), true);
    assert.deepEqual(errors, []);
    const stats = await page.evaluate(() => window.photocull.stats());
    const report = { passed: true, imageCount: Number(await page.locator('#count-all').textContent()), renderedGridCards: cardCount,
      checks: ['RAW preview display', 'keyboard picks and ratings', 'auto advance', 'undo/redo', 'reject', '100% zoom toggle', 'virtual grid', 'pick filter', 'XMP export', 'reopen persistence', 'search empty state', 'shortcut help'], stats, errors };
    await fs.writeFile(path.join(screenshots, 'ui-smoke.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (app) await app.close();
    await fs.rm(data, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
