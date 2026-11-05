// Browser UI smoke: the renderer/backend are real; only native develop/Dehancer APIs are mocked.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {launch}=require('./launch.cjs');
async function main(){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'photocull-develop-ui-')),photos=path.join(temp,'photos');await fs.mkdir(photos);
 const sharp=require('sharp');await sharp({create:{width:960,height:640,channels:3,background:'#7c9fa3'}}).jpeg().toFile(path.join(photos,'test.jpg'));await fs.writeFile(path.join(photos,'test.ARW'),'mock RAW');await fs.writeFile(path.join(photos,'second.ARW'),'mock RAW');
 const reports=path.resolve(process.argv[2]||'artifacts/develop-ui');await fs.mkdir(reports,{recursive:true});
 let app;const errors=[];try{
  app=await launch({env:{...process.env,PHOTOCULL_DATA_DIR:path.join(temp,'state')}});const page=await app.firstWindow();page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE:',e.stack);});
  await page.evaluate(async folder=>{loadSession(await api.openPath(folder,false));setMode('develop');},photos);
  await page.waitForFunction(()=>document.querySelector('#develop-message').textContent.includes('desktop app'));
  // Replace the frozen bridge before app.js executes, leaving backend persistence intact.
  await page.route('**/app.js',async route=>{const original=await route.fetch();await route.fulfill({response:original,body:`
  window.__developMock={calls:[],active:0,max:0,edits:[],tiffs:[],editActive:0,editMax:0};
  const realDevelopGet=window.photocull.developGet;
  window.photocull=Object.freeze({...window.photocull,canDevelop:true,
   developGet:async(session,id)=>({...await realDevelopGet(session,id),edited:window.__developMock.edits.includes(id)}),
   developInfo:async()=>({base:{profile:{id:'lc.neutral'},wb:{mode:'asShot',temp:5100,tint:4},light:{exposure:0},optics:{lens_profile:true,vignetting_midpoint:50},detail:{sharpen_amount:0,nr_luminance:0,nr_color:0}},asShot:{temp:5100,tint:4},camera:'Sony A7C II',lensProfile:null,lensCorrection:false,lensDatabase:false}),
   developPlan:async(session,ids,folder)=>ids.map(id=>({id,name:'test.ARW',tiff:folder+'/test.tif',exists:true})),
   lensDatabase:async()=>({installed:false,megabytes:3}),
   developRender:async(session,id,settings,settled)=>{const m=window.__developMock;m.max=Math.max(m.max,++m.active);m.calls.push({id,settings:structuredClone(settings),settled});await new Promise(r=>setTimeout(r,35));const c=document.createElement('canvas');c.width=960;c.height=640;const ctx=c.getContext('2d');ctx.fillStyle='#778888';ctx.fillRect(0,0,960,640);ctx.fillStyle='#fff';ctx.fillRect(0,0,50,640);ctx.fillStyle='#000';ctx.fillRect(910,0,50,640);const blob=await new Promise(r=>c.toBlob(r,'image/jpeg'));const h={total:1000};for(const k of ['r','g','b','luma'])h[k]=Array.from({length:256},(_,i)=>i===0||i===255?20:Math.max(0,100-Math.abs(i-128)));m.active--;return {blob,width:960,height:640,renderMs:35,loadMs:0,histogram:h};},
   developTiffs:async(session,folder,jobs,options)=>{window.__developMock.tiffs.push({folder,jobs,options});return {results:jobs.map(j=>({id:j.id,status:'developed',tiff:folder+'/test.tif'}))};},
   dehancerEdit:async(session,id)=>{const m=window.__developMock;m.edits.push(id);m.editMax=Math.max(m.editMax,++m.editActive);await new Promise(r=>m.waitForEdit?m.finishEdit=r:setTimeout(r,60));m.editActive--;return {edited:!m.waitForEdit};},developCancel:async()=>{window.__developMock.finishEdit?.();window.__developMock.finishEdit=null;},
  });\n`+(await original.text())});});
  await page.reload();await page.evaluate(async folder=>{loadSession(await api.openPath(folder,false));setMode('develop');},photos);
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
  await page.locator('#develop-recipe-default').click();await page.waitForFunction(()=>state.settings.defaultRecipe===document.querySelector('#develop-recipe').value);
  await page.evaluate(()=>{state.marked=new Set(state.session.items.filter(i=>i.raw).map(i=>i.id));render();});
  await page.locator('#develop-send').click();await page.locator('#develop-batch-start').click();await page.getByRole('button',{name:'Keep existing (may contain Dehancer edits)',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#develop-batch-status').textContent.includes('Finished'));
  assert.equal(await page.evaluate(()=>window.__developMock.edits.length),2);assert.equal(await page.evaluate(()=>window.__developMock.editMax),1);assert.equal(await page.evaluate(()=>state.session.items.filter(i=>i.dehancer).length),2);assert.equal(await page.evaluate(()=>window.__developMock.tiffs[0].options.bitDepth),16);
  await page.locator('#develop-batch-stop').click();await page.screenshot({path:path.join(reports,'develop-mocked.png')});
  await page.evaluate(()=>{window.__developMock.waitForEdit=true;});await page.locator('#develop-send').click();await page.locator('#develop-batch-start').click();await page.getByRole('button',{name:'Replace existing TIFFs',exact:true}).click();await page.waitForFunction(()=>!!window.__developMock.finishEdit);await page.locator('#develop-batch-skip').click();await page.waitForFunction(()=>document.querySelector('#develop-batch-status').textContent.includes('2 of 2')&&!!window.__developMock.finishEdit);await page.locator('#develop-batch-stop').click();await page.waitForFunction(()=>document.querySelector('#develop-batch-status').textContent.includes('Stopped'));assert.equal(await page.evaluate(()=>window.__developMock.tiffs.at(-1).options.replace),true);await page.locator('#develop-batch-stop').click();

  await page.evaluate(async()=>{await developView.flush();const s=state.session;loadSession(await api.openPath(s.folder,false));setMode('develop');});await page.waitForFunction(()=>!document.querySelector('.develop-controls').disabled);
  await page.evaluate(()=>{setMode('grid');state.session.items[0].adjusted=true;state.session.items[0].developed=true;state.session.items[0].dehancer=true;render();});await page.waitForFunction(()=>document.querySelector('.develop-badges'));
  await page.locator('#settings-open').click();await page.locator('#settings-dialog').waitFor({state:'visible'});assert.equal(await page.locator('#default-recipe').inputValue(),await page.evaluate(()=>state.settings.defaultRecipe));await page.locator('#dehancer-exe').fill('C:\\Test\\Dehancer.exe');await page.locator('#settings-save').click();await page.locator('#settings-dialog').waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>state.settings.dehancerExe),'C:\\Test\\Dehancer.exe');
  await page.evaluate(()=>{state.selected=state.session.items[0].id;state.session.items[0].raw=false;setMode('develop');});await page.waitForFunction(()=>document.querySelector('#develop-message').textContent.includes('available for RAW'));
  assert.deepEqual(errors,[]);
  const result={passed:true,checks:['view/input shortcut isolation and Ctrl+Shift+E','browser desktop-only message','as-shot WB','persisted numeric adjustment','before/after','clipping triangles and overlay','copy/paste across photos','custom WB','double-click reset','histogram drag','one render in flight with latest settled settings','save/default recipe','16-bit batch, existing-file prompt and sequential editors','Skip/Stop and replace existing TIFFs','reopen and badges','General develop settings','non-RAW message'],errors};await fs.writeFile(path.join(reports,'develop-ui.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 }finally{if(app)await app.close();await fs.rm(temp,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
