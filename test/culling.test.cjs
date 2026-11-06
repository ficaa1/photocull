const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const C=require('../src/renderer/culling.js');
const fixtures=require('./fixtures/focus-metadata.json');
const {Library}=require('../src/library.cjs');
const {CullingService}=require('../src/culling.cjs');
const {PreviewService}=require('../src/previews.cjs');
const {normalizeSettings}=require('../src/preferences.cjs');
for(const fixture of fixtures)test(`focus normalization: ${fixture.name}`,()=>{
  const result=C.normalizeFocus(fixture.tags);assert.ok(result);
  for(const [key,value] of Object.entries(fixture.expected))assert.ok(Math.abs(result[key]-value)<1e-10,`${key}: ${result[key]} vs ${value}`);
  assert.equal(result.points.length,fixture.count || 1);
});
test('all orientations, sensor crop and invalid coordinates',()=>{
  const expected=[[.2,.3],[.8,.3],[.8,.7],[.2,.7],[.3,.2],[.7,.2],[.7,.8],[.3,.8]];
  for(let i=1;i<=8;i++)assert.deepEqual(C.orientPoint(.2,.3,i),expected[i-1]);
  const crop=C.normalizeFocus({Make:'FUJIFILM',ImageWidth:6200,ImageHeight:4200,FocusPixel:'1600 1100',DefaultCropOrigin:'100 100',DefaultCropSize:'6000 4000'});
  assert.equal(crop.x,.25);assert.equal(crop.y,.25);
  for(const tags of [{},{Make:'Sony',FocusLocation:'6000 4000 0 0'},{Make:'Panasonic',AFPointPosition:'16777216 16777216'},{Make:'Canon',AFPointsInFocus:'0'},{Make:'Nikon',AFCoordinatesAvailable:0,AFAreaXPosition:400,AFAreaYPosition:300}])assert.equal(C.normalizeFocus(tags),null);
});
test('bursts use subsecond capture time, camera identity and consecutive order',()=>{
  const time=C.captureTime('2026:07:08 10:20:30','125');assert.equal(time,Date.UTC(2026,6,8,10,20,30,125));
  assert.equal(C.captureTime('2026-07-08T10:20:30.125'),time);assert.equal(C.captureTime('unknown'),null);
  const items=[0,200,1100,2300,2400,2500,2600].map((t,i)=>({id:String(i),captureTime:time+t,cameraKey:i>=4?'Sony:B':'Sony:A'}));
  assert.deepEqual(C.groupBursts(items).map(b=>b.ids),[['0','1','2'],['4','5','6']]);
  assert.deepEqual(C.groupBursts(items,.1).map(b=>b.ids),[['4','5','6']]);
  assert.deepEqual(C.groupBursts([{id:'a',captureTime:null,cameraKey:'a'},{id:'b',captureTime:null,cameraKey:'a'}]),[]);
  assert.equal(C.sharpest(['a','b'],new Map([['a',2]])),null);
  assert.equal(C.sharpest(['a','b'],new Map([['a',2],['b',3]])),'b');
  assert.equal(C.sharpest(['a','b'],new Map([['a',2],['b',2]])),'a');
});
test('survey deduplicates, limits to four, chooses a neighbour and swaps only active candidate',()=>{
  const items='abcdef'.split('').map(id=>({id}));
  assert.deepEqual(C.compareState(['a'],items).ids,['a','b']);
  assert.deepEqual(C.compareState(['f'],items).ids,['f','e']);
  const state=C.compareState(['a','b','b','missing','c','d','e'],items);assert.deepEqual(state.ids,['a','b','c','d']);
  state.active=1;const next=C.swapCandidate(state,items,1);assert.deepEqual(next.ids,['a','e','c','d']);assert.deepEqual(state.ids,['a','b','c','d']);
  assert.equal(C.swapCandidate({...state,active:0},items,-1).ids[0],'a');
});
test('sharpness cache uses file identity and keep-sharpest is one undo step',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'photocull-analysis-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const photos=path.join(root,'photos');await fs.mkdir(photos);for(const name of ['one.jpg','two.jpg','three.jpg'])await fs.writeFile(path.join(photos,name),'disposable fixture');
  const library=new Library(root,{settings:()=>normalizeSettings({writeSidecars:'never'})});t.after(()=>library.close());const session=await library.scan(photos),items=library.get(session.id).items;
  const previews={cacheDir:path.join(root,'cache'),key:(i,k)=>`${i.id}-${i.fingerprint.replaceAll(':','-')}-${k}`,metadata:async item=>({captureTime:items.indexOf(items.find(i=>i.id===item.id))*100,cameraKey:'Sony:fixture',focus:null})};await fs.mkdir(previews.cacheDir);
  const service=new CullingService(library,previews,()=>({burstGap:1}));
  for(const [i,item] of items.entries()){const r=await service.record(session.id,item.id);await service.store(session.id,item.id,r.key,[1,9,2][i]);assert.equal((await service.source(session.id,item.id)).score,[1,9,2][i]);}
  await library.decide(session.id,items[0].id,{rating:4,flag:'pick'});
  const count=library.get(session.id).undo.length;
  const result=await service.keep(session.id,items.map(i=>i.id));assert.equal(result.best,items[1].id);assert.deepEqual(items.map(i=>i.flag),['reject','pick','reject']);assert.equal(items[0].rating,4);assert.ok(items.every(item=>Number.isFinite(item.modified)));assert.equal(library.get(session.id).undo.length,count+1);
  await library.history(session.id,'undo');assert.deepEqual(items.map(i=>i.flag),['pick','none','none']);await library.history(session.id,'redo');assert.deepEqual(items.map(i=>i.flag),['reject','pick','reject']);
  const old=(await service.record(session.id,items[0].id)).key;items[0].fingerprint+='changed';assert.notEqual((await service.record(session.id,items[0].id)).key,old);assert.equal((await service.record(session.id,items[0].id)).score,null);
  await assert.rejects(service.keep(session.id,items.map(i=>i.id)),/Wait for every frame/);
  assert.equal(await fs.readFile(path.join(photos,'one.jpg'),'utf8'),'disposable fixture');
});
test('AF metadata read is persisted and reused without another ExifTool read',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'photocull-focus-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));let reads=0;
  const exif={readRaw:async()=>{reads++;return {...fixtures[0].tags,DateTimeOriginal:'2026:07:08 12:13:14',SubSecTimeOriginal:'250',Model:'ILCE-test'};},end:async()=>{}};
  const item={id:'photo',path:path.join(root,'photo.ARW'),raw:true,fingerprint:'test'};
  const one=new PreviewService(root,{exif}),meta=await one.metadata(item);await one.close();assert.equal(meta.focus.x,.75);assert.equal(meta.captureTime,Date.UTC(2026,6,8,12,13,14,250));
  const two=new PreviewService(root,{exif});await two.metadata(item);await two.close();assert.equal(reads,1);
  assert.equal(normalizeSettings({burstGap:.8,focusOverlay:true}).burstGap,.8);for(const burstGap of [0,11,'1',NaN])assert.throws(()=>normalizeSettings({burstGap}));
});
