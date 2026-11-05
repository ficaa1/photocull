const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { normalizeSettings } = require('../src/preferences.cjs');
const { SettingsStore } = require('../src/settings.cjs');
const { developState } = require('../src/develop.cjs');
const { dehancerPreset, testEditor } = require('../src/editors.cjs');
const { Library } = require('../src/library.cjs');
const { inventory, cleanup } = require('../src/handoffs.cjs');
const { planTiffs } = require('../src/develop-plan.cjs');
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-editors-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const photos=path.join(dir,'photos');await fs.mkdir(photos);await fs.writeFile(path.join(photos,'a.ARW'),'source');
  const library=new Library(path.join(dir,'state')), session=await library.scan(photos), id=session.items[0].id;
  const file=path.join(dir,'hand off.tif');await fs.writeFile(file,'pixels');
  return {dir,photos,library,session,id,file};
}
test('legacy executable and card folder migrate and only the new preference shape is written', async t=>{
  const f=await fixture(t), folder=path.join(f.dir,'settings');await fs.mkdir(folder);
  await fs.writeFile(path.join(folder,'settings.json'),JSON.stringify({dehancerExe:'C:\\My Apps\\Dehancer.exe',dehancerFolder:f.dir}));
  const store=new SettingsStore(f.dir);await store.init();assert.equal(store.value.editors[0].path,'C:\\My Apps\\Dehancer.exe');assert.equal(store.value.handoffFolder,f.dir);
  assert.equal(store.value.defaultEditor,'dehancer');assert.deepEqual(store.value.editors[0].args,['{file}']);assert.equal(store.value.deleteHandoffsAfterExport,false);
  await store.update({handoffAlways:true});const saved=JSON.parse(await fs.readFile(store.file));assert.equal('dehancerExe' in saved,false);assert.equal('dehancerFolder' in saved,false);
  const reopen=new SettingsStore(f.dir);await reopen.init();assert.deepEqual(reopen.value.editors,store.value.editors);assert.equal(reopen.value.handoffAlways,true);
});
test('editor preferences enforce arguments, supported hand-offs, defaults and the resettable preset', ()=>{
  const preset=dehancerPreset();assert.equal(preset.handoff.bitDepth,16);assert.equal(preset.detect,'exit');
  for(const change of [{args:['{other}']},{args:['prefix{files}']},{multiple:true,args:['{file}']},{multiple:true,args:['--input={file}']},{path:'relative.exe'},{handoff:{format:'jpeg',bitDepth:16}},{handoff:{colorSpace:'unknown'}},{detect:'shell'}])assert.throws(()=>normalizeSettings({editors:[{...preset,...change}]}));
  assert.throws(()=>normalizeSettings({editors:[]}));assert.throws(()=>normalizeSettings({editors:[{...preset,id:'custom'}]}));assert.throws(()=>normalizeSettings({defaultEditor:'missing'}));
  const custom={...preset,id:'my-editor',name:'My editor',multiple:true,args:['--safe','{files}'],handoff:{...preset.handoff,format:'png',colorSpace:'displayP3'}};
  assert.equal(normalizeSettings({editors:[preset,custom],defaultEditor:custom.id}).defaultEditor,custom.id);
  assert.deepEqual(normalizeSettings({handoffSubfolder:'Edits',handoffAlways:true}).handoffSubfolder,'Edits');
  for(const handoffSubfolder of ['..','../escape','CON','bad.','bad\nname',''])assert.throws(()=>normalizeSettings({handoffSubfolder}));
});
test('Test checks executability without launching an editor', async()=>{
  assert.equal((await testEditor({path:process.execPath})).ok,true);
  await assert.rejects(testEditor({path:''}));await assert.rejects(testEditor({path:path.join(os.tmpdir(),'missing-photocull-editor.exe')}));
});
test('old edited sessions stay readable; new writes retain editor identity and hand-off history', async t=>{
  const f=await fixture(t), old=developState({tiff:f.file,edited:true,settings:{light:{exposure:1}}});
  assert.equal(old.editedBy,'dehancer');assert.equal('edited' in old,false);assert.equal(old.handoffs[0].path,f.file);
  f.library.item(f.session.id,f.id).develop=old;await f.library.save(f.library.get(f.session.id));
  const legacy=JSON.parse(await fs.readFile(f.library.get(f.session.id).store));legacy.decisions[f.id].develop={tiff:f.file,edited:true,settings:old.settings};await fs.writeFile(f.library.get(f.session.id).store,JSON.stringify(legacy));
  const reopened=new Library(path.join(f.dir,'state')), session=await reopened.scan(f.photos);assert.equal(session.items[0].editedBy,'dehancer');assert.equal(session.items[0].externalEdit,true);
  await reopened.developMark(session.id,f.id,{editedBy:'my-editor'});await reopened.developSet(session.id,[f.id],{settings:{light:{exposure:2}}});assert.equal(reopened.developGet(session.id,f.id).editedBy,'my-editor');
  const second=path.join(f.dir,'second.png');await fs.writeFile(second,'pixels');await reopened.developMark(session.id,f.id,{tiff:second});
  assert.equal(reopened.developGet(session.id,f.id).editedBy,null);assert.equal(reopened.developGet(session.id,f.id).handoffs.length,2);
  const store=JSON.parse(await fs.readFile(reopened.get(session.id).store));assert.equal('edited' in store.decisions[f.id].develop,false);
});
test('cleanup counts only recorded files, protects unexported edits, rechecks stamps, and preserves unrelated files', async t=>{
  const f=await fixture(t);await f.library.developMark(f.session.id,f.id,{tiff:f.file,editedBy:'custom'});
  const unrelated=path.join(f.dir,'unrelated.tif');await fs.writeFile(unrelated,'keep');
  let usage=await inventory(f.library.get(f.session.id));assert.equal(usage.count,1);assert.equal(usage.bytes,6);assert.equal(usage.unexported,1);
  await assert.rejects(cleanup(f.library,f.session.id,usage.token),/not been exported/);
  await fs.appendFile(f.file,'saved again');await assert.rejects(cleanup(f.library,f.session.id,usage.token,true),/changed/);
  usage=await inventory(f.library.get(f.session.id));const result=await cleanup(f.library,f.session.id,usage.token,true);assert.deepEqual(result.deleted,[f.file]);
  assert.equal(await fs.readFile(unrelated,'utf8'),'keep');assert.equal(await fs.readFile(path.join(f.photos,'a.ARW'),'utf8'),'source');assert.equal(f.library.developGet(f.session.id,f.id).tiff,null);
});
test('cleanup refuses sources, hard links, symlinks and redirected parent folders', async t=>{
  const f=await fixture(t), source=path.join(f.photos,'a.JPG');await fs.writeFile(source,'source jpeg');
  const item=f.library.item(f.session.id,f.id);item.companion=source;item.develop=developState({tiff:source,edited:true});
  assert.equal((await inventory(f.library.get(f.session.id))).count,0);
  const hard=path.join(f.dir,'hard.tif');await fs.link(source,hard);item.develop=developState({tiff:hard});assert.equal((await inventory(f.library.get(f.session.id))).count,0);
  if(process.platform==='win32')return;
  const linked=path.join(f.dir,'linked.tif');await fs.symlink(f.file,linked);item.develop=developState({tiff:linked});assert.equal((await inventory(f.library.get(f.session.id))).count,0);
  const a=path.join(f.dir,'a'),b=path.join(f.dir,'b');await fs.mkdir(a);await fs.mkdir(b);await fs.writeFile(path.join(a,'edit.tif'),'a');await fs.writeFile(path.join(b,'edit.tif'),'b');
  await f.library.developMark(f.session.id,f.id,{tiff:path.join(a,'edit.tif')});await fs.rename(a,a+'-old');await fs.symlink(b,a);
  await f.library.developMark(f.session.id,f.id,{editedBy:'custom'});
  assert.equal((await inventory(f.library.get(f.session.id))).count,0);assert.equal(await fs.readFile(path.join(b,'edit.tif'),'utf8'),'b');
});
test('automatic cleanup deletes only the successfully exported current hand-off, preserving prior edits', async t=>{
  const f=await fixture(t);await f.library.developMark(f.session.id,f.id,{tiff:f.file,editedBy:'custom'});
  const current=path.join(f.dir,'current.png');await fs.writeFile(current,'new');await f.library.developMark(f.session.id,f.id,{tiff:current,editedBy:'custom'});await f.library.developMark(f.session.id,f.id,{exported:true});
  const usage=await inventory(f.library.get(f.session.id)), result=await cleanup(f.library,f.session.id,usage.token,false,[f.id]);assert.deepEqual(result.deleted,[current]);assert.equal(await fs.readFile(f.file,'utf8'),'pixels');
});
test('hand-off planning handles PNG/JPEG collisions and retains recorded TIFFs across format switches', async t=>{
  const f=await fixture(t), item=f.library.item(f.session.id,f.id);await fs.writeFile(path.join(f.dir,'a.png'),'unrelated');
  const plan=await planTiffs([item],f.dir,[item],'png');assert.equal(path.basename(plan[0].tiff),'a-2.png');
  await f.library.developMark(f.session.id,f.id,{tiff:f.file,editedBy:'custom'});
  const png=path.join(f.dir,'new.png');await fs.writeFile(png,'new');await f.library.developMark(f.session.id,f.id,{tiff:png});
  const again=await planTiffs([item],f.dir,[item],'tif');assert.notEqual(again[0].tiff,f.file);assert.equal(again[0].own,false);
});

