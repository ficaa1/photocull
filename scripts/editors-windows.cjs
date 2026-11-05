// Real Rust-command round trips with temporary editors; never launches Dehancer.
// Windows: node scripts/editors-windows.cjs <debug-photocull.exe> <RAW-fixture> [reports]
// The source fixture is copied before use. Both app state and WebView2 profile are isolated in TEMP.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{createHash}=require('node:crypto'),{chromium}=require('playwright-core'),sharp=require('sharp');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 if(process.platform!=='win32'||!process.argv[2]||!process.argv[3])throw new Error('Use Windows Node; pass the built executable and a RAW fixture.');
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'photocull-editors-real-')),photos=path.join(temp,'photos'),reports=path.resolve(process.argv[4]||'artifacts/editors-windows');
 await fs.mkdir(photos);await fs.mkdir(reports,{recursive:true});
 const source=path.resolve(process.argv[3]),hash=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex'),before=await hash(source);
 await fs.copyFile(source,path.join(photos,'photo with spaces.ARW'));await fs.copyFile(source,path.join(photos,'another photo.ARW'));
 const exe=path.join(temp,'PhotoCull editor smoke.exe');await fs.copyFile(path.resolve(process.argv[2]),exe);
 const helper=path.join(temp,'mock editor with spaces.cjs'),pidFile=path.join(temp,'watch.pid');
 await fs.writeFile(helper,`const fs=require('node:fs');const [mode,pid,...files]=process.argv.slice(2);if(mode==='cancel')process.exit(0);fs.writeFileSync(pid,String(process.pid));let n=0;const timer=setInterval(()=>{for(const file of files)fs.appendFileSync(file,Buffer.from('saved '+n));if(++n===3){clearInterval(timer);if(mode==='exit')process.exit(0);else setInterval(()=>{},1000);}},100);`);
 const port=Number(process.env.PHOTOCULL_EDITORS_DEBUG_PORT||9349),state=path.join(temp,'state'),profile=path.join(temp,'webview');
 const app=spawn(exe,[],{env:{...process.env,PHOTOCULL_DATA_DIR:state,PHOTOCULL_NODE:process.execPath,PHOTOCULL_BACKEND:path.resolve('src/backend.cjs'),WEBVIEW2_USER_DATA_FOLDER:profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`},stdio:['ignore','pipe','pipe']});
 let logs='',browser,watchPid;app.stdout.on('data',b=>logs+=b);app.stderr.on('data',b=>logs+=b);
 const errors=[],checks=[];const passed=check=>{checks.push(check);console.log('PASS '+check);};
 try{
  let ready=false;for(let i=0;i<150;i++){if(app.exitCode!==null)throw new Error('App exited: '+logs);try{await fetch(`http://127.0.0.1:${port}/json/version`);ready=true;break;}catch{}await delay(200);}assert.ok(ready,'isolated WebView2 debug port');
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);const page=browser.contexts()[0].pages().find(p=>/127\.0\.0\.1/.test(p.url()))||browser.contexts()[0].pages()[0];page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>typeof api!=='undefined'&&api.canDevelop);
  await page.evaluate(async folder=>{loadSession(await api.openPath(folder,false));},photos);
  const folders={};for(const name of ['tiff','png','jpeg']){folders[name]=path.join(temp,name+' hand offs');await fs.mkdir(folders[name]);}
  const setup=await page.evaluate(async ({node,helper,pidFile,folders})=>{
   const preset=await api.editorPreset(),base={...preset,id:'mock-exit',name:'Mock Exit',path:node,args:[helper,'exit',pidFile,'{files}'],multiple:true};
   syncSettings(await api.settings({editors:[preset,base,{...base,id:'mock-watch',name:'Mock Watch',detect:'watch',args:[helper,'watch',pidFile,'{files}']},{...base,id:'mock-cancel',name:'Mock Cancel',args:[helper,'cancel',pidFile,'{files}']}],defaultEditor:'mock-exit'}));
   const session=state.session.id,ids=state.session.items.filter(i=>i.raw).map(i=>i.id),jobs=[];for(const id of ids){const saved=await api.developGet(session,id);jobs.push({id,settings:saved.settings});}
   const developed=await api.developTiffs(session,folders.tiff,jobs,{...base.handoff,replace:false});return {session,ids,jobs,developed};
  },{node:process.execPath,helper,pidFile,folders});
  assert.equal(setup.developed.results.filter(r=>r.status==='developed').length,2);const tiff=setup.developed.results[0].tiff,initial=await fs.stat(tiff),meta=await sharp(await fs.readFile(tiff)).metadata();assert.equal(meta.bitsPerSample,16);assert.equal(meta.hasProfile,true);passed('real full-resolution 16-bit TIFF hand-off with ICC');
  const cancelled=await page.evaluate(async ({session,ids})=>({result:await api.editExternal(session,ids,'mock-cancel'),saved:await api.developGet(session,ids[0])}),setup);assert.equal(cancelled.result.edited,false);assert.equal(cancelled.saved.editedBy,null);assert.equal((await fs.stat(tiff)).size,initial.size);passed('Cancel preserves bytes and unedited state');
  const exit=await page.evaluate(async ({session,ids})=>({result:await api.editExternal(session,ids,'mock-exit'),saved:await api.developGet(session,ids[0])}),setup);assert.equal(exit.result.ids.length,2);assert.equal(exit.saved.editedBy,'mock-exit');assert.ok((await fs.stat(tiff)).size>initial.size);passed('direct multi-file exit launch and space-containing application/script/image arguments');
  await assert.rejects(page.evaluate(({session,ids})=>api.editExternal(session,ids,'not-saved'),setup),/saved editor/);passed('unsaved editor rejected by native command');
  await page.evaluate(async ({session,ids})=>{await developView.refreshItem(session,ids[0]);setMode('review');},setup);await page.waitForFunction(()=>document.querySelector('#review-image').dataset.complete);
  const watch=await page.evaluate(async ({session,ids})=>{const started=performance.now(),result=await api.editExternal(session,ids,'mock-watch');return {result,ms:performance.now()-started,saved:await api.developGet(session,ids[0])};},setup);
  watchPid=Number(await fs.readFile(pidFile,'utf8'));process.kill(watchPid,0);assert.equal(watch.saved.editedBy,'mock-watch');assert.equal(watch.result.ids.length,2);assert.ok(watch.ms>=1000);passed('watch detects settled writes while launched editor remains alive');
  process.kill(watchPid);watchPid=null;
  const keep=await page.evaluate(async ({session,jobs,folders})=>{const result=await api.developTiffs(session,folders.tiff,jobs,{format:'tiff',bitDepth:16,colorSpace:'srgb',replace:false});return {result,saved:await api.developGet(session,jobs[0].id)};},{...setup,folders});assert.equal(keep.saved.editedBy,'mock-watch');passed('reusing existing hand-off preserves editor attribution');
  // Real exports consume the modified TIFF and optional cleanup runs only after publication.
  const dest=path.join(temp,'finished.jpg');const exported=await page.evaluate(async ({session,ids,jobs,dest})=>{syncSettings(await api.settings({deleteHandoffsAfterExport:true}));return api.exportPhotos(session,[{id:ids[0],dest,settings:jobs[0].settings,edited:true}],PhotoCullExport.options({format:'jpeg'}));},{...setup,dest});assert.deepEqual(exported.cleanup?.failures,[]);assert.equal(exported.results[0].status,'exported');assert.equal((await sharp(await fs.readFile(dest)).metadata()).format,'jpeg');await assert.rejects(fs.stat(tiff),{code:'ENOENT'});assert.equal((await fs.stat(setup.developed.results[1].tiff)).isFile(),true);passed('edited export succeeds; auto cleanup deletes only exported hand-off');
  for(const format of ['png','jpeg']){
   const result=await page.evaluate(async ({session,jobs,folder,format})=>api.developTiffs(session,folder,[jobs[0]],{format,bitDepth:format==='jpeg'?8:16,colorSpace:'displayP3',jpegQuality:88,compression:'none',replace:false}),{...setup,folder:folders[format],format});assert.equal(result.results[0].status,'developed');const m=await sharp(await fs.readFile(result.results[0].tiff)).metadata();assert.equal(m.format,format);if(format==='jpeg')assert.equal(m.depth,'uchar');else assert.equal(m.bitsPerSample,16);assert.equal(m.hasProfile,true);passed(`real ${format} hand-off with Display P3 ICC`);
  }
  for(const [compression,bitDepth,colorSpace] of [['lzw',16,'adobeRgb'],['deflate',8,'proPhoto']]){
   const folder=path.join(temp,'TIFF '+compression);await fs.mkdir(folder);
   const result=await page.evaluate(async ({session,jobs,folder,compression,bitDepth,colorSpace})=>api.developTiffs(session,folder,[jobs[0]],{format:'tiff',bitDepth,colorSpace,compression,replace:false}),{...setup,folder,compression,bitDepth,colorSpace});assert.equal(result.results[0].status,'developed');
   const bytes=await fs.readFile(result.results[0].tiff),m=await sharp(bytes).metadata();assert.equal(m.bitsPerSample,bitDepth);assert.equal(m.hasProfile,true);
   const little=bytes.toString('ascii',0,2)==='II',u16=p=>little?bytes.readUInt16LE(p):bytes.readUInt16BE(p),u32=p=>little?bytes.readUInt32LE(p):bytes.readUInt32BE(p),ifd=u32(4);let code;
   for(let i=0;i<u16(ifd);i++){const p=ifd+2+i*12;if(u16(p)===259)code=u16(p+8);}
   assert.ok(compression==='lzw'?code===5:[8,32946].includes(code));passed(`real ${bitDepth}-bit ${compression} TIFF with ${colorSpace} ICC`);
  }
  const cleanup=await page.evaluate(async ({session})=>{const usage=await api.handoffUsage(session);return {usage,result:await api.handoffClean(session,usage.token,true)};},setup);assert.equal(cleanup.result.failures.length,0);assert.ok(cleanup.result.deleted.length>=3);passed('native cleanup removes recorded current and archived hand-offs');
  assert.equal(await hash(source),before);assert.equal(await hash(path.join(photos,'photo with spaces.ARW')),before);assert.deepEqual(errors,[]);passed('source and copied RAW hashes unchanged; no renderer errors');
  const report={passed:true,checks,watchMs:watch.ms,metadata:{bitsPerSample:meta.bitsPerSample,hasProfile:meta.hasProfile},errors};await fs.writeFile(path.join(reports,'editors-windows.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 }catch(e){await fs.writeFile(path.join(reports,'failure.log'),logs+'\n'+e.stack);throw e;}
 finally{if(watchPid)try{process.kill(watchPid);}catch{}if(browser)await browser.close();if(app.exitCode===null){app.kill();await Promise.race([new Promise(r=>app.once('exit',r)),delay(5000)]);}await fs.rm(temp,{recursive:true,force:true,maxRetries:15,retryDelay:250}).catch(e=>console.error('Temporary folder retained:',temp,e.message));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
