// node scripts/culling-bonus-windows.cjs EXECUTABLE REPORT_FOLDER [SOURCE_FOLDER]
// Launches only a copied executable, with isolated app data and WebView2 profile.
// Copies ARWs/JPEGs before reading metadata. Never drives or stops the installed app.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{createHash}=require('node:crypto'),{chromium}=require('playwright-core'),{ExifTool}=require('exiftool-vendored');
const {normalizeFocus,numbers,orientPoint}=require('../src/renderer/culling.js');
async function main() {
  if(process.platform!=='win32')throw new Error('Run this check on Windows.');
  const executable=path.resolve(process.argv[2]),reports=path.resolve(process.argv[3]),source=process.env.PHOTOCULL_SONY_DIR||process.argv[4];if(!source)throw new Error('Pass a folder of Sony ARW test copies as the third argument or PHOTOCULL_SONY_DIR.');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'photocull-bonus-native-')),photos=path.join(root,'photos'),data=path.join(root,'state');await fs.mkdir(photos);await fs.mkdir(reports,{recursive:true});
  const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex'),files=(await fs.readdir(source)).filter(n=>/\.arw$/i.test(n)).slice(0,3),hashes=[];
  assert.ok(files.length>0,'Supply a folder containing ARW fixtures.');
  for(const [i,name] of files.entries()) {
    const original=path.join(source,name),copy=path.join(photos,`frame-${String(i).padStart(3,'0')}.ARW`);hashes.push([original,await hash(original),copy]);await fs.copyFile(original,copy);
    const jpg=name.replace(/\.arw$/i,'.JPG');try{await fs.copyFile(path.join(source,jpg),copy.replace(/\.ARW$/,'.JPG'));}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  const exif=new ExifTool({maxProcs:1});let browser,child;const errors=[],checks=[];
  try {
    const tags=await exif.readRaw(hashes[0][2],{readArgs:['-Make','-Model','-FocusLocation','-FocusLocation2','-FocusFrameSize#','-Orientation#','-ImageWidth','-ImageHeight','-ExifImageWidth','-ExifImageHeight','-DefaultCropOrigin','-DefaultCropSize']});
    const expected=normalizeFocus(tags);assert.ok(expected,'The copied Sony fixture must contain AF coordinates.');
    const raw=numbers(tags.FocusLocation || tags.FocusLocation2);assert.equal(raw.length,4);const [expectedX,expectedY]=orientPoint(raw[2]/raw[0],raw[3]/raw[1],Number(tags.Orientation) || 1);assert.ok(Math.abs(expected.x-expectedX)<1e-9 && Math.abs(expected.y-expectedY)<1e-9);
    const runExe=path.join(root,'photocull.exe');await fs.copyFile(executable,runExe);
    const port=9349,env={...process.env,PHOTOCULL_SMOKE_TEST:'1',PHOTOCULL_DATA_DIR:data,PHOTOCULL_NODE:process.execPath,PHOTOCULL_BACKEND:path.resolve(__dirname,'../src/backend.cjs'),WEBVIEW2_USER_DATA_FOLDER:path.join(root,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`};
    child=spawn(runExe,[],{env,stdio:['ignore','pipe','pipe']});let output='';child.stderr.on('data',c=>{output+=c;});
    for(let attempt=0;attempt<90;attempt++){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);break;}catch{if(child.exitCode!==null)throw new Error(`Isolated app exited: ${output}`);await new Promise(r=>setTimeout(r,1000));}}
    assert.ok(browser,`WebView2 did not start: ${output}`);
    let page;for(let attempt=0;attempt<60;attempt++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>!p.url().startsWith('about:'));if(page)break;await new Promise(r=>setTimeout(r,500));}assert.ok(page);
    page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>typeof window.photocull!=='undefined' && typeof loadSession==='function');
    await page.evaluate(async folder=>{syncSettings(await api.settings({focusOverlay:true,autoAdvance:false}));loadSession(await api.openPath(folder,false));},photos);
    await page.waitForFunction(()=>document.querySelector('#review-image').dataset.complete==='yes',null,{timeout:90000});await page.waitForFunction(()=>!document.querySelector('#image-viewport .focus-overlay').hidden,null,{timeout:30000});
    const actual=await page.evaluate(()=>focusOf(state.selected));assert.ok(Math.abs(actual.x-expected.x)<1e-9 && Math.abs(actual.y-expected.y)<1e-9);checks.push('copied Sony metadata matches backend normalized focus coordinates');
    const placement=()=>page.evaluate(()=>{const image=document.querySelector('#review-image').getBoundingClientRect(),box=document.querySelector('#image-viewport .focus-box').getBoundingClientRect();return {x:(box.x+box.width/2-image.x)/image.width,y:(box.y+box.height/2-image.y)/image.height};});
    let p=await placement();assert.ok(Math.abs(p.x-expected.x)<.001 && Math.abs(p.y-expected.y)<.001);
    await page.screenshot({path:path.join(reports,'bonus-real-sony-overlay-windows.png')});
    await page.keyboard.press('Shift+A');await page.waitForFunction(()=>loupe.view.zoom.mode==='ratio' && !loupe.view.animation && document.querySelector('#review-image').dataset.complete==='yes',null,{timeout:90000});p=await placement();assert.ok(Math.abs(p.x-expected.x)<.001 && Math.abs(p.y-expected.y)<.001);assert.equal(await page.evaluate(()=>loupe.view.zoom.percent),100);
    await page.screenshot({path:path.join(reports,'bonus-real-sony-focus100-windows.png')});checks.push('real Sony AF overlay lands at metadata point at Fit and 100%');
    const score=await page.evaluate(async()=>{const id=state.selected,session=state.session.id;const first=await api.sharpness(session,id),start=performance.now(),second=await api.sharpness(session,id);return {first,second,cachedMs:performance.now()-start};});assert.ok(Number.isFinite(score.first) && score.first>0);assert.equal(score.first,score.second);checks.push('Lightcraft sharpness score is finite and reused from disk cache');
    if(files.length>=2) {await page.evaluate(()=>{state.marked=new Set(state.session.items.slice(0,2).map(i=>i.id));setMode('compare');});await page.waitForFunction(()=>survey.panes.length===2 && survey.panes.every(p=>p.view.visible));await page.screenshot({path:path.join(reports,'bonus-real-sony-compare-windows.png')});checks.push('real ARWs load side by side with AF overlays');}
    await page.evaluate(()=>{setMode('develop');});await page.waitForFunction(()=>document.querySelector('#develop-timing').textContent.includes('settled'),null,{timeout:120000});await page.locator('#develop-split').click();await page.locator('#develop-wipe').waitFor({state:'visible',timeout:120000});await page.screenshot({path:path.join(reports,'bonus-real-sony-develop-wipe-windows.png')});checks.push('native RAW Develop renders split preview and focus overlay');
    for(const [original,before,copy] of hashes){assert.equal(await hash(original),before);assert.equal(await hash(copy),before);}checks.push('source and copied RAW bytes remain unchanged');assert.deepEqual(errors,[]);
    const report={passed:true,checks,score,sourceHashesUnchanged:true,isolatedAppData:true,errors};await fs.writeFile(path.join(reports,'culling-bonus-windows.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  } finally {await exif.end();if(browser)await browser.close();if(child && child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await Promise.race([done,new Promise(r=>setTimeout(r,5000))]);}await fs.rm(root,{recursive:true,force:true}).catch(()=>{});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
