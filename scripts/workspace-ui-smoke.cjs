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
  // A focused menu owns the keyboard: arrows, letters and decision keys never reach the photo shortcuts.
  const active=()=>page.evaluate(()=>document.activeElement.id),decisions=()=>page.evaluate(()=>JSON.stringify([state.selected,state.session.items.map(i=>[i.flag,i.rating])]));
  const decided=await decisions();await page.locator('#source-menu-button').focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');assert.equal(await active(),'backup-open');
  for(const key of ['x','p','5','ArrowRight','ArrowLeft','Delete'])await page.keyboard.press(key);
  assert.equal(await decisions(),decided,'menu keys must not decide, rate, move or delete');assert.equal(await page.locator('#source-menu').isVisible(),true);
  await page.keyboard.press('o');assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Open folder…','typeahead moves to the matching item');await page.keyboard.press('b');assert.equal(await active(),'backup-open');
  assert.equal(await page.locator('#treat-card').isDisabled(),true,'a camera card is already treated as a card');
  await page.evaluate(()=>render());assert.equal(await page.locator('#source-menu').isVisible(),true,'background renders keep an open menu');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#source-menu').isVisible(),false);assert.equal(await active(),'source-menu-button');
  await page.locator('#source-menu-button').click();await page.locator('#backup-open').click();await page.locator('#backup-dialog').waitFor({state:'visible'});await page.locator('#backup-close').click();
  assert.equal(await active(),'source-menu-button','closing a menu-launched dialog returns focus to the menu button');
  // Without an eligible RAW selection, editing is disabled but the editor menu still reaches Configure editors.
  assert.equal(await page.locator('#edit-external').isDisabled(),true);await page.locator('#external-editor-menu').click();
  assert.equal(await page.getByRole('menuitem',{name:'Edit in Dehancer…'}).isDisabled(),true);await page.locator('#configure-editors').click();
  await page.locator('[data-settings-page="editors"]').waitFor({state:'visible'});await page.locator('#settings-cancel').click();
  // Every menu action is reachable from the palette.
  await page.keyboard.press('Control+k');await page.locator('#command-query').fill('treat this folder');assert.equal(await page.locator('#command-results [role=option]').first().getAttribute('aria-disabled'),'true','palette respects card eligibility');await page.keyboard.press('Escape');
  const paletteRows=async query=>{await page.keyboard.press('Control+k');await page.locator('#command-query').fill(query);const rows=await page.locator('#command-results [role=option]').allTextContents();await page.keyboard.press('Escape');return rows.join('\n');};
  for(const [query,expected] of [['copy picks','Copy picks…'],['configure editors','Configure external editors…'],['edit in dehancer','Edit in Dehancer…'],['export finished','Export finished images…'],['back up','Back up card or folder…'],['treat folder','Treat this folder as a camera card'],['duplicate recipe','Duplicate recipe'],['recipe default','Set recipe as default'],['export user recipes','Export user recipes…']])assert.match(await paletteRows(query),new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  await page.locator('#device-list .device-backup button').click();await page.locator('#backup-destination-choose').click();await page.locator('#backup-folder-template').fill('ui-backup');await page.locator('#backup-start').click();await page.waitForFunction(()=>document.querySelector('#backup-status').textContent.includes('safe to format'),null,{timeout:30000});
  assert.equal(await fs.readFile(path.join(dest,'ui-backup','camera.dat'),'utf8'),'all files, not just photos');await page.locator('#backup-close').click();assert.match(await page.locator('#device-list').textContent(),/All 5 files backed up and verified/);
  await fs.writeFile(path.join(card,'changed.txt'),'new file');await page.locator('#device-list .device-backup button').click();await page.locator('#backup-check').click();await page.waitForFunction(()=>document.querySelector('#backup-failures').textContent.includes('changed.txt'));assert.doesNotMatch(await page.locator('#backup-status').textContent(),/safe to format/);await page.locator('#backup-close').click();
  const {SettingsStore}=require('../src/settings.cjs'),{RecipeStore}=require('../src/develop.cjs'),{bundle}=require('../src/settings-bundle.cjs'),settings=new SettingsStore(data);await settings.init();const recipes=new RecipeStore(settings.folder);await recipes.init();const input=bundle(settings,recipes);input.preferences.autoAdvance=false;
  const bundleFile=path.join(root,'sync.json');await fs.writeFile(bundleFile,JSON.stringify(input));await page.locator('#settings-open').click();await page.locator('[data-settings-tab="sync"]').click();await page.locator('#bundle-file').setInputFiles(bundleFile);await page.waitForFunction(()=>document.querySelector('#bundle-changes').textContent.includes('File loaded'));await page.locator('#bundle-preview').click();await page.locator('#bundle-apply:not([disabled])').waitFor();assert.match(await page.locator('#bundle-changes').textContent(),/autoAdvance/);await page.locator('#bundle-apply').click();await page.waitForFunction(()=>document.querySelector('#bundle-changes').textContent.includes('Previous settings backed up'));await page.locator('#settings-cancel').click();
  assert.equal((await page.evaluate(()=>photocull.settings())).autoAdvance,false);assert.equal(errors.length,0,errors.join('\n'));
  await app.close();app=null;
  app=await launch({env:{...process.env,PHOTOCULL_DATA_DIR:data,PHOTOCULL_TEST_WELCOME:'1'}});const reopened=await app.firstWindow();assert.equal(await reopened.locator('#welcome-panel').isVisible(),false,'dismissal survives restart');
  await app.close();app=null;
  // First run with a card attached: Welcome decides before the card opens automatically.
  app=await launch({env:{...process.env,PHOTOCULL_DATA_DIR:path.join(root,'welcome-card'),PHOTOCULL_TEST_WELCOME:'1',PHOTOCULL_TEST_DEVICES:deviceFile}});const cardRun=await app.firstWindow();
  await cardRun.locator('#welcome-panel:not([hidden])').waitFor();await cardRun.waitForFunction(()=>state.devices.length===1&&state.settingsReady);await cardRun.waitForTimeout(800);
  assert.equal(await cardRun.evaluate(()=>state.session),null,'no session opens behind Welcome');
  await cardRun.keyboard.press('Escape');await cardRun.waitForFunction(()=>document.querySelector('#count-all').textContent==='4');await app.close();app=null;
  // Device discovery that finishes after another Welcome choice must not open the card either.
  for(const [name,choose] of [['welcome-folder',async run=>{await run.locator('#welcome-open').click();}],['welcome-editor',async run=>{await run.getByRole('button',{name:'Set up an external editor'}).click();await run.locator('#settings-cancel').click();}]]){
    app=await launch({env:{...process.env,PHOTOCULL_DATA_DIR:path.join(root,name),PHOTOCULL_TEST_WELCOME:'1',PHOTOCULL_TEST_DEVICES:deviceFile}});const run=await app.firstWindow();const held=[];
    await run.route('**/rpc**',route=>{if(route.request().postDataJSON()?.method==='devices')held.push(route);else route.continue();});await run.reload();
    await run.locator('#welcome-panel:not([hidden])').waitFor();assert.equal(await run.evaluate(()=>state.devices.length),0);await choose(run);
    await run.waitForFunction(()=>!document.querySelector('dialog[open]'));assert.ok(held.length>0,'discovery was held');for(const route of held.splice(0))await route.continue();
    await run.waitForFunction(()=>state.devices.length===1);await run.waitForTimeout(800);assert.equal(await run.evaluate(()=>state.session),null,name+': late discovery stays closed');await app.close();app=null;
  }
  // Choose camera card reveals hidden Sources and opens the only card.
  app=await launch({env:{...process.env,PHOTOCULL_DATA_DIR:path.join(root,'welcome-choose'),PHOTOCULL_TEST_WELCOME:'1',PHOTOCULL_TEST_DEVICES:deviceFile}});const chooseRun=await app.firstWindow();
  await chooseRun.locator('#welcome-panel:not([hidden])').waitFor();await chooseRun.waitForFunction(()=>state.devices.length===1);await chooseRun.evaluate(()=>{layoutPrefs.sources=false;applyPaneLayout();});
  await chooseRun.locator('#welcome-card').click();await chooseRun.waitForFunction(()=>document.querySelector('#count-all').textContent==='4');
  assert.equal(await chooseRun.locator('#toggle-sidebar').getAttribute('aria-expanded'),'true');assert.equal(await chooseRun.locator('#device-list').isVisible(),true);await app.close();app=null;
  app=await launch({env:{...process.env,PHOTOCULL_DATA_DIR:path.join(root,'fresh-welcome'),PHOTOCULL_TEST_WELCOME:'1'}});const firstRun=await app.firstWindow();await firstRun.locator('#welcome-panel:not([hidden])').waitFor();assert.equal(await firstRun.evaluate(()=>document.activeElement.id),'welcome-open');
  for(let i=0;i<6;i++){await firstRun.keyboard.press('Tab');assert.equal(await firstRun.evaluate(()=>!!document.activeElement.closest('#welcome-panel')||document.activeElement===document.body),true,'welcome keeps focus');}
  await firstRun.keyboard.press('Escape');await firstRun.locator('#welcome-panel').waitFor({state:'hidden'});await firstRun.waitForFunction(()=>state.settings.welcomeDismissed===true);assert.equal((await firstRun.evaluate(()=>photocull.settings())).welcomeDismissed,true);
  console.log(JSON.stringify({passed:true,checks:['palette keyboard navigation and photo search','shortcut record/conflict/help','settings preview/backup/import','welcome opt-in, modal focus and Escape dismissal','menu keyboard isolation, typeahead and focus return','editor menu without RAW selection','palette covers menu actions','fake card complete backup, hashing and changed file status'],errors},null,2));
 }finally{await app?.close();await fs.rm(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
