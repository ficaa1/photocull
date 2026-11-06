// node scripts/workspace-ui-smoke.cjs — Chromium renderer + real backend, isolated
// temporary settings and fake camera card only. Never opens a physical volume.
const {launch}=require('./launch.cjs');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {fixtures}=require('./fixtures.cjs');
async function main(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'photocull-workspace-ui-')),data=path.join(root,'data'),card=path.join(root,'card'),dest=path.join(root,'backup');
 await fixtures(path.join(card,'DCIM'),4);await fs.writeFile(path.join(card,'camera.dat'),'all files, not just photos');await fs.mkdir(dest);
 const deviceFile=path.join(root,'devices.json');await fs.writeFile(deviceFile,JSON.stringify([{id:'fake-card-1',identity:'fake-volume',label:'Fake camera',root:card,photoRoot:path.join(card,'DCIM'),camera:true}]));
 let app;const errors=[];
 try{
  app=await launch({env:{...process.env,PHOTOCULL_DATA_DIR:data,PHOTOCULL_TEST_DEVICES:deviceFile,PHOTOCULL_TEST_DESTINATION:dest}});
  const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.locator('#backup-open').waitFor({state:'attached'});
  assert.equal(await page.locator('#welcome-panel').isVisible(),false,'onboarding suppressed in automated tests');
  await page.waitForFunction(()=>document.querySelector('#count-all').textContent==='4');
  await page.evaluate(async()=>syncSettings(await photocull.settings({writeSidecars:'never'})));
  await page.keyboard.press('Control+k');await page.locator('#command-query').fill('pick');await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#count-pick').textContent==='1');
  await page.keyboard.press('Control+Shift+p');await page.locator('#command-query').fill('> photo');assert.equal(await page.locator('#command-query').getAttribute('role'),'combobox');
  await page.locator('#command-query').fill('> ');assert.ok(await page.locator('[role="option"]').count()>0);await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');assert.equal(await page.locator('#command-palette').isVisible(),false);
  await page.locator('#search').fill('no-matching-photo');await page.keyboard.press('Control+k');await page.locator('#command-query').fill('go to photo');await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#command-query').value.startsWith('>'));await page.keyboard.press('Enter');await page.locator('#no-matches').waitFor({state:'hidden'});
  await page.locator('#settings-open').click();await page.locator('[data-settings-tab="keyboard"]').click();await page.locator('#record-flag-pick').click();await page.keyboard.press('x');assert.match(await page.locator('#keyboard-status').textContent(),/Conflicts/);
  await page.keyboard.press('Control+Shift+y');await page.locator('#settings-save').click();await page.locator('#settings-dialog').waitFor({state:'hidden'});assert.deepEqual((await page.evaluate(()=>photocull.settings())).shortcuts,{'flag-pick':['Ctrl+Shift+Y']});
  await page.keyboard.press('u');const before=await page.locator('#count-pick').textContent();await page.keyboard.press('p');assert.equal(await page.locator('#count-pick').textContent(),before);await page.keyboard.press('Control+Shift+y');await page.waitForFunction(n=>document.querySelector('#count-pick').textContent!==n,before);
  await page.keyboard.press('?');await page.locator('#help-dialog[open]').waitFor();assert.match(await page.locator('#help-dialog').textContent(),/Ctrl\+Shift\+Y/);await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');await page.locator('#command-query').fill('welcome');await page.keyboard.press('Enter');await page.locator('#welcome-panel:not([hidden])').waitFor();await page.locator('#welcome-skip').click();await page.waitForFunction(()=>state.settings.welcomeDismissed===true);assert.equal((await page.evaluate(()=>photocull.settings())).welcomeDismissed,true);
  // Source actions live in a keyboard menu; its arrow keys must not reach photo navigation.
  const current=await page.evaluate(()=>state.selected);await page.locator('#source-menu-button').focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'backup-open');assert.equal(await page.evaluate(()=>state.selected),current);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#source-menu').isVisible(),false);assert.equal(await page.evaluate(()=>document.activeElement.id),'source-menu-button');
  await page.locator('#source-menu-button').click();await page.locator('#backup-open').click();await page.locator('#backup-dialog').waitFor({state:'visible'});await page.locator('#backup-close').click();
  await page.locator('#device-list .device-backup button').click();await page.locator('#backup-destination-choose').click();await page.locator('#backup-folder-template').fill('ui-backup');await page.locator('#backup-start').click();await page.waitForFunction(()=>document.querySelector('#backup-status').textContent.includes('safe to format'),null,{timeout:30000});
  assert.equal(await fs.readFile(path.join(dest,'ui-backup','camera.dat'),'utf8'),'all files, not just photos');await page.locator('#backup-close').click();assert.match(await page.locator('#device-list').textContent(),/All 5 files backed up and verified/);
  await fs.writeFile(path.join(card,'changed.txt'),'new file');await page.locator('#device-list .device-backup button').click();await page.locator('#backup-check').click();await page.waitForFunction(()=>document.querySelector('#backup-failures').textContent.includes('changed.txt'));assert.doesNotMatch(await page.locator('#backup-status').textContent(),/safe to format/);await page.locator('#backup-close').click();
  const {SettingsStore}=require('../src/settings.cjs'),{RecipeStore}=require('../src/develop.cjs'),{bundle}=require('../src/settings-bundle.cjs'),settings=new SettingsStore(data);await settings.init();const recipes=new RecipeStore(settings.folder);await recipes.init();const input=bundle(settings,recipes);input.preferences.autoAdvance=false;
  const bundleFile=path.join(root,'sync.json');await fs.writeFile(bundleFile,JSON.stringify(input));await page.locator('#settings-open').click();await page.locator('[data-settings-tab="sync"]').click();await page.locator('#bundle-file').setInputFiles(bundleFile);await page.waitForFunction(()=>document.querySelector('#bundle-changes').textContent.includes('File loaded'));await page.locator('#bundle-preview').click();await page.locator('#bundle-apply:not([disabled])').waitFor();assert.match(await page.locator('#bundle-changes').textContent(),/autoAdvance/);await page.locator('#bundle-apply').click();await page.waitForFunction(()=>document.querySelector('#bundle-changes').textContent.includes('Previous settings backed up'));await page.locator('#settings-cancel').click();
  assert.equal((await page.evaluate(()=>photocull.settings())).autoAdvance,false);assert.equal(errors.length,0,errors.join('\n'));
  await app.close();app=null;
  app=await launch({env:{...process.env,PHOTOCULL_DATA_DIR:data,PHOTOCULL_TEST_WELCOME:'1'}});const reopened=await app.firstWindow();assert.equal(await reopened.locator('#welcome-panel').isVisible(),false,'dismissal survives restart');
  await app.close();app=null;
  app=await launch({env:{...process.env,PHOTOCULL_DATA_DIR:path.join(root,'fresh-welcome'),PHOTOCULL_TEST_WELCOME:'1'}});const firstRun=await app.firstWindow();await firstRun.locator('#welcome-panel:not([hidden])').waitFor();await firstRun.locator('#welcome-skip').click();await firstRun.waitForFunction(()=>state.settings.welcomeDismissed===true);assert.equal((await firstRun.evaluate(()=>photocull.settings())).welcomeDismissed,true);
  console.log(JSON.stringify({passed:true,checks:['palette keyboard navigation and photo search','shortcut record/conflict/help','settings preview/backup/import','welcome opt-in and dismissal','fake card complete backup, hashing and changed file status'],errors},null,2));
 }finally{await app?.close();await fs.rm(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
