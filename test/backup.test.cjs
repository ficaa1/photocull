const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),sync=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {BackupService,hashFile,folderName}=require('../src/backup.cjs');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'photocull-backup-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const source=path.join(root,'card'),dest=path.join(root,'dest');await fs.mkdir(path.join(source,'DCIM'),{recursive:true});await fs.mkdir(dest);await fs.writeFile(path.join(source,'DCIM','photo.raw'),'raw-bytes');await fs.writeFile(path.join(source,'movie.mp4'),'video-bytes');return {root,source,dest};}
const options={identity:'volume:fake',label:'Fake card',template:'{card}'};
test('all card files are hashed, persisted, resumable, and changed files invalidate safe state',async t=>{
  const {root,source,dest}=await fixture(t),backup=new BackupService(path.join(root,'data')),events=[];backup.onProgress=p=>events.push(p);
  const first=await backup.start(source,dest,options);assert.equal(first.status.safe,true);assert.equal(first.verified,2);assert.equal(first.total,2);assert.ok(events.some(p=>p.state==='checking'));
  const persisted=new BackupService(path.join(root,'data'));assert.equal((await persisted.snapshot(source,options.identity)).safe,true);assert.equal((await persisted.status(source,options.identity)).safe,true);
  const resumed=await persisted.start(source,dest,options);assert.equal(resumed.skipped,2);assert.equal(resumed.verified,2);
  await fs.writeFile(path.join(source,'new.txt'),'new');const status=await persisted.status(source,options.identity);assert.equal(status.safe,false);assert.equal(status.missing[0].name,'new.txt');
  const complete=await persisted.start(source,dest,options);assert.equal(complete.status.safe,true);assert.equal(complete.skipped,2);
  await fs.writeFile(path.join(source,'movie.mp4'),'different');assert.equal((await persisted.snapshot(source,options.identity)).safe,false);
  assert.equal((await persisted.status(source,'another-card')).safe,false);
});
test('corrupt copies cannot produce verification records; existing conflicts are never overwritten',async t=>{
  const {root,source,dest}=await fixture(t),backup=new BackupService(path.join(root,'data'),{onProgress:progress=>{if(progress.state==='verifying'){const folder=path.dirname(path.join(progress.destination,progress.file));for(const name of sync.readdirSync(folder))if(name.endsWith('.partial'))sync.writeFileSync(path.join(folder,name),'corrupt');}}});
  const result=await backup.start(source,dest,options);assert.equal(result.verified,0);assert.equal(result.status.safe,false);assert.equal(result.failures.length,2);assert.equal(Object.keys((await backup.read(options.identity)).files).length,0);
  const good=new BackupService(path.join(root,'data'));await good.start(source,dest,options);const target=path.join(dest,'Fake_card','movie.mp4');await fs.writeFile(target,'X'.repeat(11));
  assert.equal((await good.status(source,options.identity)).safe,false);const repeat=await good.start(source,dest,options);assert.ok(repeat.failures.some(f=>/Different file/.test(f.reason)));assert.equal(await fs.readFile(target,'utf8'),'X'.repeat(11));
});
test('cancellation keeps completed files and resumes without deleting anything on the source',async t=>{
  const {root,source,dest}=await fixture(t),backup=new BackupService(path.join(root,'data'));backup.onProgress=p=>{if(p.completed===1&&p.state==='copying')backup.cancel();};
  const result=await backup.start(source,dest,options);assert.equal(result.state,'canceled');assert.equal(result.verified,1);assert.equal((await fs.readdir(source)).length,2);
  backup.onProgress=()=>{};const resumed=await backup.start(source,dest,options);assert.equal(resumed.status.safe,true);assert.equal(resumed.skipped,1);
});
test('source destinations, unsafe templates and links are refused; empty cards are never safe',async t=>{
  const {root,source,dest}=await fixture(t),backup=new BackupService(path.join(root,'data'));await assert.rejects(backup.start(source,source,options),/outside/);
  for(const value of ['..','../card','{unknown}','CON','x/../y'])assert.throws(()=>folderName(value));
  assert.equal(folderName('{date}-{card}','SONY',new Date('2026-01-02Z')),'2026-01-02-SONY');
  const empty=path.join(root,'empty');await fs.mkdir(empty);assert.equal((await backup.status(empty,'empty')).safe,false);
  if(process.platform!=='win32'){await fs.symlink(path.join(source,'movie.mp4'),path.join(source,'link'));const result=await backup.start(source,dest,options);assert.equal(result.status.safe,false);assert.ok(result.failures.some(f=>/links/.test(f.reason)));}
});
test('SHA-256 streams a temporary file and copy-picks can verify originals and generated sidecars',async t=>{
  const {root,source,dest}=await fixture(t),linked=path.join(root,'linked-card');await fs.symlink(await fs.realpath(source),linked,'junction');const file=path.join(linked,'DCIM','photo.raw');assert.equal((await hashFile(file)).hash.length,64);
  const {TransferService}=require('../src/transfer.cjs'),stat=await fs.stat(file),service=new TransferService();t.after(()=>service.close());
  const result=await service.copy({folder:linked,items:[{id:'1',name:'photo.raw',path:file,sidecar:file+'.xmp',flag:'pick',size:stat.size,mtimeMs:stat.mtimeMs,rating:0}]},dest,{verify:true,includeXmp:true,folders:{mode:'preserve'}});
  assert.equal(result.copied,1);assert.equal(result.verified,2);assert.equal(result.failures.length,0);
  assert.equal(await fs.readFile(path.join(dest,'DCIM','photo.raw'),'utf8'),'raw-bytes');assert.equal(await fs.readFile(file,'utf8'),'raw-bytes');assert.equal(await fs.stat(file+'.xmp').then(()=>true,()=>false),false);
});
