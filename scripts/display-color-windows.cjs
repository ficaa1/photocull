// Run against an isolated built app with WebView2 debugging on port 9338:
// node scripts/display-color-windows.cjs TEMP_ROOT PROCESS_ID [PORT]
// TEMP_ROOT/photos contains a COPY of sample-8582.tif. Optional raw/ contains a copied RAW.
// This writes reports/exports only below TEMP_ROOT and changes only that app's test session.
const { chromium } = require('playwright-core');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process'), { createHash } = require('node:crypto');
const sharp = require('sharp');
const REGIONS = { sky:[.5,.2], 'sky-low':[.75,.45], water:[.75,.85], rock:[.18,.6], scrub:[.12,.48] };
const DEHANCER = { sky:[113,175,203], 'sky-low':[153,192,206], water:[18,51,72], rock:[133,116,103], scrub:[146,184,198] };
const PHOTO_VIEWER = { sky:[114,175,204], 'sky-low':[154,193,207], water:[15,49,71], rock:[135,119,106], scrub:[147,185,199] };
async function sample(input, rect) {
  const values = {};
  for (const [name,[u,v]] of Object.entries(REGIONS)) {
    const { data, info } = await sharp(input).extract({left:Math.round(rect.x+rect.width*u)-5,top:Math.round(rect.y+rect.height*v)-5,width:10,height:10}).removeAlpha().raw().toBuffer({resolveWithObject:true});
    values[name] = [0,1,2].map(c => Math.round(Array.from({length:100},(_,i)=>data[i*info.channels+c]).reduce((a,b)=>a+b,0)/100));
  }
  return values;
}
async function main() {
  assert.equal(process.platform,'win32');
  const root=path.resolve(process.argv[2]), pid=Number(process.argv[3]);
  assert.ok(root && pid && !/[\\/]Pictures([\\/]|$)/i.test(root),'Use an isolated TEMP folder, never Pictures.');
  const input=path.join(root,'photos','sample-8582.tif'), reports=path.join(root,'verification');await fs.mkdir(reports,{recursive:true});
  const digest=async f=>createHash('sha256').update(await fs.readFile(f)).digest('hex');const before=await digest(input);
  const b=await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[4]||9338}`);
  const page=b.contexts()[0].pages().find(p=>/tauri.localhost/.test(p.url())); assert.ok(page);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const report={regions:REGIONS,webview:(await b.version()),views:{}};
  const capture=async(name,selector)=>{
    const geometry=await page.locator(selector).evaluate(img=>{const r=img.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,dpr:devicePixelRatio};});
    const file=path.join(reports,name+'-screen.png');
    const client=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'capture-window-windows.ps1'),'-ProcessId',String(pid),'-OutputPath',file],{encoding:'utf8'}));
    const rect={x:client.clientX+geometry.x*geometry.dpr,y:client.clientY+geometry.y*geometry.dpr,width:geometry.width*geometry.dpr,height:geometry.height*geometry.dpr};
    await page.screenshot({path:path.join(reports,name+'-cdp.png')});
    return {file,rect,values:await sample(file,rect)};
  };
  try {
    report.display=await page.evaluate(()=>window.__TAURI__.core.invoke('display_color_status'));
    await page.evaluate(async folder=>{loadSession(await api.openPath(folder,false));setMode('review');},path.join(root,'photos'));
    await page.waitForFunction(()=>document.querySelector('#review-image').dataset.complete==='yes');
    report.views.review=await capture('review','#review-image');
    for(const kind of ['thumb','preview','full']) {
      const url=await page.evaluate(kind=>api.imageUrl(state.session.id,state.selected,kind),kind);
      const response=await fetch(url);assert.ok(response.ok);
      const file=path.join(reports,kind+'.jpg');await fs.writeFile(file,Buffer.from(await response.arrayBuffer()));
      const m=await sharp(file).metadata();report[kind]={width:m.width,height:m.height,iccBytes:m.icc?.length||0};
    }
    // Show the exact preview bytes at a fixed 1600x1067 physical-pixel size for the reference regions.
    await page.evaluate(()=>{const img=document.createElement('img');img.id='color-measurement';img.src=document.querySelector('#review-image').src;img.style=`position:fixed;z-index:99999;left:0;top:0;width:${1600/devicePixelRatio}px;height:${1067/devicePixelRatio}px`;document.body.append(img);return img.decode();});
    report.measurement=await capture('measurement','#color-measurement');
    report.references={dehancer:DEHANCER,photoViewer:PHOTO_VIEWER};
    for(const [region,rgb] of Object.entries(report.measurement.values)) for(let c=0;c<3;c++) {
      assert.ok(rgb[c]>=Math.min(DEHANCER[region][c],PHOTO_VIEWER[region][c])-3 && rgb[c]<=Math.max(DEHANCER[region][c],PHOTO_VIEWER[region][c])+3,
        `${region} channel ${c}: ${rgb[c]} is outside the reference range ±3`);
    }
    report.colorsWithinThree=true;
    await page.evaluate(()=>document.querySelector('#color-measurement').remove());
    await page.evaluate(()=>setMode('grid'));await page.waitForFunction(()=>document.querySelector('.grid-card img')?.naturalWidth>0);
    await page.screenshot({path:path.join(reports,'grid.png')});
    await page.evaluate(()=>setMode('review'));await page.locator('#zoom-percent').selectOption('100');
    await page.waitForFunction(()=>document.querySelector('#review-image').dataset.complete==='yes' && document.querySelector('#review-image').naturalWidth===7008);
    await page.screenshot({path:path.join(reports,'zoom.png')});
    await page.evaluate(()=>loupe.fit());
    const exported=await page.evaluate(async root=>{
      const photo=state.session.items[0],settings=(await api.developGet(state.session.id,photo.id)).settings;
      return api.exportPhotos(state.session.id,[{id:photo.id,dest:root+'/export-after.jpg',settings,edited:false}],PhotoCullExport.options({format:'jpeg',quality:90,colorSpace:'srgb',metadata:'none',resize:{mode:'longEdge',value:1200,height:1200,dontEnlarge:true}}),true,state.settings.metadata);
    },root);assert.equal(exported.results[0].status,'exported');
    const old=await sharp(path.join(root,'export-before.jpg')).raw().toBuffer(),now=await sharp(path.join(root,'export-after.jpg')).raw().toBuffer();
    assert.deepEqual(now,old);report.exportPixelsIdentical=true;
    if (await fs.stat(path.join(root,'raw')).then(s=>s.isDirectory(),()=>false)) {
      // Prepare only the isolated test library, before the app first scans this folder.
      const { Library } = require('../src/library.cjs');
      const library=new Library(path.join(root,'data-default'));
      const session=await library.scan(path.join(root,'raw'),false),photo=session.items.find(i=>i.raw);
      await library.developMark(session.id,photo.id,{tiff:input,edited:true});
      await page.evaluate(async folder=>{loadSession(await api.openPath(folder,false));setMode('develop');},path.join(root,'raw'));
      await page.waitForFunction(()=>developView.resultFrame && document.querySelector('#develop-image').naturalWidth>0,null,{timeout:120000});
      report.views.dehancer=await capture('dehancer','#develop-image');
      const frames=await page.evaluate(async()=>{
        const session=state.session.id,id=state.selected,settings=(await api.developGet(session,id)).settings;
        const out={};for(const [name,f] of [['dehancer',await api.developResult(session,id)],['draft',await api.developRender(session,id,settings,false)],['settled',await api.developRender(session,id,settings,true)]]) {
          out[name]={width:f.width,height:f.height,histogram:f.histogram,bytes:Array.from(new Uint8Array(await f.blob.arrayBuffer()))};
        }return out;
      });
      report.native={};for(const [name,{bytes,...header}] of Object.entries(frames)) {
        const file=path.join(reports,'native-'+name+'.jpg');await fs.writeFile(file,Buffer.from(bytes));
        assert.ok((await sharp(file).metadata()).hasProfile);report.native[name]={...header,icc:true};
      }
      await page.evaluate(()=>developView.toggleResult());
      await page.waitForFunction(()=>!developView.queue.running && !developView.queue.pending && document.querySelector('#develop-timing').textContent.includes('settled'),null,{timeout:120000});
      await page.screenshot({path:path.join(reports,'raw-after.png')});
      // An edited RAW's Before button compares RAW against the Dehancer TIFF.
      await page.evaluate(()=>developView.toggleBefore());
      await page.waitForFunction(()=>developView.showResult && !developView.queue.running,null,{timeout:120000});
      await page.screenshot({path:path.join(reports,'raw-before.png')});
    }
    for(const [name,pipe] of [['old-sharp',sharp(input).toColourspace('srgb')],['srgb',sharp(input).withIccProfile('srgb')]]) {
      const bytes=await pipe.resize(1600,1067,{fit:'fill'}).png().toBuffer();report[name]=await sample(bytes,{x:0,y:0,width:1600,height:1067});
    }
    assert.equal(await digest(input),before);report.sourceUnchanged=true;assert.deepEqual(errors,[]);report.errors=errors;
    await fs.writeFile(path.join(reports,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  } finally {await b.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
