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
 async function fit(){await page.waitForFunction(()=>!document.querySelector('#image-viewport').classList.contains('zoomed'));}
 async function zoomed(){return page.locator('#image-viewport').evaluate(node=>node.classList.contains('zoomed'));}
 async function geometry(){return page.locator('#review-image').evaluate(img=>{const b=img.getBoundingClientRect(),v=img.parentElement.getBoundingClientRect();return{width:b.width,height:b.height,left:b.left-v.left,top:b.top-v.top,natural:img.naturalWidth,vw:v.width,vh:v.height};});}
 async function clickImage(){const v=await page.locator('#image-viewport').boundingBox();await page.mouse.click(v.x+v.width*.65,v.y+v.height*.5);}
 try{
 await launch();await clickImage();await complete();assert.equal(await zoomed(),true);assert.equal(await page.locator('#zoom-percent').inputValue(),'100');let g=await geometry();assert.equal(g.width,3600);assert.equal(g.height,2400);checks.push('click-to-zoom uses full image pixel dimensions');
 const v=await page.locator('#image-viewport').boundingBox(),before=g;await page.mouse.move(v.x+v.width*.5,v.y+v.height*.5);await page.mouse.down();await page.mouse.move(v.x+v.width*.5+110,v.y+v.height*.5+65,{steps:8});await page.mouse.up();g=await geometry();assert.ok(Math.abs(g.left-before.left-110)<2);assert.ok(Math.abs(g.top-before.top-65)<2);assert.equal(await zoomed(),true);assert.equal(await page.locator('#zoom-percent').inputValue(),'100');checks.push('drag pans without toggling fit');
 await page.locator('#zoom-percent').selectOption('200');g=await geometry();assert.equal(g.width,7200);assert.equal(g.height,4800);checks.push('percentage selector scales relative to actual pixels');
 await clickImage();await fit();await complete();checks.push('click without dragging returns to fit');
 await clickImage();await complete();assert.equal(await zoomed(),true);assert.equal(await page.locator('#zoom-percent').inputValue(),'200');await page.keyboard.press('Space');await fit();checks.push('click remembers zoom percentage and Space toggles fit');
 await page.locator('#fullscreen').click();await page.waitForFunction(()=>document.body.classList.contains('fullscreen-review'));await page.waitForFunction(()=>!document.body.classList.contains('filmstrip-visible'),null,{timeout:6000});assert.ok(await page.evaluate(()=>!!document.fullscreenElement));
 let bounds=await page.locator('#image-stage').boundingBox();const size=page.viewportSize()||await page.evaluate(()=>({width:innerWidth,height:innerHeight}));assert.ok(Math.abs(bounds.width-size.width)<3);assert.ok(Math.abs(bounds.height-size.height)<3);
 await page.mouse.move(size.width/2,size.height-4);await page.waitForFunction(()=>document.body.classList.contains('filmstrip-visible'));await page.waitForTimeout(700);assert.equal(await page.locator('#filmstrip').isVisible(),true);checks.push('native fullscreen fills the display and reveals carousel at bottom edge');
 await page.locator('.film-card').nth(1).click();await complete();assert.equal(await page.locator('#photo-name').textContent(),'02_portrait.jpg');assert.equal(await zoomed(),false);
 await page.mouse.move(size.width/2,size.height/2);await page.waitForFunction(()=>!document.body.classList.contains('filmstrip-visible'),null,{timeout:4000});checks.push('carousel selection navigates and autohides away from hover');
 await page.locator('#zoom-percent').selectOption('100');await complete();g=await geometry();assert.equal(g.width,2400);assert.equal(g.height,3600);const nv=await page.locator('#image-viewport').boundingBox();await page.mouse.move(nv.x+nv.width/2,nv.y+nv.height/2);await page.mouse.down();await page.mouse.move(nv.x+nv.width/2-90,nv.y+nv.height/2-80,{steps:6});await page.mouse.up();assert.equal(await zoomed(),true);assert.equal(await page.locator('#zoom-percent').inputValue(),'100');
 await page.screenshot({path:path.join(reports,`viewer-fullscreen-${process.platform}.png`)});checks.push('percentage zoom and drag work in fullscreen portrait review');
 await page.keyboard.press('5');await page.waitForFunction(()=>document.querySelector('#count-rated').textContent==='1');await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.body.classList.contains('fullscreen-review'));assert.equal(await zoomed(),true);assert.equal(await page.locator('#zoom-percent').inputValue(),'100');checks.push('fullscreen rating works and Escape restores normal layout without losing zoom');
 await page.keyboard.press('Escape');await fit();await page.keyboard.press('ArrowRight');await complete();await page.locator('#zoom-percent').selectOption('400');await complete();g=await geometry();assert.equal(g.width,480);assert.equal(g.height,320);assert.ok(g.left>=0&&g.top>=0);checks.push('small images use true percentage and stay centered');
 await page.keyboard.press('F11');await page.waitForFunction(()=>document.body.classList.contains('fullscreen-review'),null,{timeout:5000});await page.keyboard.press('F11');await page.waitForFunction(()=>!document.body.classList.contains('fullscreen-review'));checks.push('F11 toggles native fullscreen');
 if(process.argv[4]){await page.keyboard.press('ArrowRight');await complete();await page.locator('#zoom-percent').selectOption('100');await complete();g=await geometry();assert.ok(g.natural>6000);checks.push('real Sony RAW zoom selects a full-size representation');}
 await page.locator('#zoom-percent').selectOption('200');await app.close();app=null;await launch();assert.equal(await page.locator('#zoom-percent').inputValue(),'200');assert.equal(await zoomed(),false);checks.push('zoom percentage persists while new photos open at fit');
 assert.deepEqual(errors,[]);const report={passed:true,platform:process.platform,checks,errors};await fs.writeFile(path.join(reports,`viewer-ui-${process.platform}.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 }catch(error){console.error({checks,errors,dom:await page?.evaluate(()=>({classes:document.body.className,focus:document.activeElement?.id})),native:await page?.evaluate(()=>({fullscreen:!!document.fullscreenElement}))});throw error;}finally{if(app)await app.close();await fs.rm(root,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
