// Verify the running Windows Tauri app through its WebView2 debug port.
// Start npm start with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223.
// node scripts/develop-windows.cjs [fixtureFolder] [newReportFolder]
// Never launches Dehancer automatically; that round trip is an explicit manual check.
const { chromium } = require('playwright-core');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto'), sharp = require('sharp');
async function main() {
  const fixture = path.resolve(process.argv[2] || 'C:/Users/alex/Pictures/photo-samples');
  const reports = path.resolve(process.argv[3] || path.join(fixture, 'develop-ui-test'));
  await fs.mkdir(reports, { recursive: true });
  const sources = (await fs.readdir(fixture)).filter(n => /\.arw$/i.test(n));
  const hash = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const before = Object.fromEntries(await Promise.all(sources.map(async n => [n, await hash(path.join(fixture,n))])));
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const page = browser.contexts()[0].pages().find(p => /127\.0\.0\.1/.test(p.url()));
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await page.evaluate(async folder => {
      loadSession(await api.openPath(folder, false)); setMode('develop');
      window.__developFrames = [];
      document.querySelector('#develop').addEventListener('develop-frame', e => window.__developFrames.push(e.detail));
      window.__developTimings = [];
      const render = developView.queue.render;
      developView.queue.render = async (value, settled) => {
        const start = performance.now(), frame = await render(value, settled);
        window.__developTimings.push({ settled, totalMs: performance.now()-start, renderMs: frame.renderMs, loadMs: frame.loadMs });
        return frame;
      };
    }, fixture);
    await page.waitForFunction(() => document.querySelector('#develop-timing').textContent.includes('settled'), null, { timeout: 120000 });
    await page.screenshot({ path: path.join(reports, 'develop-real-initial.png') });
    const sourceInfo = await page.evaluate(() => developView.info);
    const box = await page.locator('#develop-light-exposure').boundingBox();
    await page.mouse.move(box.x + box.width*.5, box.y + box.height*.5); await page.mouse.down();
    for (let i=0;i<40;i++) { await page.mouse.move(box.x+box.width*(.5+i*.002),box.y+box.height*.5); await page.waitForTimeout(40); }
    await page.mouse.up();
    await page.waitForFunction(() => !developView.queue.running && !developView.queue.pending && document.querySelector('#develop-timing').textContent.includes('settled'));
    await page.screenshot({ path: path.join(reports, 'develop-real-drag.png') });
    await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('j'); await page.keyboard.press('\\');
    await page.waitForFunction(() => document.querySelector('#develop-timing').textContent.includes('Before') && document.querySelector('#develop-timing').textContent.includes('settled'));
    await page.screenshot({ path: path.join(reports, 'develop-real-before-clipping.png') });
    const timing = await page.evaluate(() => ({ requests: window.__developTimings, frames: window.__developFrames.map(({histogram,...frame}) => frame) }));
    assert.ok(timing.frames.filter(f => !f.settled && !f.before).length > 5, 'Continuous dragging must publish live drafts');
    const keep = await page.evaluate(async () => {
      const saved = await api.developGet(state.session.id, state.selected);
      if (!saved.tiff) return null;
      const folder = saved.tiff.replace(/[\\/][^\\/]+$/, '');
      const result = await api.developTiffs(state.session.id,folder,[{id:state.selected,settings:saved.settings}],{colorSpace:'srgb',bitDepth:16,replace:false});
      const after = await api.developGet(state.session.id,state.selected);
      return { before:saved, result, after };
    });
    if (keep) { assert.equal(keep.result.results[0].status,'exists'); assert.equal(keep.after.edited,keep.before.edited); }
    // Fresh full-resolution TIFF for another RAW, preserving the edited first TIFF.
    const fresh = await page.evaluate(async folder => {
      const item=state.session.items.filter(i=>i.raw)[1];
      if (!item) return null;
      const saved=await api.developGet(state.session.id,item.id); await api.makeFolder(folder);
      const start=performance.now(); const result=await api.developTiffs(state.session.id,folder,[{id:item.id,settings:saved.settings}],{colorSpace:'srgb',bitDepth:16,replace:false});
      return {ms:performance.now()-start,result};
    }, path.join(reports,'native-16bit'));
    let tiffMetadata = null;
    if (fresh) { assert.ok(['developed','exists'].includes(fresh.result.results[0].status)); const m=await sharp(fresh.result.results[0].tiff).metadata();tiffMetadata={width:m.width,height:m.height,depth:m.depth,bitsPerSample:m.bitsPerSample,space:m.space,hasProfile:m.hasProfile};assert.equal(m.bitsPerSample,16);assert.equal(m.hasProfile,true); }
    await page.keyboard.press('\\'); await page.evaluate(async()=>{await developView.flush();setMode('grid');});
    await page.waitForFunction(()=>!!document.querySelector('.develop-badges'));
    await page.screenshot({ path: path.join(reports,'develop-real-badges.png') });
    const after=Object.fromEntries(await Promise.all(sources.map(async n=>[n,await hash(path.join(fixture,n))])));assert.deepEqual(after,before);
    assert.deepEqual(errors,[]);
    const report={passed:true,sourceInfo,timing,keep,fresh,tiffMetadata,sourceHashesUnchanged:true,errors};
    await fs.writeFile(path.join(reports,'real-develop-report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({passed:true,sourceInfo:{camera:sourceInfo.camera,lens:sourceInfo.lens},requests:timing.requests,publishedDrafts:timing.frames.filter(f=>!f.settled&&!f.before).length,keepEdited:keep?.after.edited,tiffMetadata,sourceHashesUnchanged:true,errors},null,2));
  } finally { await browser.close(); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
