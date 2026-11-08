const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { launch } = require('./launch.cjs');
const { externalEditFixtures } = require('./external-edit-fixtures.cjs');

async function scenario(bulkAccept) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-external-ui-'));
  let app;
  try {
    const f = await externalEditFixtures(root, 11), errors = [], failedImages = [];
    app = await launch({ env: { ...process.env, PHOTOCULL_DATA_DIR: f.data } });
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (/\/image\//.test(response.url()) && response.status() >= 400) failedImages.push(response.status()); });
    await page.evaluate(folder => window.loadTestFolder(folder), f.photos);
    await page.waitForFunction(() => document.querySelector('#count-external').textContent === '1 (10)');
    await page.locator('[data-filter="external"]').click();
    await page.locator('.proposal-card').first().waitFor();
    assert.equal(await page.locator('.grid-card').count(), 1);
    assert.equal(await page.locator('.proposal-card').count(), 10);
    const linked = await page.locator('.grid-card').first().boundingBox(), proposed = await page.locator('#external-proposals').boundingBox();
    assert.ok(proposed.y >= linked.y + linked.height, 'proposals appear below existing edits');
    await page.evaluate(async () => {
      for (const image of document.querySelectorAll('.proposal-images img')) image.loading = 'eager';
      for (let frame = 0; frame < 20; frame++) {
        await api.visible(state.session.id, state.selected ? [state.selected] : []);
        await new Promise(requestAnimationFrame);
      }
      document.querySelector('#grid').scrollTop = document.querySelector('#grid').scrollHeight;
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.proposal-images img')].every(image => image.complete && image.naturalWidth > 0));
    assert.deepEqual(failedImages, [], 'all original and proposed thumbnails survive visibility updates');
    await page.evaluate(() => { document.querySelector('#grid').scrollTop = 0; });
    if (bulkAccept) {
      await page.locator('.proposal-card').first().getByRole('button', { name: 'Reject', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#count-external').textContent === '1 (9)');
      await page.locator('#proposal-accept-all').click();
    } else {
      await page.locator('.proposal-card').first().getByRole('button', { name: 'Accept', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#count-external').textContent === '2 (9)');
      await page.locator('#proposal-reject-all').click();
    }
    const accepted = bulkAccept ? 10 : 2;
    await page.waitForFunction(n => document.querySelector('#count-external').textContent === String(n), accepted);
    assert.equal(await page.locator('#external-proposals').isVisible(), false);
    await page.evaluate(folder => window.loadTestFolder(folder), f.photos);
    await page.locator('[data-filter="external"]').click();
    await page.waitForFunction(() => document.querySelector('#external-proposals').hidden);
    await page.waitForFunction(n => document.querySelectorAll('.grid-card').length === n, accepted);
    assert.equal(await page.locator('#count-external').textContent(), String(accepted));
    assert.equal(await page.locator('.grid-card').count(), accepted);
    assert.deepEqual(errors, []);
  } finally {
    await app?.close(); await fs.rm(root, { recursive: true, force: true });
  }
}

(async () => { await scenario(false); await scenario(true); console.log('External edit proposal UI passed.'); })().catch(error => { console.error(error); process.exitCode = 1; });
