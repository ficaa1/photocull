const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {macRoots}=require('../src/devices.cjs');
test('macOS discovery tolerates disappearing volumes and never traverses root symlinks',async()=>{
 let calls=0;const result=await macRoots({volumeRoot:'/Volumes',readDirectory:async()=>[{name:'Boot',isDirectory:()=>false},{name:'Removed',isDirectory:()=>true},{name:'.hidden',isDirectory:()=>true}],execute:async()=>{calls++;throw new Error('unmounted');}});assert.deepEqual(result,[]);assert.equal(calls,1);
});
test('coalesced session saves include edits queued while the prior write is active',async t=>{
 const{Library}=require('../src/library.cjs'),root=await fs.mkdtemp(path.join(os.tmpdir(),'photocull-save-race-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const photos=path.join(root,'photos');await fs.mkdir(photos);await fs.writeFile(path.join(photos,'a.JPG'),'jpeg');const lib=new Library(path.join(root,'state')),s=await lib.scan(photos),id=s.items[0].id;
 const first=lib.decide(s.id,id,{flag:'pick'});await Promise.resolve();await Promise.resolve();const second=lib.decide(s.id,id,{rating:5});await Promise.all([first,second]);const fresh=await new Library(path.join(root,'state')).scan(photos);assert.equal(fresh.items[0].flag,'pick');assert.equal(fresh.items[0].rating,5);
});
