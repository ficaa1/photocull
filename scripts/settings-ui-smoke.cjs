// node settings-ui-smoke.cjs EXECUTABLE|- REPORT_FOLDER SONY_FIXTURE_FOLDER
const { launch: launchApp } = require('./launch.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { updateXmp } = require('../src/xmp.cjs');
async function main() {
  const executable = process.argv[2], reports = path.resolve(process.argv[3]), fixture = path.resolve(process.argv[4]);
  await fs.mkdir(reports,{recursive:true}); const root=await fs.mkdtemp(path.join(os.tmpdir(),'photocull-settings-ui-'));
  const photos=path.join(root,'photos'), destination=path.join(root,'out'), data=path.join(root,'state');await fs.mkdir(photos);await fs.mkdir(destination);
  await fs.copyFile(path.join(fixture,'sample-01.ARW'),path.join(photos,'a.ARW'));await fs.copyFile(path.join(fixture,'sample-01.JPG'),path.join(photos,'a.JPG'));await fs.copyFile(path.join(fixture,'sample-02.JPG'),path.join(photos,'b.JPG'));
  const errors=[], checks=[]; let app,page;
  // The backend applies writes in order; poll it from Node so an in-flight write cannot satisfy the wait.
  async function waitForSettings(test){for(let i=0;i<200;i++){if(test(await page.evaluate(()=>window.photocull.settings())))return;await new Promise(r=>setTimeout(r,25));}throw new Error('Settings did not reach the expected state.');}
  async function launch() {
    const env={...process.env,PHOTOCULL_SMOKE_TEST:'1',PHOTOCULL_DATA_DIR:data,PHOTOCULL_TEST_DESTINATION:destination};
    app=await launchApp({ env });
    page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));await page.locator('#settings-open').waitFor();
    await page.evaluate(folder=>window.loadTestFolder(folder),photos);await page.waitForFunction(()=>document.querySelector('#review-image').dataset.complete==='yes',null,{timeout:60000});
  }
  try {
    await launch();
    await page.locator('#settings-open').click();
    await page.locator('[data-settings-tab="about"]').click();
    await page.waitForFunction(()=>document.querySelector('#about-name').textContent.includes('0.8.0'));
    assert.match(await page.locator('[data-settings-page="about"]').textContent(),/MIT License/);
    assert.match(await page.locator('[data-settings-page="about"]').textContent(),/RAW engine: Lightcraft/);
    assert.match(await page.locator('#about-notices').textContent(),/LibRaw/);
    checks.push('About shows version, MIT, engine credit and bundled local notices');
    await page.locator('[data-settings-tab="general"]').click();await page.locator('#auto-advance').uncheck();assert.equal(await page.locator('#write-sidecars').inputValue(),'except-cards');await page.locator('#write-sidecars').selectOption('never');
    await page.locator('[data-settings-tab="metadata"]').click();await page.locator('#meta-creator').fill('Test Photographer & friends');await page.locator('#meta-copyright').fill('© 2026 Test Photographer');await page.locator('#meta-keywords').fill('travel, test');
    await page.locator('[data-settings-tab="colors"]').click();await page.locator('[data-id="4"] [data-field="name"]').fill('Review');await page.locator('[data-id="4"] [data-field="label"]').fill('To edit');
    await page.screenshot({path:path.join(reports,`settings-colors-${process.platform}.png`)});
    await page.locator('[data-settings-tab="naming"]').click();await page.locator('#settings-name-format').selectOption('custom');await page.locator('#settings-name-template').fill('{text}_{capturedate}_{seq:3}');await page.locator('#settings-name-text').fill('Trip');await page.locator('#settings-name-start').fill('7');
    await page.waitForFunction(()=>document.querySelector('#settings-name-preview').textContent==='Trip_20260926_007.ARW');
    await page.locator('[data-settings-tab="metadata"]').click();await page.locator('#preset-name').fill('Travel');await page.locator('#preset-save').click();await page.waitForFunction(()=>document.querySelector('#metadata-preset').selectedOptions[0].textContent==='Travel');
    await page.locator('#settings-save').click();await page.locator('#settings-dialog').waitFor({state:'hidden'});
    const settings=await page.evaluate(()=>window.photocull.settings());assert.equal(settings.metadata.creator,'Test Photographer & friends');assert.equal(settings.autoAdvance,false);assert.equal(settings.writeSidecars,'never');assert.equal(settings.colors[3].label,'To edit');checks.push('settings save and named preset include metadata, palette, filename template and XMP policy');
    await page.keyboard.press('Alt+4');await page.keyboard.press('5');await page.keyboard.press('p');await page.waitForFunction(()=>document.querySelector('#count-pick').textContent==='1');
    assert.equal(await page.locator('#photo-name').textContent(),'a.ARW');assert.equal(await page.locator('#color-labels button[aria-label="Review"]').getAttribute('aria-pressed'),'true');
    await page.locator('#color-filter').selectOption('4');assert.equal(await page.locator('#view-count').textContent(),'1');await page.locator('#color-filter').selectOption('');checks.push('independent color shortcut, selected swatch, and color filter');
    await page.locator('#export').click();await page.locator('#copy-destination').click();await page.locator('#copy-xmp').check();await page.locator('#copy-jpeg').check();await page.waitForFunction(()=>document.querySelector('#copy-name-preview').textContent==='Trip_20260926_007.ARW');
    assert.equal(await page.locator('#export-dialog p').count(),2);await page.screenshot({path:path.join(reports,`copy-compact-${process.platform}.png`)});
    await page.locator('#copy-start').click();await page.waitForFunction(()=>document.querySelector('#copy-status').textContent.startsWith('1 copied'),null,{timeout:60000});
    assert.deepEqual((await fs.readdir(destination)).sort(),['Trip_20260926_007.ARW','Trip_20260926_007.JPG','Trip_20260926_007.xmp']);
    const xmp=await fs.readFile(path.join(destination,'Trip_20260926_007.xmp'),'utf8');assert.match(xmp,/xmp:Label="To edit"/);assert.match(xmp,/Test Photographer &amp; friends/);assert.match(xmp,/>travel</);assert.match(xmp,/xmp:Rating="5"/);checks.push('live filename preview and matching RAW/JPEG/XMP export with preset metadata');
    await app.close();app=null;
    await fs.writeFile(path.join(photos,'a.xmp'),updateXmp('',{path:path.join(photos,'a.ARW'),flag:'pick',rating:5,color:'4',modified:Date.now()+5000,develop:{recipe:'neutral',tiff:path.join(photos,'_develop','missing.tif'),editedBy:'dehancer'}},settings));
    await launch();
    assert.match(await page.locator('#toast').textContent(),/external edit\(s\) missing/);checks.push('missing portable handoff shows a notice and original review preview after reopening');
    const restored=await page.evaluate(()=>window.photocull.settings());assert.equal(restored.writeSidecars,'never');assert.equal(restored.activePreset,settings.activePreset);assert.equal(restored.copyXmp,true);assert.equal(restored.naming.template,'{text}_{capturedate}_{seq:3}');assert.equal(await page.locator('#color-labels button[aria-label="Review"]').getAttribute('aria-pressed'),'true');
    assert.ok((await fs.readdir(path.join(data,'settings','presets'))).some(name=>name.endsWith('.json')));checks.push('settings folder, preset and color decisions survive restart');
    await page.locator('#settings-open').click();await page.locator('#auto-advance').check();await page.locator('#settings-cancel').click();assert.equal((await page.evaluate(()=>window.photocull.settings())).autoAdvance,false);checks.push('cancel discards settings draft');
    await page.locator('#export').click();await page.locator('#copy-preset').selectOption('ratings');await waitForSettings(s=>s.activePreset==='ratings');assert.equal((await page.evaluate(()=>window.photocull.settings())).metadata.writeLabels,false);
    await page.locator('#copy-preset').selectOption(settings.activePreset);await waitForSettings(s=>s.metadata.creator==='Test Photographer & friends');checks.push('built-in and custom preset switching');
    assert.deepEqual(errors,[]);const report={passed:true,platform:process.platform,checks,errors};await fs.writeFile(path.join(reports,`settings-ui-${process.platform}.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  } finally {if(app)await app.close();await fs.rm(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1});