test('missing hand-offs belonging to another photo still reserve their names', async t=>{
  const f=await fixture(t), item=f.library.item(f.session.id,f.id), other={id:'other',path:path.join(f.photos,'b.ARW'),develop:{tiff:path.join(f.dir,'a.tif')}};
  const plan=await planTiffs([item],f.dir,[item,other]);assert.equal(path.basename(plan[0].tiff),'a-2.tif');
});


test('saving again after export warns as unexported and prevents automatic cleanup', async t=>{
  const f=await fixture(t);await f.library.developMark(f.session.id,f.id,{tiff:f.file,editedBy:'custom'});await f.library.developMark(f.session.id,f.id,{exported:true});
  assert.equal((await inventory(f.library.get(f.session.id))).unexported,0);
  await fs.appendFile(f.file,'another save');const usage=await inventory(f.library.get(f.session.id));assert.equal(usage.unexported,1);
  const result=await cleanup(f.library,f.session.id,usage.token,false,[f.id]);assert.equal(result.deleted.length,0);assert.ok(await fs.stat(f.file));
});


test('cleanup warns about later writes even when an edit wait was stopped before attribution', async t=>{
  const f=await fixture(t);await f.library.developMark(f.session.id,f.id,{tiff:f.file});
  assert.equal((await inventory(f.library.get(f.session.id))).unexported,0);
  await fs.appendFile(f.file,'late save');const usage=await inventory(f.library.get(f.session.id));assert.equal(usage.unexported,1);
  await assert.rejects(cleanup(f.library,f.session.id,usage.token),/not been exported/);
});
