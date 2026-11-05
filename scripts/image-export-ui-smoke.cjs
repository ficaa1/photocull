// Browser renderer/Node planning smoke; Rust encoders are exercised separately in the Windows app.
const { launch } = require('./launch.cjs');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const sharp = require('sharp');
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-image-export-ui-'));
  const photos = path.join(root, 'photos'), out = path.join(root, 'out'), reports = path.resolve(process.argv[2] || 'artifacts/image-export');
  await fs.mkdir(photos); await fs.mkdir(out); await fs.mkdir(reports, { recursive: true });
  for (const name of ['a.jpg', 'b.jpg']) await sharp({ create: { width: 96, height: 64, channels: 3, background: '#456789' } }).jpeg().toFile(path.join(photos, name));
  const app = await launch({ env: { ...process.env, PHOTOCULL_DATA_DIR: path.join(root, 'state') } });
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    const source = await fs.readFile(path.join(__dirname, '../src/renderer/export.js'), 'utf8');
    await page.route('**/export.js', route => route.fulfill({ contentType: 'text/javascript', body: source + `\nconst realExportInit = PhotoCullExport.init;
PhotoCullExport.init = context => {
  let progress, finish;
  window.exportCalls = [];
  return realExportInit({ ...context, api: { ...context.api, canDevelop: true,
    pickFolder: async () => ${JSON.stringify(out)},
    onExportProgress: callback => { progress = callback; },
    exportPhotos: async (...args) => {
      window.exportCalls.push(args); if (window.stringError) throw 'Native export failed.'; progress({ done: 0, total: args[1].length, name: 'a.jpg' });
      if (window.waitForCancel) return new Promise(resolve => { finish = () => resolve({ results: args[1].map(i => ({ id: i.id, status: 'cancelled' })) }); });
      await new Promise(resolve => setTimeout(resolve, 150));
      return { results: args[1].map((i, n) => ({ id: i.id, status: window.failSecond && n === 1 ? 'failed' : 'exported', error: window.failSecond && n === 1 ? 'Test codec failure' : undefined })) };
    },
    developCancel: async () => { finish?.(); }, revealDestination: async () => { window.revealed = true; },
  } });
};` }));
    await page.reload();
    await page.evaluate(folder => window.loadTestFolder(folder, false), photos);
    await page.keyboard.press('Control+a'); await page.keyboard.press('p');
    await page.waitForFunction(() => document.querySelector('#count-pick').textContent === '2');
    await page.keyboard.press('Control+Shift+E');
    await page.locator('#image-export-dialog').waitFor({ state: 'visible' });
    assert.match(await page.locator('#image-export-counts').innerText(), /2 photos/);
    await page.locator('#image-export-destination').click();
    await page.locator('#image-export-format').selectOption('jxl');
    await page.locator('#image-export-lossless').check();
    await page.locator('#image-export-depth').selectOption('16');
    await page.locator('#image-export-space').selectOption('displayP3');
    await page.locator('#image-export-resize').selectOption('widthHeight');
    await page.locator('#image-export-size').fill('1200'); await page.locator('#image-export-height').fill('800');
    await page.locator('#image-export-sharpen').selectOption('screen');
    await page.locator('#image-export-location').check();
    await page.waitForFunction(() => document.querySelector('#image-export-name-preview').textContent.endsWith('.jxl'));
    await page.evaluate(() => { document.querySelector('.image-export-scroll').scrollTop = 0; });
    await page.screenshot({ path: path.join(reports, 'dialog-jxl.png') });
    await page.locator('#image-export-start').click();
    await page.waitForFunction(() => document.querySelector('#image-export-status').textContent === '2 exported · 0 skipped · 0 failed');
    const calls = await page.evaluate(() => window.exportCalls);
    assert.equal(calls[0][1].length, 2); assert.equal(calls[0][2].jxlLossless, true); assert.equal(calls[0][2].bitDepth, 16);
    assert.deepEqual(calls[0][2].resize, { mode: 'widthHeight', value: 1200, height: 800, dontEnlarge: true });
    assert.equal(calls[0][2].sharpen, 'screen'); assert.equal(calls[0][2].removeLocation, true);
    await page.locator('#image-export-reveal').click(); assert.equal(await page.evaluate(() => window.revealed), true);
    await page.locator('#image-export-close').click(); await page.locator('#image-export').click();
    assert.equal(await page.locator('#image-export-depth').inputValue(), '16'); assert.equal(await page.locator('#image-export-format').inputValue(), 'jxl');
    await page.locator('#image-export-format').selectOption('avif'); assert.equal(await page.locator('#image-export-space').inputValue(), 'srgb'); assert.equal(await page.locator('#image-export-space').isDisabled(), true);
    assert.deepEqual(await page.locator('#image-export-depth option').allTextContents(), ['8-bit', '10-bit']);
    await page.locator('#image-export-format').selectOption('webp'); assert.equal(await page.locator('#image-export-quality-row').isVisible(), false);
    await page.locator('#image-export-name-format').selectOption('custom'); await page.locator('#image-export-name-template').fill('same');
    await page.locator('#image-export-conflict').selectOption('overwrite'); await page.locator('#image-export-start').click();
    await page.waitForFunction(() => document.querySelector('#image-export-status').textContent.includes('has not started'));
    assert.equal(await page.evaluate(() => window.exportCalls.length), 1); assert.match(await page.locator('#image-export-results').innerText(), /Two photos/);
    await page.locator('#image-export-name-template').fill('{filename}');
    await page.evaluate(() => { window.failSecond = true; }); await page.locator('#image-export-start').click();
    await page.waitForFunction(() => document.querySelector('#image-export-status').textContent === '1 exported · 0 skipped · 1 failed');
    assert.match(await page.locator('#image-export-results').innerText(), /Test codec failure/);
    await page.evaluate(() => { window.waitForCancel = true; }); await page.locator('#image-export-start').click();
    await page.waitForFunction(() => window.exportCalls.length === 3); await page.locator('#image-export-cancel').click();
    await page.waitForFunction(() => document.querySelector('#image-export-status').textContent === '0 exported · 2 skipped · 0 failed');
    await page.screenshot({ path: path.join(reports, 'dialog-cancelled.png') });
    await page.evaluate(() => { window.waitForCancel = false; window.stringError = true; }); await page.locator('#image-export-start').click();
    await page.waitForFunction(() => document.querySelector('#image-export-status').textContent === 'Native export failed.');
    await page.locator('#image-export-close').click(); await page.locator('#export').click();
    assert.equal(await page.locator('#export-dialog').isVisible(), true);
    assert.deepEqual(errors, []);
    console.log('PASS finished-image Export UI: format constraints, naming preview, option payload, progress, summary, reveal, last used, duplicate preflight, failures, cancel, Copy picks remains separate.');
    await fs.writeFile(path.join(reports, 'smoke.json'), JSON.stringify({ passed: true, errors, calls }, null, 2));
  } finally { await app.close(); await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
