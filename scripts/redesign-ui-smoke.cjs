// node redesign-ui-smoke.cjs EXECUTABLE|- REPORT_FOLDER [SONY_FIXTURE_FOLDER]
// Exercises the real UI with disposable photos and isolated app state.
const { launch: launchApp } = require('./launch.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
async function main() {
  const root = path.resolve(__dirname, '..');
  let executable = process.argv[2] || '-';
  if (executable !== '-') { executable = path.resolve(executable); if (executable.endsWith('.app')) executable = path.join(executable, 'Contents', 'MacOS', 'PhotoCull'); }
  const output = path.resolve(process.argv[3] || path.join(root, 'artifacts', 'redesign-validation'));
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-redesign-'));
  const photos = path.join(dataRoot, 'photos'), data = path.join(dataRoot, 'state');
  await fs.mkdir(photos); await fs.mkdir(output, { recursive: true });
  const appPackage = executable === '-' ? path.join(root, 'package.json') : process.platform === 'darwin' ? path.resolve(path.dirname(executable), '../Resources/app/package.json') : path.join(path.dirname(executable), 'resources', 'app', 'package.json');
  const sharp = createRequire(appPackage)('sharp');
  for (let i = 1; i <= 36; i++) {
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: i % 2 ? '#637b87' : '#817a69' } }).jpeg().toFile(path.join(photos, `${String(i).padStart(3, '0')}_photo.JPG`));
  }
  if (process.argv[4]) await fs.copyFile(path.join(path.resolve(process.argv[4]), 'sample-01.ARW'), path.join(photos, '000_camera.ARW'));
  const errors = [], checks = [];
  let app, page;
  async function launch() {
    const env = { ...process.env, PHOTOCULL_SMOKE_TEST: '1', PHOTOCULL_DATA_DIR: data }; 
    app = await launchApp({ env });
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.locator('#empty-open').waitFor();
    await page.evaluate(folder => window.loadTestFolder(folder), photos);
    await page.waitForFunction(() => document.querySelector('#review-image').dataset.complete === 'yes', null, { timeout: 60000 });
  }
  async function screenshot(name) { await page.screenshot({ path: path.join(output, `${name}-${process.platform}.png`) }); }
  try {
    await launch(); await screenshot('review');
    const before = await page.locator('#image-stage').boundingBox();
    await page.locator('#toggle-inspector').click();
    const after = await page.locator('#image-stage').boundingBox(); assert.ok(after.width > before.width + 100);
    await page.keyboard.press('i'); assert.equal(await page.locator('#toggle-inspector').getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('b'); assert.equal(await page.locator('#toggle-sidebar').getAttribute('aria-expanded'), 'false');
    await page.keyboard.press('b'); checks.push('source/details toggles reclaim photo space and B/I shortcuts work');
    await page.evaluate(() => { window.testRatingNode = document.querySelector('#rating button'); window.testFilmNode = document.querySelector('.film-card img'); });
    await page.keyboard.press('5');
    assert.equal(await page.evaluate(() => window.testRatingNode === document.querySelector('#rating button')), true);
    assert.equal(await page.evaluate(() => window.testFilmNode === document.querySelector('.film-card img')), true);
    checks.push('rating and loaded thumbnail nodes are retained during decisions');
    await page.keyboard.press('p'); await page.waitForFunction(() => document.querySelector('#count-pick').textContent === '1');
    await page.locator('#export').click(); await screenshot('copy'); await page.locator('#export-dialog .close-dialog').click();
    await page.locator('#settings-open').click(); await page.locator('[data-settings-tab="metadata"]').click();
    await page.waitForTimeout(120); await screenshot('metadata');
    await page.locator('[data-settings-tab="colors"]').click(); await page.waitForTimeout(120); await screenshot('colors');
    await page.locator('#settings-cancel').click(); checks.push('copy, metadata and palette controls remain accessible');
    await page.locator('#grid-mode').click(); await page.locator('.grid-card').first().waitFor(); await screenshot('grid');
    const count = await page.locator('.grid-card').count();
    await page.locator('#grid-size').fill('300'); await page.locator('#grid-size').dispatchEvent('input');
    await page.waitForFunction(previous => document.querySelectorAll('.grid-card').length < previous, count);
    checks.push('thumbnail size changes contact-sheet density while preserving virtualization');
    await page.setViewportSize({ width: 1024, height: 700 });
    await page.waitForTimeout(150); await screenshot('compact-grid');
    await page.locator('#review-mode').click(); await page.waitForFunction(() => document.querySelector('#review-image').dataset.complete === 'yes');
    await screenshot('compact-review');
    for (const id of ['pick','reject','zoom','zoom-percent','fullscreen','toggle-sidebar','toggle-inspector']) {
      const box = await page.locator('#' + id).boundingBox(); assert.ok(box && box.width > 0 && box.height > 0, `${id} must remain accessible at 1024 × 700`);
    }
    // Tab must move focus through actual controls, rather than changing views.
    await page.locator('#toggle-sidebar').focus(); await page.keyboard.press('Tab');
    assert.equal(await page.locator('#open-folder').evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('#toggle-sidebar').evaluate(node => node === document.activeElement), true);
    const expanded = await page.locator('#toggle-sidebar').getAttribute('aria-expanded');
    await page.keyboard.press('Space'); assert.notEqual(await page.locator('#toggle-sidebar').getAttribute('aria-expanded'), expanded);
    await page.keyboard.press('Space'); assert.equal(await page.locator('#toggle-sidebar').getAttribute('aria-expanded'), expanded);
    await page.locator('#image-viewport').focus();
    assert.equal(await page.locator('#image-viewport').evaluate(node => node === document.activeElement), true);
    const focus = await page.locator('#image-viewport').evaluate(node => getComputedStyle(node).outlineStyle); assert.notEqual(focus, 'none');
    checks.push('1024 × 700 layout retains core controls and visible keyboard focus');
    await page.locator('#fullscreen').click(); await page.waitForFunction(() => document.body.classList.contains('fullscreen-review'));
    await page.waitForFunction(() => !document.body.classList.contains('filmstrip-visible'), null, { timeout: 6000 });
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight })); await page.mouse.move(viewport.width / 2, viewport.height - 3);
    await page.waitForFunction(() => document.body.classList.contains('filmstrip-visible')); await page.waitForTimeout(200); await screenshot('fullscreen-filmstrip');
    await page.mouse.move(viewport.width / 2, viewport.height / 2); await page.waitForFunction(() => !document.body.classList.contains('filmstrip-visible'));
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.body.classList.contains('fullscreen-review'));
    checks.push('fullscreen filmstrip reveals at the bottom edge and hides when the pointer leaves');
    await page.locator('#toggle-inspector').click();
    await app.close(); app = null; await launch();
    assert.equal(await page.locator('#toggle-inspector').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#grid-size').inputValue(), '300');
    checks.push('pane visibility and contact-sheet size persist between launches');
    for (const width of [320, 720]) {
      await page.setViewportSize({width, height: 700});
      for (const id of ['open-folder','compact-workspace','output-button','toggle-sidebar','toggle-inspector']) {
        assert.ok(await page.locator('#'+id).evaluate(node => {
          const r = node.getBoundingClientRect();
          return node.contains(document.elementFromPoint(r.x+r.width/2, r.y+r.height/2));
        }), `${id} reachable at ${width}px`);
      }
      await page.locator('#output-button').click();
      assert.ok(await page.getByRole('menuitem',{name:'Contact Sheet…',exact:true}).isVisible());
      await page.keyboard.press('Escape');
    }
    checks.push('compact workspace and output actions are reachable at 320 and 720 px');
    await page.setViewportSize({width: 1280, height: 800});
    await page.evaluate(async () => syncSettings(await api.settings({writeSidecars:'never'})));
    const emptyFolder = path.join(dataRoot, 'empty');
    await fs.mkdir(path.join(emptyFolder, 'child'), { recursive: true });
    await fs.copyFile(path.join(photos, '001_photo.JPG'), path.join(emptyFolder, 'child', 'nested.jpg'));
    await page.evaluate(folder => window.loadTestFolder(folder, false), emptyFolder);
    assert.equal(await page.locator('.empty-title').textContent(), 'No photos in this folder');
    await page.locator('#empty-subfolders').click();
    await page.waitForFunction(() => document.querySelector('#photo-name').textContent === 'nested.jpg');
    await page.evaluate(folder => window.loadTestFolder(folder), photos);
    await page.locator('.film-card').nth(2).click();
    await page.locator('#image-viewport').focus();
    const firstName = await page.locator('#photo-name').textContent();
    let rejectOnce = true;
    await page.route('**/rpc*', async route => {
      if (rejectOnce && route.request().postDataJSON()?.method === 'decide') {
        rejectOnce = false;
        return route.fulfill({json:{ok:false,error:'Disk full'}});
      }
      return route.continue();
    });
    await page.keyboard.press('p');
    const failure = page.locator('#unsaved-decisions');
    await failure.waitFor();
    assert.ok((await failure.innerText()).includes(`Pick for ${firstName} is unsaved. Free up space`));
    assert.notEqual(await page.locator('#photo-name').textContent(), firstName);
    await page.keyboard.press('p');
    await page.waitForFunction(() => !state.pendingSaves);
    await page.evaluate(folder => window.loadTestFolder(folder, false), emptyFolder);
    assert.equal(await failure.isVisible(), false);
    await page.evaluate(folder => window.loadTestFolder(folder), photos);
    await failure.getByRole('button').press('Enter');
    await failure.waitFor({state:'hidden'});
    await page.evaluate(folder => window.loadTestFolder(folder), photos);
    assert.equal(await page.evaluate(name => state.session.items.find(item => item.name === name).flag, firstName), 'pick');
    await page.locator('.film-card').nth(4).click();
    const trashName = await page.locator('#photo-name').textContent();
    rejectOnce = true;
    await page.keyboard.press('Backspace');
    await failure.waitFor();
    assert.equal(await page.evaluate(() => scopeItems('trash').length), 0);
    await failure.getByRole('button').press('Enter');
    await failure.waitFor({state:'hidden'});
    await page.evaluate(folder => window.loadTestFolder(folder), photos);
    assert.equal(await page.evaluate(name => state.session.items.find(item => item.name === name).trashed, trashName), true);

    await page.locator('.film-card').nth(3).click();
    const rejectName = await page.locator('#photo-name').textContent();
    rejectOnce = true;
    await page.keyboard.press('x');
    await failure.waitFor();
    await page.evaluate(async name => {
      const item = state.session.items.find(i => i.name === name);
      await api.decide(state.session.id, item.id, {flag:'pick'});
    }, rejectName);
    await page.evaluate(folder => window.loadTestFolder(folder), photos);
    assert.equal(await page.evaluate(name => scopeItems('reject').some(item => item.name === name), rejectName), false);
    assert.equal(await page.evaluate(name => state.session.items.find(item => item.name === name).flag, rejectName), 'pick');
    await failure.getByRole('button').press('Enter');
    await failure.waitFor({state:'hidden'});
    assert.equal(await page.evaluate(name => state.session.items.find(item => item.name === name).flag, rejectName), 'pick');
    await page.locator('.film-card').nth(1).click();
    const keepName = await page.locator('#photo-name').textContent();
    rejectOnce = true;
    await page.keyboard.press('Backspace');
    await failure.waitFor();
    await page.locator('[data-filter=trash]').click();
    await page.getByRole('button',{name:keepName,exact:true}).click();
    await page.keyboard.press('p');
    await page.waitForFunction(() => !state.pendingSaves);
    await page.evaluate(folder => window.loadTestFolder(folder), photos);
    await failure.getByRole('button').press('Enter');
    await failure.waitFor({state:'hidden'});
    assert.equal(await page.evaluate(name => scopeItems('trash').some(item => item.name === name), keepName), false);
    assert.deepEqual(await page.evaluate(name => {
      const item = state.session.items.find(i => i.name === name);
      return [item.flag, item.trashed];
    }, keepName), ['pick', false]);
    checks.push('empty folder can include subfolders, failed pick retries its original photo after auto-advance and reopening');
    await page.locator('#grid-mode').click();
    const cards = page.locator('.grid-card');
    await cards.first().click();
    await cards.nth(1).click({modifiers:['Shift']});
    const firstNameInPair = await cards.first().getAttribute('aria-label');
    await page.keyboard.press('c');
    assert.equal(await page.locator('#photo-name').textContent(), firstNameInPair);
    const otherRating = await page.locator('.compare-pane:not(.active) select').inputValue();
    await page.keyboard.press('3');
    await page.waitForFunction(() => document.querySelector('.compare-pane.active select').value === '3');
    assert.equal(await page.locator('.compare-pane:not(.active) select').inputValue(), otherRating);
    await page.keyboard.press('c');
    await page.locator('#grid-mode').click();
    await cards.first().click();
    await cards.nth(5).click({modifiers:['Shift']});
    await page.keyboard.press('c');
    await page.locator('.compare-pages').getByRole('button',{name:'Next 2'}).click();
    assert.equal(await page.locator('.compare-pages [role=status]').textContent(), 'Photos 5–6 of 6 selected');
    await page.keyboard.press('4');
    await page.waitForFunction(() => document.querySelector('.compare-pane.active select').value === '4');
    await page.locator('.compare-pages').getByRole('button',{name:'Previous 4'}).click();
    assert.equal(await page.locator('.compare-pane').count(), 4);
    checks.push('six selected frames page in order and accept decisions on the second page');
    assert.deepEqual(errors, []);
    const report = { passed: true, platform: process.platform, checks, errors };
    await fs.writeFile(path.join(output, `redesign-ui-${process.platform}.json`), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  } finally { if (app) await app.close(); await fs.rm(dataRoot, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
