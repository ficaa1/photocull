// node viewer-ui-smoke.cjs EXECUTABLE|- REPORT_FOLDER [SONY_FIXTURE_FOLDER]
const { launch: launchApp } = require('./launch.cjs');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{createRequire}=require('node:module');
async function main(){
 const exe=process.argv[2],reports=path.resolve(process.argv[3]),root=await fs.mkdtemp(path.join(os.tmpdir(),'photocull-viewer-'));await fs.mkdir(reports,{recursive:true});
 const photos=path.join(root,'photos'),data=path.join(root,'state');await fs.mkdir(photos);
 const req=exe==='-'?require:createRequire(path.join(path.dirname(path.resolve(exe)),'resources','app','package.json')),sharp=req('sharp');
 await sharp({create:{width:3600,height:2400,channels:3,background:'#577d62'}}).jpeg().toFile(path.join(photos,'01_landscape.jpg'));
 await sharp({create:{width:2400,height:3600,channels:3,background:'#7b687d'}}).jpeg().toFile(path.join(photos,'02_portrait.jpg'));
 await sharp({create:{width:120,height:80,channels:3,background:'#987c54'}}).jpeg().toFile(path.join(photos,'03_small.jpg'));
 if(process.argv[4])await fs.copyFile(path.join(process.argv[4],'sample-8563.ARW'),path.join(photos,'04_camera.ARW'));
 let app,page;const errors=[],checks=[];
 async function launch(){const env={...process.env,PHOTOCULL_SMOKE_TEST:'1',PHOTOCULL_DATA_DIR:data};app=await launchApp({ env });page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.locator('#empty-open').waitFor();await page.evaluate(folder=>window.loadTestFolder(folder),photos);await complete();}
 async function complete(){await page.waitForFunction(()=>document.querySelector('#review-image').dataset.complete==='yes',null,{timeout:60000});}
 // Zoom changes animate for ~150 ms; measure once they have finished.
 async function settled(){await page.waitForFunction(()=>!document.querySelector('#image-viewport').classList.contains('animating'));await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
 async function fit(){await page.waitForFunction(()=>!document.querySelector('#image-viewport').classList.contains('zoomed'));await settled();}
 async function zoomed(){return page.locator('#image-viewport').evaluate(node=>node.classList.contains('zoomed'));}
 async function geometry(){await settled();return page.locator('#review-image').evaluate(img=>{const b=img.getBoundingClientRect(),v=img.parentElement.getBoundingClientRect();return{width:b.width,height:b.height,left:b.left-v.left,top:b.top-v.top,natural:img.naturalWidth,vw:v.width,vh:v.height};});}
 const level=()=>page.locator('#zoom-level').textContent();
 const photoPoint=(g,p)=>({x:(p.x-g.left)/g.width,y:(p.y-g.top)/g.height});
 const center=g=>photoPoint(g,{x:g.vw/2,y:g.vh/2});
 function samePoint(g,a,b,label){assert.ok(Math.abs(a.x-b.x)*g.width<1.5&&Math.abs(a.y-b.y)*g.height<1.5,`${label}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);}
 async function viewport(){return page.locator('#image-viewport').boundingBox();}
 // Browsers report whole-pixel pointer positions; use them so expected and actual anchors agree.
 const at=(v,fx,fy)=>({x:Math.round(v.x+v.width*fx)-v.x,y:Math.round(v.y+v.height*fy)-v.y});
 async function clickImage(fx=.65,fy=.5){const v=await viewport(),p=at(v,fx,fy);await page.mouse.click(v.x+p.x,v.y+p.y);}
 try{
 await launch();
 let g=await geometry(),v=await viewport();const clicked=at(v,.65,.5),under=photoPoint(g,clicked);
 await clickImage();await complete();assert.equal(await zoomed(),true);assert.equal(await page.locator('#zoom-percent').inputValue(),'100');g=await geometry();assert.equal(g.width,3600);assert.equal(g.height,2400);checks.push('click-to-zoom uses full image pixel dimensions');
 samePoint(g,photoPoint(g,clicked),under,'clicked point under cursor');assert.equal(await level(),'100%');checks.push('click zoom keeps the clicked photo point under the cursor (Lightroom default)');
 const before=g;await page.mouse.move(v.x+v.width*.5,v.y+v.height*.5);await page.mouse.down();await page.mouse.move(v.x+v.width*.5+110,v.y+v.height*.5+65,{steps:8});await page.mouse.up();g=await geometry();assert.ok(Math.abs(g.left-before.left-110)<2);assert.ok(Math.abs(g.top-before.top-65)<2);assert.equal(await zoomed(),true);assert.equal(await page.locator('#zoom-percent').inputValue(),'100');checks.push('drag pans without toggling fit');
 await page.mouse.move(v.x+v.width*.5,v.y+v.height*.5);await page.mouse.down();await page.mouse.move(v.x+v.width*.5+3,v.y+v.height*.5+2,{steps:3});await page.mouse.up();await settled();assert.equal(await zoomed(),false);await clickImage();await complete();assert.equal(await zoomed(),true);checks.push('a press moving under 4 px is still a click');
 await page.mouse.move(v.x+5,v.y+5);await page.mouse.down();await page.mouse.move(v.x+5+5000,v.y+5+5000,{steps:6});await page.mouse.up();g=await geometry();assert.ok(Math.abs(g.left)<1&&Math.abs(g.top)<1,'pan is clamped at the top-left edge');checks.push('panning is clamped so the photo never leaves the view');
 await page.locator('#zoom-percent').selectOption('200');g=await geometry();assert.equal(g.width,7200);assert.equal(g.height,4800);checks.push('percentage selector scales relative to actual pixels');
 await clickImage();await fit();await complete();checks.push('click without dragging returns to fit');
 await clickImage();await complete();assert.equal(await zoomed(),true);assert.equal(await page.locator('#zoom-percent').inputValue(),'200');await page.keyboard.press('Space');await fit();checks.push('click remembers zoom percentage and Space toggles fit');

 // Keyboard: Z around the pointer, hold Space to pan, Ctrl +/-/0.
 const pointer=at(v,.3,.6);g=await geometry();const underPointer=photoPoint(g,pointer);await page.mouse.move(v.x+pointer.x,v.y+pointer.y);
 await page.keyboard.press('z');await complete();g=await geometry();assert.equal(await zoomed(),true);assert.equal(g.width,7200);samePoint(g,photoPoint(g,pointer),underPointer,'Z zooms around the pointer');
 await page.keyboard.press('z');await fit();checks.push('Z toggles fit and click zoom around the pointer');
 await page.keyboard.press('Space');await complete();assert.equal(await zoomed(),true);g=await geometry();
 await page.keyboard.down('Space');await page.mouse.down();await page.mouse.move(v.x+pointer.x+80,v.y+pointer.y+40,{steps:6});await page.mouse.up();await page.keyboard.up('Space');
 let after=await geometry();assert.equal(await zoomed(),true,'releasing Space after a drag keeps the zoom');assert.ok(Math.abs(after.left-g.left-80)<2&&Math.abs(after.top-g.top-40)<2,'Space+drag pans');
 await page.keyboard.down('Space');await page.mouse.click(v.x+pointer.x,v.y+pointer.y);await page.keyboard.up('Space');await settled();assert.equal(await zoomed(),true,'a click with the Space hand does not toggle');
 await page.keyboard.press('Space');await fit();checks.push('holding Space while zoomed pans (temporary hand); a Space tap returns to fit');
 const fitLevel=await level();await page.keyboard.press('Control+Equal');await settled();assert.equal(await zoomed(),true);const stepped=await level();assert.notEqual(stepped,fitLevel);
 await page.keyboard.press('Control+Equal');await settled();assert.ok(parseFloat(await level())>parseFloat(stepped));await page.keyboard.press('Control+Minus');await settled();assert.equal(await level(),stepped);
 await page.keyboard.press('Control+Minus');await fit();await page.keyboard.press('Control+Equal');await settled();await page.keyboard.press('Control+0');await fit();assert.equal(await level(),fitLevel);checks.push(`Ctrl +/- step zoom levels (${fitLevel} → ${stepped}) and Ctrl+0 fits`);

 // Wheel and trackpad.
 const name=await page.locator('#photo-name').textContent();await page.mouse.move(v.x+v.width*.5,v.y+v.height*.5);await page.mouse.wheel(0,240);await page.waitForTimeout(150);await settled();assert.equal(await zoomed(),false);assert.equal(await page.locator('#photo-name').textContent(),name);checks.push('plain wheel at fit neither zooms nor changes photo');
 const wheelAt=at(v,.7,.35);g=await geometry();const underWheel=photoPoint(g,wheelAt);await page.mouse.move(v.x+wheelAt.x,v.y+wheelAt.y);
 await page.keyboard.down('Control');await page.mouse.wheel(0,-200);await page.mouse.wheel(0,-200);await page.keyboard.up('Control');await page.waitForFunction(()=>document.querySelector('#image-viewport').classList.contains('zoomed'));await complete();g=await geometry();
 samePoint(g,photoPoint(g,wheelAt),underWheel,'Ctrl+wheel zooms around the pointer');const wheelLevel=parseFloat(await level());assert.ok(wheelLevel>parseFloat(fitLevel)&&wheelLevel<=1600);
 const beforeScroll=g;await page.mouse.wheel(0,120);await page.waitForTimeout(100);g=await geometry();assert.ok(Math.abs(beforeScroll.top-g.top-120)<2,'two-finger scroll pans');assert.equal(parseFloat(await level()),wheelLevel);
 await page.keyboard.down('Control');for(let i=0;i<12;i++)await page.mouse.wheel(0,250);await page.keyboard.up('Control');await fit();checks.push(`Ctrl+wheel / pinch zooms around the pointer (${wheelLevel}%), scroll pans, zooming out stops at fit`);

 // Fill, then click zoom and back to Fill.
 await page.locator('#zoom-fill').click();await settled();g=await geometry();assert.ok(g.width>=g.vw-1&&g.height>=g.vh-1);assert.equal(await page.locator('#zoom-fill').getAttribute('aria-pressed'),'true');
 await clickImage();await complete();g=await geometry();assert.equal(g.width,7200);await clickImage();await settled();g=await geometry();assert.ok(g.width>=g.vw-1&&g.height>=g.vh-1&&g.width<7200,'click returns to Fill');await page.locator('#zoom').click();await fit();checks.push('Fill fills the view; click zoom returns to Fill');

 // Navigator.
 await page.locator('#zoom-percent').selectOption('100');await complete();assert.equal(await page.locator('#navigator-panel').isVisible(),true);
 const nav=await page.locator('#navigator').boundingBox(),navImage=await page.locator('#navigator-image').boundingBox();
 await page.mouse.click(navImage.x+navImage.width*.25,navImage.y+navImage.height*.3);g=await geometry();let c=center(g);assert.ok(Math.abs(c.x-.25)<.01&&Math.abs(c.y-.3)<.01,`navigator click moves the view: ${JSON.stringify(c)}`);
 const rect=await page.locator('#navigator-view').boundingBox();assert.ok(Math.abs((rect.x+rect.width/2-navImage.x)/navImage.width-.25)<.02&&Math.abs((rect.y+rect.height/2-navImage.y)/navImage.height-.3)<.02,'navigator rectangle follows the view');
 await page.mouse.move(navImage.x+navImage.width*.25,navImage.y+navImage.height*.3);await page.mouse.down();await page.mouse.move(navImage.x+navImage.width*.6,navImage.y+navImage.height*.55,{steps:5});await page.mouse.up();g=await geometry();c=center(g);assert.ok(Math.abs(c.x-.6)<.01&&Math.abs(c.y-.55)<.01,`navigator drag: ${JSON.stringify(c)}`);assert.ok(nav.width>100);checks.push('navigator shows the visible area; click and drag move the view');

 // Next photo keeps zoom level and relative position.
 const kept=center(await geometry());await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>document.querySelector('#photo-name').textContent==='02_portrait.jpg');await complete();g=await geometry();
 assert.equal(await zoomed(),true);assert.equal(await level(),'100%');assert.equal(g.width,2400);c=center(g);assert.ok(Math.abs(c.x-kept.x)<.01&&Math.abs(c.y-kept.y)<.01,`position carried over: ${JSON.stringify(c)} vs ${JSON.stringify(kept)}`);
 await page.keyboard.press('ArrowLeft');await complete();g=await geometry();c=center(g);assert.ok(Math.abs(c.x-kept.x)<.01&&Math.abs(c.y-kept.y)<.01);await page.keyboard.press('Escape');await fit();
 await page.keyboard.press('ArrowRight');await complete();assert.equal(await zoomed(),false);await page.keyboard.press('ArrowLeft');await complete();checks.push('next photo keeps zoom level and relative position; at fit it opens at fit');

 await page.locator('#fullscreen').click();await page.waitForFunction(()=>document.body.classList.contains('fullscreen-review'));await page.waitForFunction(()=>!document.body.classList.contains('filmstrip-visible'),null,{timeout:6000});assert.ok(await page.evaluate(()=>!!document.fullscreenElement));
 let bounds=await page.locator('#image-stage').boundingBox();const size=page.viewportSize()||await page.evaluate(()=>({width:innerWidth,height:innerHeight}));assert.ok(Math.abs(bounds.width-size.width)<3);assert.ok(Math.abs(bounds.height-size.height)<3);
 await page.mouse.move(size.width/2,size.height-4);await page.waitForFunction(()=>document.body.classList.contains('filmstrip-visible'));await page.waitForTimeout(700);assert.equal(await page.locator('#filmstrip').isVisible(),true);checks.push('native fullscreen fills the display and reveals carousel at bottom edge');
 await page.locator('.film-card').nth(1).click();await complete();assert.equal(await page.locator('#photo-name').textContent(),'02_portrait.jpg');assert.equal(await zoomed(),false);
 await page.mouse.move(size.width/2,size.height/2);await page.waitForFunction(()=>!document.body.classList.contains('filmstrip-visible'),null,{timeout:4000});checks.push('carousel selection navigates and autohides away from hover');
 assert.equal(await page.locator('#navigator-overlay').isVisible(),false);
 await page.locator('#zoom-percent').selectOption('100');await complete();g=await geometry();assert.equal(g.width,2400);assert.equal(g.height,3600);const nv=await viewport();await page.mouse.move(nv.x+nv.width/2,nv.y+nv.height/2);await page.mouse.down();await page.mouse.move(nv.x+nv.width/2-90,nv.y+nv.height/2-80,{steps:6});await page.mouse.up();assert.equal(await zoomed(),true);assert.equal(await page.locator('#zoom-percent').inputValue(),'100');
 assert.equal(await page.locator('#navigator-overlay').isVisible(),true);assert.equal(await page.locator('#navigator-panel').isVisible(),false);checks.push('fullscreen shows the navigator as an overlay only while zoomed');
 await page.screenshot({path:path.join(reports,`viewer-fullscreen-${process.platform}.png`)});checks.push('percentage zoom and drag work in fullscreen portrait review');
 await page.keyboard.press('5');await page.waitForFunction(()=>document.querySelector('#count-rated').textContent==='1');await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.body.classList.contains('fullscreen-review'));assert.equal(await zoomed(),true);assert.equal(await page.locator('#zoom-percent').inputValue(),'100');checks.push('fullscreen rating works and Escape restores normal layout without losing zoom');
 await page.keyboard.press('Escape');await fit();await page.keyboard.press('ArrowRight');await complete();await page.locator('#zoom-percent').selectOption('400');await complete();g=await geometry();assert.equal(g.width,480);assert.equal(g.height,320);assert.ok(g.left>=0&&g.top>=0);checks.push('small images use true percentage and stay centered');
 await page.keyboard.press('F11');await page.waitForFunction(()=>document.body.classList.contains('fullscreen-review'),null,{timeout:5000});await page.keyboard.press('F11');await page.waitForFunction(()=>!document.body.classList.contains('fullscreen-review'));checks.push('F11 toggles native fullscreen');
 // Queue rapid requests before the first native transition has completed.
 await page.evaluate(()=>Promise.all([setFullscreen(true),setFullscreen(false),setFullscreen(true),setFullscreen(false)]));
 assert.equal(await page.evaluate(()=>state.fullscreen),false);assert.equal(await page.evaluate(()=>!!document.fullscreenElement),false);
 const sidebar=await page.locator('#settings-open').boundingBox(),vp=await viewport();assert.ok(vp.x>sidebar.x+sidebar.width,'normal review stays beside the sidebar after rapid fullscreen toggles');checks.push('rapid fullscreen requests finish at the last target with native state and layout in sync');
 if(process.argv[4]){await page.keyboard.press('ArrowRight');await complete();await page.locator('#zoom-percent').selectOption('100');await complete();g=await geometry();assert.ok(g.natural>6000);assert.equal(await page.locator('#camera-preview').isVisible(),true);assert.match(await page.locator('#camera-preview').getAttribute('title'),/embedded/);checks.push('real Sony RAW zoom selects a full-size representation labelled "Camera preview"');await page.keyboard.press('Escape');await fit();}

 // Settings → General → Zoom clicked point to center.
 await page.locator('#settings-open').click();await page.locator('#zoom-click-center').check();await page.locator('#settings-save').click();await page.waitForFunction(()=>!document.querySelector('#settings-dialog').open);
 await page.keyboard.press('Home');await page.locator('.film-card').first().click();await complete();await page.locator('#zoom-percent').selectOption('200');await page.keyboard.press('Escape');await fit();
 v=await viewport();g=await geometry();const target=photoPoint(g,at(v,.6,.45));await clickImage(.6,.45);await complete();g=await geometry();c=center(g);assert.ok(Math.abs(c.x-target.x)<.01&&Math.abs(c.y-target.y)<.01,`clicked point centred: ${JSON.stringify(c)} vs ${JSON.stringify(target)}`);checks.push('"Zoom clicked point to center" setting centres the clicked point');
 await page.locator('#settings-open').click();await page.locator('#zoom-click-center').uncheck();await page.locator('#settings-save').click();await page.waitForFunction(()=>!document.querySelector('#settings-dialog').open);

 await page.locator('#zoom-percent').selectOption('200');await app.close();app=null;await launch();assert.equal(await page.locator('#zoom-percent').inputValue(),'200');assert.equal(await zoomed(),false);checks.push('zoom percentage persists while new photos open at fit');
 assert.deepEqual(errors,[]);const report={passed:true,platform:process.platform,checks,errors};await fs.writeFile(path.join(reports,`viewer-ui-${process.platform}.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 }catch(error){console.error({checks,errors,dom:await page?.evaluate(()=>({classes:document.body.className,focus:document.activeElement?.id,level:document.querySelector('#zoom-level')?.textContent,stamp:document.querySelector('#review-image')?.dataset.stamp})),native:await page?.evaluate(()=>({fullscreen:!!document.fullscreenElement}))});throw error;}finally{if(app)await app.close();await fs.rm(root,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
