// Browser UI smoke: the renderer/backend are real; only native develop/external-editor APIs are mocked.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {launch}=require('./launch.cjs');
async function main(){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'photocull-develop-ui-')),photos=path.join(temp,'photos');await fs.mkdir(photos);
 const sharp=require('sharp');await sharp({create:{width:960,height:640,channels:3,background:'#7c9fa3'}}).jpeg().toFile(path.join(photos,'test.jpg'));await fs.writeFile(path.join(photos,'test.ARW'),'mock RAW');await fs.writeFile(path.join(photos,'second.ARW'),'mock RAW');await fs.copyFile(path.join(photos,'test.jpg'),path.join(photos,'second.jpg'));
 const resultFolder=path.join(temp,'TIFFs');await fs.mkdir(resultFolder);for(const name of ['test','second'])await sharp({create:{width:3600,height:2400,channels:3,background:'#e02020'}}).tiff().toFile(path.join(resultFolder,name+'.tif'));
 const reports=path.resolve(process.argv[2]||'artifacts/develop-ui');await fs.mkdir(reports,{recursive:true});
 let app;const errors=[];try{
  app=await launch({env:{...process.env,PHOTOCULL_DATA_DIR:path.join(temp,'state')}});const page=await app.firstWindow();page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE:',e.stack);});
  await page.evaluate(async folder=>{loadSession(await api.openPath(folder,false));setMode('develop');},photos);
  await page.waitForFunction(()=>document.querySelector('#develop-message').textContent.includes('desktop app'));
  // Replace the frozen bridge before app.js executes, leaving backend persistence intact.
  await page.route('**/app.js',async route=>{const original=await route.fetch();await route.fulfill({response:original,body:`
  window.__developMock={calls:[],active:0,max:0,edits:[],tiffs:[],editActive:0,editMax:0};
  const realDevelopGet=window.photocull.developGet, realDevelopFolder=window.photocull.developFolder;
  const resultFolder=${JSON.stringify(resultFolder)};
  const mark=async(session,id,value)=>{const response=await fetch('/rpc'+location.search,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'develop-mark',params:[session,id,value]})});const r=await response.json();if(!r.ok)throw new Error(r.error);return r.value;};
  window.photocull=Object.freeze({...window.photocull,canDevelop:true,
   developGet:realDevelopGet,
   developFolder:async session=>window.__developMock.removable ? {removable:true,folder:await window.photocull.developFolderCheck((await window.photocull.settings()).handoffFolder).catch(()=>null)} : realDevelopFolder(session),
   pickFolder:async()=>{window.__developMock.picks=(window.__developMock.picks||0)+1;return window.__developMock.nextFolder||resultFolder;},
   revealDevelop:async(session,id)=>{window.__developMock.revealed=id;},
   developResult:async(session,id)=>{const blob=await (await fetch(window.photocull.imageUrl(session,id,'preview','&v='+Date.now()))).blob();return {blob,width:1200,height:800,renderMs:0,loadMs:1,histogram:null};},
   developInfo:async()=>({base:{profile:{id:'lc.neutral'},wb:{mode:'asShot',temp:5100,tint:4},light:{exposure:0},optics:{lens_profile:true,vignetting_midpoint:50},detail:{sharpen_amount:0,nr_luminance:0,nr_color:0}},asShot:{temp:5100,tint:4},camera:'Sony A7C II',lensProfile:null,lensCorrection:false,lensDatabase:false}),
   developPlan:async(session,ids,folder)=>ids.map(id=>({id,name:'test.ARW',tiff:folder+'/test.tif',exists:true,edited:window.__developMock.edits.includes(id)})),
   lensDatabase:async()=>({installed:false,megabytes:3}),
   developRender:async(session,id,settings,settled)=>{const m=window.__developMock;m.max=Math.max(m.max,++m.active);m.calls.push({id,settings:structuredClone(settings),settled});await new Promise(r=>setTimeout(r,35));const c=document.createElement('canvas');c.width=960;c.height=640;const ctx=c.getContext('2d');ctx.fillStyle='#778888';ctx.fillRect(0,0,960,640);ctx.fillStyle='#fff';ctx.fillRect(0,0,50,640);ctx.fillStyle='#000';ctx.fillRect(910,0,50,640);const blob=await new Promise(r=>c.toBlob(r,'image/jpeg'));const h={total:1000};for(const k of ['r','g','b','luma'])h[k]=Array.from({length:256},(_,i)=>i===0||i===255?20:Math.max(0,100-Math.abs(i-128)));m.active--;return {blob,width:960,height:640,renderMs:35,loadMs:0,histogram:h};},
   developTiffs:async(session,folder,jobs,options)=>{window.__developMock.tiffs.push({folder,jobs,options});const results=[];for(const job of jobs){const saved=await realDevelopGet(session,job.id),tiff=resultFolder+'/'+saved.name.replace(/\\.[^.]+$/,'')+'.tif';await mark(session,job.id,{tiff,edited:!options.replace&&saved.edited});results.push({id:job.id,status:'developed',tiff});}return {results};},
   editExternal:async(session,ids,editorId)=>{const m=window.__developMock;m.edits.push(...ids);m.editorCalls ||= [];m.editorCalls.push({ids,editorId});m.editMax=Math.max(m.editMax,++m.editActive);await new Promise(r=>m.waitForEdit?m.finishEdit=r:setTimeout(r,60));m.editActive--;if(!m.waitForEdit)for(const id of ids)await mark(session,id,{editedBy:editorId});return {edited:!m.waitForEdit};},developCancel:async()=>{window.__developMock.finishEdit?.();window.__developMock.finishEdit=null;},
  });\n`+(await original.text())});});
  await page.reload();await page.evaluate(async()=>{state.settings=await api.settings({editors:[{...(await api.settings()).editors[0],path:'/mock/editor.exe'}]});});await page.evaluate(async folder=>{loadSession(await api.openPath(folder,false));setMode('develop');},photos);
  await page.waitForFunction(()=>document.querySelector('#develop-timing').textContent.includes('settled'),null,{timeout:10000}).catch(async e=>{console.error(await page.evaluate(()=>({message:document.querySelector('#develop-message').textContent,key:developView.key,active:developView.active,info:developView.info,calls:window.__developMock.calls,queue:{running:developView.queue.running,pending:developView.queue.pending},errors:document.body.textContent.slice(-500)})));throw e;});
  // The merged views must keep their keyboard gestures within their owner.
  const zoomBefore=await page.evaluate(()=>JSON.stringify(loupe.view.zoom));
  await page.evaluate(()=>document.activeElement?.blur());
  for(const key of ['z','Space','Control+Equal','Control+Minus','Control+0'])await page.keyboard.press(key);
  const stage=await page.locator('.develop-stage').boundingBox();await page.mouse.move(stage.x+stage.width/2,stage.y+stage.height/2);await page.mouse.wheel(0,120);
  assert.equal(await page.evaluate(()=>state.mode),'develop');assert.equal(await page.evaluate(()=>JSON.stringify(loupe.view.zoom)),zoomBefore);
  const input=page.locator('#develop-recipe-name');await input.fill('');await input.focus();await page.keyboard.type('z J \\');await page.keyboard.press('Control+Shift+C');await page.keyboard.press('Control+Shift+V');await page.keyboard.press('Control+0');
  assert.equal(await input.inputValue(),'z J \\');assert.equal(await page.evaluate(()=>developView.before),false);assert.equal(await page.evaluate(()=>developView.clipping),false);await input.fill('');
  await page.evaluate(()=>{document.activeElement?.blur();window.__shortcutCalls=[];window.__copy=developView.copy;window.__paste=developView.paste;developView.copy=()=>window.__shortcutCalls.push('copy');developView.paste=async()=>window.__shortcutCalls.push('paste');});
  for(const mode of ['grid','review']){await page.evaluate(mode=>setMode(mode),mode);for(const key of ['\\','j','Control+Shift+C','Control+Shift+V'])await page.keyboard.press(key);}
  assert.deepEqual(await page.evaluate(()=>window.__shortcutCalls),[]);
  await page.evaluate(()=>{developView.copy=window.__copy;developView.paste=window.__paste;setMode('develop');});
  await page.waitForFunction(()=>!document.querySelector('.develop-controls').disabled);
  await page.keyboard.press('Control+Shift+E');await page.locator('#image-export-dialog').waitFor({state:'visible'});
  await page.locator('#image-export-folder').fill('');await page.locator('#image-export-folder').focus();await page.keyboard.type('z J \\');await page.keyboard.press('Control+Equal');await page.keyboard.press('Control+Shift+C');await page.keyboard.press('Control+Shift+V');
  assert.equal(await page.locator('#image-export-folder').inputValue(),'z J \\');assert.equal(await page.evaluate(()=>state.mode),'develop');assert.equal(await page.evaluate(()=>JSON.stringify(loupe.view.zoom)),zoomBefore);await page.locator('#image-export-close').click();
  assert.equal(await page.getByLabel('Temp value',{exact:true}).inputValue(),'5100');
  const exp=page.getByLabel('Exposure value',{exact:true});await exp.fill('1.25');await exp.press('Tab');
  await page.waitForFunction(()=>document.querySelector('#save-status').textContent==='Saved');
  let saved=await page.evaluate(()=>api.developGet(state.session.id,state.selected));assert.equal(saved.settings.light.exposure,1.25);
  await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('\\');await page.waitForFunction(()=>document.querySelector('#develop-timing').textContent.includes('Before'));
  await page.keyboard.press('\\');await page.keyboard.press('j');await page.waitForFunction(()=>!document.querySelector('#develop-clipping').hidden);
  assert.ok(await page.locator('#develop-shadow-clip').evaluate(e=>e.classList.contains('clipped')));assert.ok(await page.locator('#develop-highlight-clip').evaluate(e=>e.classList.contains('clipped')));
  await page.keyboard.press('Control+Shift+C');await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>!document.querySelector('.develop-controls').disabled);await page.keyboard.press('Control+Shift+V');
  await page.waitForFunction(()=>document.querySelector('#develop-light-exposure').value==='1.25');
  await page.getByLabel('Temp value',{exact:true}).fill('6000');await page.getByLabel('Temp value',{exact:true}).press('Tab');assert.equal(await page.locator('#develop-wb').inputValue(),'custom');
  await page.locator('#develop-light-exposure').dblclick();await page.waitForFunction(()=>document.querySelector('#develop-light-exposure').value==='0');
  const plot=await page.locator('#develop-histogram').boundingBox();await page.mouse.move(plot.x+plot.width*.5,plot.y+plot.height*.5);await page.mouse.down();await page.mouse.move(plot.x+plot.width*.6,plot.y+plot.height*.5,{steps:5});await page.mouse.up();assert.ok(Number(await exp.inputValue())>.8);
  // Burst changes coalesce without overlapping renders and preserve the final snapshot.
  await page.evaluate(()=>{for(let i=0;i<30;i++)developView.change('light.contrast',i);});
  await page.waitForFunction(()=>window.__developMock.calls.at(-1).settled&&window.__developMock.calls.at(-1).settings.light.contrast===29&&window.__developMock.active===0);
  assert.equal(await page.evaluate(()=>window.__developMock.max),1);
  await page.locator('#develop-recipe-name').fill('Smoke recipe');await page.locator('#develop-recipe-save').click();await page.waitForFunction(()=>document.querySelector('#develop-recipe').selectedOptions[0]?.textContent==='Smoke recipe');
  await page.locator('#develop-recipe-duplicate').click();await page.waitForFunction(()=>document.querySelector('#develop-recipe').selectedOptions[0]?.textContent==='Smoke recipe (2)');
  const recipeFile=path.join(temp,'smoke.photocull-recipe.json');
  await page.evaluate(file=>{window.prompt=()=>file;},recipeFile);
  await page.locator('#develop-recipe-export').click();await page.waitForFunction(()=>document.querySelector('#develop-recipe-export'));
  for(let n=0;n<50;n++){if(await fs.stat(recipeFile).catch(()=>null))break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(JSON.parse(await fs.readFile(recipeFile,'utf8')).type,'photocull-recipe');
  await page.locator('#develop-recipe-import').click();await page.waitForFunction(()=>[...document.querySelector('#develop-recipe').options].some(p=>p.textContent==='Smoke recipe (2) (2)'));
  const bundleFile=path.join(temp,'all.photocull-recipe.json');await page.evaluate(file=>{window.prompt=()=>file;},bundleFile);
  await page.locator('#develop-recipes-export').click();
  for(let n=0;n<50;n++){if(await fs.stat(bundleFile).catch(()=>null))break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(JSON.parse(await fs.readFile(bundleFile,'utf8')).recipes.length,3);
  await page.locator('#develop-recipe-default').click();await page.waitForFunction(()=>state.settings.defaultRecipe===document.querySelector('#develop-recipe').value);
  await page.evaluate(()=>{state.marked=new Set(state.session.items.filter(i=>i.raw).map(i=>i.id));render();});
  await page.locator('#develop-send').click();await page.locator('#develop-batch-start').click();await page.getByRole('button',{name:'Edit existing files',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#develop-batch-status').textContent.includes('Finished'));
  assert.equal(await page.evaluate(()=>window.__developMock.edits.length),2);assert.equal(await page.evaluate(()=>window.__developMock.editMax),1);assert.equal(await page.evaluate(()=>state.session.items.filter(i=>i.externalEdit).length),2);assert.equal(await page.evaluate(()=>window.__developMock.tiffs[0].options.bitDepth),16);
  assert.equal(await page.locator('#develop-batch-links .develop-result-row').count(),2);
  await page.locator('#develop-batch-links button').filter({hasText:'Show in folder'}).first().click();assert.ok(await page.evaluate(()=>window.__developMock.revealed));
  await page.locator('#develop-batch-links button').filter({hasText:'View result'}).first().click();
  await page.waitForFunction(()=>document.querySelector('#develop-timing').textContent.includes('Edited in Dehancer'));
  assert.match(await page.locator('#develop-result-path').textContent(),/\.tif$/);
  await page.locator('#develop-result-toggle').click();await page.waitForFunction(()=>document.querySelector('#develop-timing').textContent.includes('After'));
  await page.locator('#develop-result-toggle').click();await page.waitForFunction(()=>document.querySelector('#develop-timing').textContent.includes('Edited in Dehancer'));
  await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('\\');await page.waitForFunction(()=>document.querySelector('#develop-timing').textContent.includes('After'));await page.keyboard.press('\\');
  const batches=await page.evaluate(()=>window.__developMock.tiffs.length);await page.locator('#develop-edit-again').click();await page.waitForFunction(()=>!document.querySelector('#develop-edit-again').disabled);assert.equal(await page.evaluate(()=>window.__developMock.tiffs.length),batches);
  const red=async selector=>page.locator(selector).first().evaluate(img=>{if(!img.complete||!img.naturalWidth)return false;const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.drawImage(img,0,0,1,1);const p=ctx.getImageData(0,0,1,1).data;return p[0]>180&&p[1]<80;});
  await page.evaluate(()=>setMode('review'));await page.waitForFunction(()=>document.querySelector('#review-image').dataset.complete);assert.ok(await red('#review-image'));await page.waitForFunction(()=>{const img=document.querySelector('.film-card img');return img?.complete&&img.naturalWidth;});assert.ok(await red('.film-card img'));
  await page.selectOption('#zoom-percent','400');await page.waitForFunction(()=>loupe.shown?.kind==='full');assert.ok(await red('#review-image'));
  await page.keyboard.press('\\');await page.waitForFunction(()=>document.querySelector('#review-image').dataset.complete&&document.querySelector('#review-image').src.includes('original=1'));assert.equal(await red('#review-image'),false);
  await page.keyboard.press('\\');await page.waitForFunction(()=>document.querySelector('#review-image').dataset.complete&&!document.querySelector('#review-image').src.includes('original=1'));assert.ok(await red('#review-image'));
  await page.evaluate(()=>setMode('grid'));await page.waitForFunction(()=>[...document.querySelectorAll('.grid-card img')].some(i=>i.complete&&i.naturalWidth));assert.ok(await red('.grid-card img'));
  await page.locator('#original-toggle').click();await page.waitForFunction(()=>[...document.querySelectorAll('.grid-card img')].some(i=>i.complete&&i.naturalWidth&&i.src.includes('original=1')));assert.equal(await red('.grid-card img'),false);
  await page.locator('#original-toggle').click();await page.locator('[data-filter="external"]').click();assert.equal(await page.evaluate(()=>filtered().length),2);
  await page.locator('[data-filter="all"]').click();await page.evaluate(()=>{setMode('develop');state.marked=new Set(state.session.items.filter(i=>i.raw).map(i=>i.id));render();});await page.waitForFunction(()=>!document.querySelector('.develop-controls').disabled);
  await page.screenshot({path:path.join(reports,'develop-mocked.png')});
  await page.evaluate(()=>{window.__developMock.waitForEdit=true;});await page.locator('#develop-send').click();await page.locator('#develop-batch-start').click();await page.getByRole('button',{name:'Re-develop and replace files',exact:true}).click();await page.waitForFunction(()=>!!window.__developMock.finishEdit);await page.locator('#develop-batch-skip').click();await page.waitForFunction(()=>document.querySelector('#develop-batch-status').textContent.includes('2 of 2')&&!!window.__developMock.finishEdit);await page.locator('#develop-batch-stop').click();await page.waitForFunction(()=>document.querySelector('#develop-batch-status').textContent.includes('Stopped'));assert.equal(await page.evaluate(()=>window.__developMock.tiffs.at(-1).options.replace),true);await page.locator('#develop-batch-stop').click();

  await page.evaluate(()=>{state.session.removable=true;window.__developMock.removable=true;});
  await page.locator('#develop-send').click();await page.waitForFunction(()=>window.__developMock.picks===1&&!!state.settings.handoffFolder);assert.equal(await page.evaluate(()=>state.settings.handoffFolder),resultFolder);await page.locator('#develop-batch-stop').click();
  await page.locator('#develop-send').click();await page.locator('#develop-batch-dialog').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>window.__developMock.picks),1);assert.equal(await page.locator('#develop-batch-folder').textContent(),resultFolder);await page.locator('#develop-batch-choose').click();assert.equal(await page.evaluate(()=>window.__developMock.picks),2);await page.locator('#develop-batch-stop').click();
  const moved=resultFolder+'-moved',replacement=resultFolder+'-new';await fs.rename(resultFolder,moved);await fs.mkdir(replacement);await page.evaluate(folder=>{window.__developMock.nextFolder=folder;},replacement);
  await page.locator('#develop-send').click();await page.waitForFunction(()=>window.__developMock.picks===3);await page.waitForFunction(folder=>state.settings.handoffFolder===folder,replacement);await page.locator('#develop-batch-stop').click();
  await page.evaluate(async()=>{await developView.flush();const s=state.session;loadSession(await api.openPath(s.folder,false));setMode('develop');});await page.waitForFunction(()=>!document.querySelector('.develop-controls').disabled);
  await page.evaluate(()=>{setMode('grid');state.session.items[0].adjusted=true;state.session.items[0].developed=true;state.session.items[0].externalEdit=true;render();});await page.waitForFunction(()=>document.querySelector('.develop-badges'));
  await page.locator('#settings-open').click();await page.locator('#settings-dialog').waitFor({state:'visible'});assert.equal(await page.locator('#default-recipe').inputValue(),await page.evaluate(()=>state.settings.defaultRecipe));await page.locator('[data-settings-tab="editors"]').click();await page.locator('[data-editor-id="dehancer"] [data-editor-field="path"]').fill('C:\\Test\\Dehancer.exe');await page.locator('#settings-save').click();await page.locator('#settings-dialog').waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>state.settings.editors[0].path),'C:\\Test\\Dehancer.exe');
  // Configure a second editor with a multi-file PNG hand-off through the actual settings UI.
  await page.locator('#settings-open').click();await page.locator('[data-settings-tab="editors"]').click();await page.locator('#editor-add').click();await page.waitForFunction(()=>document.querySelectorAll('.editor-settings').length===2);
  const custom=page.locator('.editor-settings').last();const field=k=>custom.locator(`[data-editor-field="${k}"]`);
  await field('name').fill('Smoke Studio');await field('path').fill(process.execPath);await field('args').fill('["--open","{files}"]');await field('multiple').check();await field('format').selectOption('png');await field('bitDepth').selectOption('16');await field('colorSpace').selectOption('displayP3');await field('detect').selectOption('watch');await field('default').check();
  await custom.getByRole('button',{name:'Test',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#settings-status').textContent.includes('executable'));
  await custom.getByRole('button',{name:'Duplicate',exact:true}).click();assert.equal(await page.locator('.editor-settings').count(),3);await page.locator('.editor-settings').last().getByRole('button',{name:'Remove',exact:true}).click();assert.equal(await page.locator('.editor-settings').count(),2);
  await page.locator('#handoff-subfolder').fill('External edits');await page.locator('#handoff-always').check();await page.locator('#handoff-delete-export').check();await page.locator('#settings-save').click();await page.locator('#settings-dialog').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>state.settings.editors.find(e=>e.id===state.settings.defaultEditor).name),'Smoke Studio');assert.equal(await page.locator('#edit-external').textContent(),'Edit in Smoke Studio…');
  const destinationModes=await page.evaluate(async()=>{const resolve=async()=>{const response=await fetch('/rpc'+location.search,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'develop-folder',params:[state.session.id]})});return (await response.json()).value.folder;};await api.settings({handoffAlways:false});const local=await resolve();await api.settings({handoffAlways:true});return {local,always:await resolve()};});assert.equal(destinationModes.local,path.join(photos,'External edits'));assert.equal(destinationModes.always,replacement);
  await page.evaluate(()=>{window.__developMock.waitForEdit=false;setMode('grid');state.marked=new Set(state.session.items.filter(i=>i.raw).map(i=>i.id));render();document.activeElement?.blur();});await page.keyboard.press('Control+e');await page.locator('#develop-batch-dialog').waitFor({state:'visible'});assert.equal(await page.locator('#develop-batch-title').textContent(),'Edit in Smoke Studio');
  await page.locator('#develop-batch-start').click();await page.getByRole('button',{name:'Edit existing files',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#develop-batch-status').textContent.includes('Finished'));
  assert.equal(await page.evaluate(()=>window.__developMock.editorCalls.at(-1).ids.length),2);assert.equal(await page.evaluate(()=>window.__developMock.tiffs.at(-1).options.format),'png');assert.equal(await page.evaluate(()=>window.__developMock.tiffs.at(-1).options.colorSpace),'displayP3');await page.locator('#develop-batch-stop').click();
  await page.evaluate(()=>setMode('review'));await page.locator('.film-card').first().click();await page.locator('#edit-external').click();await page.locator('#develop-batch-stop').click();
  await page.selectOption('#external-editor-menu','dehancer');await page.locator('#develop-batch-dialog').waitFor({state:'visible'});assert.equal(await page.locator('#develop-batch-title').textContent(),'Edit in Dehancer');await page.locator('#develop-batch-stop').click();
  // Cleanup uses the recorded path, with a second warning for an unexported edit.
  const cleanupFile=path.join(temp,'cleanup.tif');await fs.writeFile(cleanupFile,'edited pixels');
  await page.evaluate(async file=>{const session=state.session.id,id=state.session.items[0].id;const response=await fetch('/rpc'+location.search,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'develop-mark',params:[session,id,{tiff:file,editedBy:state.settings.defaultEditor}]})});const r=await response.json();if(!r.ok)throw new Error(r.error);Object.assign(state.session.items[0],r.value);render();},cleanupFile);
  await page.locator('#handoff-cleanup').click();await page.getByRole('button',{name:'Delete hand-off files',exact:true}).click();await page.getByRole('button',{name:'Delete unexported edits',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('file(s) deleted'));await assert.rejects(fs.stat(cleanupFile),{code:'ENOENT'});
  await page.evaluate(()=>{state.selected=state.session.items[0].id;state.session.items[0].raw=false;setMode('develop');});await page.waitForFunction(()=>document.querySelector('#develop-message').textContent.includes('available for RAW'));
  assert.deepEqual(errors,[]);
  const result={passed:true,checks:['view/input shortcut isolation and Ctrl+Shift+E','browser desktop-only message','as-shot WB','persisted numeric adjustment','before/after','clipping triangles and overlay','copy/paste across photos','custom WB','double-click reset','histogram drag','one render in flight with latest settled settings','save/default recipe','16-bit batch, existing-file prompt and sequential editors','Skip/Stop and replace existing TIFFs','cached TIFF pixels in Review/zoom/grid/filmstrip and original toggle','result path, reveal, view and edit again without developing','persisted removable destination and Change','reopen and badges','external editor add/duplicate/remove/test/default settings, PNG P3 watch/multiple options', 'Ctrl+E from grid, Review/filmstrip action and alternate editor menu', 'recorded-file cleanup with unexported-edit warning','non-RAW message'],errors};await fs.writeFile(path.join(reports,'develop-ui.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 }finally{if(app)await app.close();await fs.rm(temp,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
