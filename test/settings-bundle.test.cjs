const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {SettingsStore}=require('../src/settings.cjs');
const {RecipeStore}=require('../src/develop.cjs');
const {bundle,validate,SettingsBundles}=require('../src/settings-bundle.cjs');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'photocull-sync-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const settings=new SettingsStore(root);await settings.init();const recipes=new RecipeStore(settings.folder);await recipes.init();return {root,settings,recipes,service:new SettingsBundles(settings,recipes)};}
test('portable bundles include shortcuts, recipes, presets and editors but strip machine paths',async t=>{
  const {root,settings,recipes}=await fixture(t);await settings.update({handoffFolder:root,manualCards:[root],shortcuts:{'flag-pick':['Ctrl+L']}});await recipes.save({name:'Custom',settings:{exposure:0.5}});await settings.savePreset('Mine',{});
  const exported=bundle(settings,recipes);assert.equal(exported.type,'photocull-settings');assert.equal(exported.version,1);assert.equal(exported.preferences.handoffFolder,'');assert.deepEqual(exported.preferences.manualCards,[]);assert.equal(exported.preferences.editors[0].path,'');assert.deepEqual(exported.preferences.shortcuts,{'flag-pick':['Ctrl+L']});assert.equal(exported.recipes.length,1);assert.equal(exported.presets.length,1);
  const portable=await validate(exported);assert.equal(portable.preferences.editors[0].needsPath,true);assert.match(portable.warnings[0],/needs path/);
  const editor=path.join(root,'editor');await fs.writeFile(editor,'fake editor');const full=bundle(settings,recipes,{excludePaths:false});full.preferences.editors[0].path='/old-machine/editor';full.preferences.handoffFolder='/old-machine';
  const imported=await validate(full,{pathMap:{'/old-machine':root}});assert.equal(imported.preferences.editors[0].path,editor);assert.equal(imported.preferences.editors[0].needsPath,false);assert.equal(imported.preferences.handoffFolder,root);
});
test('preview is read-only; apply backs up complete current settings before replacing, and survives restart',async t=>{
  const {root,settings,recipes,service}=await fixture(t);const recipe=await recipes.save({name:'Keep',settings:{exposure:1}});const saved=bundle(settings,recipes,{excludePaths:false});saved.preferences.autoAdvance=false;saved.preferences.shortcuts={'flag-pick':['Ctrl+L']};saved.recipes=[{...recipe,name:'Synced'}];
  const preview=await service.preview(saved);assert.ok(preview.changes.includes('autoAdvance'));assert.equal(settings.value.autoAdvance,true);assert.equal(recipes.user[0].name,'Keep');
  const result=await service.apply(preview.token);const backup=JSON.parse(await fs.readFile(result.backup));assert.equal(backup.preferences.autoAdvance,true);assert.equal(backup.recipes[0].name,'Keep');assert.equal(settings.value.autoAdvance,false);assert.equal(recipes.user[0].name,'Synced');
  const reopened=new SettingsStore(root);await reopened.init();assert.equal(reopened.value.autoAdvance,false);assert.deepEqual(reopened.value.shortcuts,{'flag-pick':['Ctrl+L']});
  await assert.rejects(service.apply(preview.token),/Preview/);
  const outdated=await service.preview(saved);await settings.update({autoAdvance:true});await assert.rejects(service.apply(outdated.token),/changed since preview/);
});
test('invalid versions, shortcuts, presets, recipes and mappings are rejected before writes',async t=>{
  const {settings,recipes,service}=await fixture(t),original=bundle(settings,recipes);
  for(const mutate of [b=>b.version=99,b=>b.preferences.shortcuts={'pick':['Bogus+X']},b=>b.recipes.push({id:'../escape',name:'Bad',settings:{}}),b=>b.presets.push({id:'../escape',name:'Bad'}),b=>b.preferences.autoAdvance='yes',b=>b.preferences.backupTemplate='../card']){
    const bad=structuredClone(original);mutate(bad);await assert.rejects(service.preview(bad));
  }
  await assert.rejects(validate(original,{pathMap:{old:3}}));assert.equal(settings.value.autoAdvance,true);assert.equal(recipes.user.length,0);
});
test('card configuration validates relative layouts, absolute manual folders and persisted defaults',async t=>{
  const {settings,root}=await fixture(t);await settings.update({cardFolders:['DCIM','PRIVATE/M4ROOT'],manualCards:[root],backupTemplate:'{date}-{card}',copyVerify:true});
  assert.deepEqual(settings.value.cardFolders,['DCIM','PRIVATE/M4ROOT']);assert.equal(settings.value.copyVerify,true);
  for(const patch of [{cardFolders:['../escape']},{manualCards:['relative']},{backupTemplate:'{oops}'}])await assert.rejects(settings.update(patch));
  const {inspectRoots}=require('../src/devices.cjs');await fs.mkdir(path.join(root,'PRIVATE','M4ROOT'),{recursive:true});const devices=await inspectRoots([{root,removable:false,label:'fake',identity:'fake'}],settings.value);assert.equal(devices[0].photoRoot,path.join(root,'PRIVATE','M4ROOT'));
});
