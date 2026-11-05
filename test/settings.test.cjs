const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { SettingsStore } = require('../src/settings.cjs');
const { normalizeSettings, DEFAULTS } = require('../src/preferences.cjs');
const { updateXmp, readXmp } = require('../src/xmp.cjs');
const { Library } = require('../src/library.cjs');
const { TransferService } = require('../src/transfer.cjs');
const { renderName } = require('../src/renderer/naming.js');
async function temporary(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-settings-')); t.after(() => fs.rm(dir,{recursive:true,force:true})); return dir; }

test('settings migrate legacy preferences, persist custom presets and serialize concurrent edits', async t => {
  const dir = await temporary(t); await fs.writeFile(path.join(dir,'settings.json'),JSON.stringify({rawRendering:'small'}));
  const store = new SettingsStore(dir); await store.init(); assert.equal(store.value.rawRendering,'small');
  const custom = normalizeSettings({ metadata: { creator:'Test Photographer', keywords:['birds','birds'] }, naming:{template:'{text}_{seq:3}',text:'Trip',start:12} });
  const {preset} = await store.savePreset('Travel',custom);
  await store.update({...custom,activePreset:preset.id});
  await Promise.all([store.update({autoAdvance:false}),store.update({copyXmp:true})]);
  const reopened = new SettingsStore(dir); await reopened.init();
  assert.equal(reopened.value.autoAdvance,false); assert.equal(reopened.value.copyXmp,true); assert.equal(reopened.value.metadata.creator,'Test Photographer');
  assert.equal(reopened.value.activePreset,preset.id); assert.deepEqual(reopened.value.metadata.keywords,['birds']);
  assert.equal(reopened.presets.find(p=>p.id===preset.id).naming.text,'Trip');
  assert.ok((await fs.readdir(path.join(dir,'settings','presets'))).includes(preset.id+'.json'));
  await assert.rejects(store.update({naming:{template:'../{filename}'}}));
  await assert.rejects(store.update({metadata:{writeLabels:'yes'}}));
  await assert.rejects(store.removePreset('standard'));
  await reopened.removePreset(preset.id); assert.equal(reopened.value.activePreset,'standard');
  assert.ok(!reopened.presets.some(p=>p.id===preset.id));
});

test('disabled metadata fields preserve existing values; custom color mapping and XML collections work', () => {
  const original=updateXmp('',{flag:'pick',rating:3},{metadata:{creator:'Original',keywords:['existing']}});
  const preserved=updateXmp(original,{flag:'reject',rating:1,color:'4'},{metadata:{writeRatings:false,writeLabels:false}});
  assert.deepEqual(readXmp(preserved),{flag:'pick',rating:3}); assert.match(preserved,/Original/);
  const config=normalizeSettings({metadata:{creator:'Test Photographer & friends',copyright:'© 2026',caption:'Bird <tree>',title:'Test',keywords:['existing','new'],rejectRating:false},colors:DEFAULTS.colors.map(c=>c.id==='4'?{...c,label:'To edit'}:c)});
  const exported=updateXmp(original,{flag:'reject',rating:4,color:'4'},config);
  assert.match(exported,/xmp:Label="To edit"/); assert.match(exported,/xmp:Rating="4"/);
  assert.match(exported,/Test Photographer &amp; friends/); assert.match(exported,/Bird &lt;tree&gt;/);
  assert.equal((exported.match(/>existing</g)||[]).length,1); assert.match(exported,/>new</);
  const clear=updateXmp(exported,{flag:'pick',rating:2,color:''},config); assert.match(clear,/xmp:Label=""/);
});

test('independent color decisions survive undo, reopen, and source-XMP export', async t => {
  const dir=await temporary(t),photos=path.join(dir,'photos'); await fs.mkdir(photos); await fs.writeFile(path.join(photos,'a.ARW'),'raw');
  const config=normalizeSettings({colors:DEFAULTS.colors.map(c=>c.id==='2'?{...c,label:'Select'}:c)});
  const library=new Library(path.join(dir,'state'),{settings:()=>config}); const session=await library.scan(photos);
  await library.decide(session.id,session.items[0].id,{flag:'pick',color:'2',rating:4});
  await library.history(session.id,'undo'); assert.equal(library.get(session.id).items[0].color,null);
  await library.history(session.id,'redo'); await library.exportXmp(session.id);
  assert.match(await fs.readFile(path.join(photos,'a.xmp'),'utf8'),/xmp:Label="Select"/);
  const reopened=await new Library(path.join(dir,'state')).scan(photos); assert.equal(reopened.items[0].color,'2'); assert.equal(reopened.items[0].flag,'pick');
});

test('naming renders custom text, sequence, capture/export dates and rejects unsafe paths', () => {
  const options=normalizeSettings({naming:{template:'{text}_{capturedate}_{seq:3}_{filename}',text:'Trip',start:12}}).naming;
  assert.equal(renderName('DSC1234.ARW',options,1,{captured:'2026:09:26 10:00:00'}).filename,'Trip_20260926_013_DSC1234.ARW');
  assert.equal(renderName('a.JPG',{template:'{date}_{seq}',text:'',start:1},0,{now:new Date(2026,9,30)}).filename,'20261030_0001.JPG');
  for(const template of ['../{filename}','{unknown}','{filename}/{seq}','{seq:7}'])assert.throws(()=>normalizeSettings({naming:{template}}));
  assert.throws(()=>renderName('a.ARW',{template:'{capturedate}',text:'',start:1}),/Capture date/);
  assert.throws(()=>renderName('a.ARW',{template:'CON',text:'',start:1}),/Invalid export/);
});

test('renamed RAW, companion and metadata share a stem; collisions skip every conflicting group', async t => {
  const dir=await temporary(t),photos=path.join(dir,'photos'),destination=path.join(dir,'out'); await fs.mkdir(photos);await fs.mkdir(destination);
  for(const name of ['a.ARW','a.JPG','b.ARW'])await fs.writeFile(path.join(photos,name),name);
  const library=new Library(path.join(dir,'state')),session=await library.scan(photos);
  for(const item of session.items)await library.decide(session.id,item.id,{flag:'pick',color:'4',rating:5});
  const config=normalizeSettings({metadata:{creator:'Test Photographer'},naming:{template:'{text}_{capturedate}_{seq:3}',text:'Trip',start:7}});
  const copies=new TransferService({captureDate:async()=>'2026:09:26'});
  const result=await copies.copy(library.get(session.id),destination,{includeJpeg:true,includeXmp:true,naming:config.naming,metadataSettings:config});
  assert.equal(result.copied,2); assert.deepEqual((await fs.readdir(destination)).sort(),['Trip_20260926_007.ARW','Trip_20260926_007.JPG','Trip_20260926_007.xmp','Trip_20260926_008.ARW','Trip_20260926_008.xmp']);
  const xmp=await fs.readFile(path.join(destination,'Trip_20260926_007.xmp'),'utf8');assert.match(xmp,/Test Photographer/); assert.match(xmp,/xmp:Label="Blue"/);
  const collision=await copies.copy(library.get(session.id),destination,{naming:{template:'same',text:'',start:1}});assert.equal(collision.skipped.length,2);assert.equal(collision.copied,0);
  assert.deepEqual((await fs.readdir(photos)).sort(),['a.ARW','a.JPG','b.ARW']);
});

test('unreadable settings are retained and a deleted active preset does not lock preferences', async t => {
  const dir=await temporary(t), folder=path.join(dir,'settings');await fs.mkdir(folder);
  const file=path.join(folder,'settings.json');await fs.writeFile(file,'bad JSON');
  const store=new SettingsStore(dir);await store.init();assert.ok(store.warning);assert.equal(await fs.readFile(file,'utf8'),'bad JSON');
  await store.update({autoAdvance:false});
  const {preset}=await store.savePreset('Temporary',{});await assert.rejects(store.savePreset('temporary',{}),/already exists/);
  await store.update({activePreset:preset.id});await fs.rm(path.join(folder,'presets',preset.id+'.json'));
  const recovered=new SettingsStore(dir);await recovered.init();assert.equal(recovered.value.activePreset,'standard');assert.ok(recovered.warning);
  await recovered.update({copyXmp:true});assert.equal(recovered.value.copyXmp,true);
});

test('preview cache size defaults to 2 GB and only accepts the offered sizes', () => {
  assert.equal(normalizeSettings({}).previewCacheGB, 2);
  assert.equal(normalizeSettings({ previewCacheGB: 10 }).previewCacheGB, 10);
  for (const value of [0, 3, '5', -1]) assert.throws(() => normalizeSettings({ previewCacheGB: value }), /Invalid preview cache size/);
});

test('Dehancer camera-card folder defaults empty, requires an absolute path, and persists', async t => {
  const dir=await temporary(t), store=new SettingsStore(dir); await store.init();
  assert.equal(store.value.handoffFolder,'');
  for(const value of ['relative/path','../Dehancer',123,'/tmp/bad\nfolder']) assert.throws(()=>normalizeSettings({dehancerFolder:value}));
  for(const value of ['/tmp/Dehancer','C:\\PhotoFixtures\\Dehancer','\\\\server\\photos']) assert.equal(normalizeSettings({dehancerFolder:value}).handoffFolder,value);
  await store.update({dehancerFolder:dir});const reopened=new SettingsStore(dir);await reopened.init();assert.equal(reopened.value.handoffFolder,dir);
});
