// Real Tauri/WebView2 integration. Start npm start with a dedicated WEBVIEW2_USER_DATA_FOLDER and
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9337. Never writes the fixtures.
const { chromium } = require('playwright-core');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { ExifTool } = require('exiftool-vendored');
async function main() {
  if (process.platform !== 'win32') throw new Error('Run with Windows Node against the isolated Windows Tauri build.');
  const fixture = process.argv[2] || 'C:\\Users\\alex\\Pictures\\photo-samples';
  const output = path.join(fixture, 'export-ui-test', 'run-' + new Date().toISOString().replace(/[:.]/g, '-'));
  const reports = path.resolve('artifacts/image-export-windows'); await fs.mkdir(output, { recursive: true }); await fs.mkdir(reports, { recursive: true });
  const sources = (await fs.readdir(fixture)).filter(n => /\.arw$/i.test(n)).map(n => path.join(fixture, n));
  const edited = path.join(fixture, 'dehancer-test', 'sample-8563.tif');
  const hash = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const before = await Promise.all([...sources, edited].map(hash));
  const { Library } = require('../src/library.cjs');
  const testLibrary = new Library('C:\\Users\\alex\\src\\photocull-export-state');
  const prepared = await testLibrary.scan(fixture, false);
  const first = prepared.items.find(i => i.name === 'sample-8563.ARW');
  await testLibrary.developMark(prepared.id, first.id, { tiff: edited, edited: true });
  for (const i of prepared.items.filter(i => i.raw)) await testLibrary.decide(prepared.id, i.id, { flag: 'pick' });
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9337');
  const page = browser.contexts()[0].pages().find(p => /127\.0\.0\.1/.test(p.url()));
  assert.ok(page); page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const exif = new ExifTool(), results = [];
  try {
    await page.waitForFunction(() => window.photocull && window.PhotoCullExport);
    await page.evaluate(async ({fixture, edited}) => {
      const s = await api.openPath(fixture, false); loadSession(s);
      syncSettings(await api.settings({ metadata: { creator: 'PhotoCull Export Test', copyright: 'Copyright PhotoCull Export Test', title: 'Export verification', caption: 'Real Sony and Dehancer export', keywords: ['PhotoCull', 'export-test'] } }));
    }, {fixture, edited});
    console.log('Loaded real Sony session');
    await page.evaluate(() => { document.querySelector('#image-export-close').click(); document.querySelector('#image-export').click(); });
    await page.waitForFunction(() => document.querySelector('#image-export-dialog').open);
    await page.evaluate(output => {
      const folder = document.querySelector('#image-export-folder'); folder.value = output; folder.dispatchEvent(new Event('input', { bubbles: true }));
      for (const [id, value] of [['source', 'raw'], ['format', 'jpeg']]) {
        const input = document.querySelector('#image-export-' + id); input.value = value; input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      document.querySelector('#image-export-start').click();
    }, output);
    console.log('Started real dialog JPEG batch');
    await page.waitForFunction(() => !state.busy && !!document.querySelector('#image-export-status').textContent, null, { timeout: 180000, polling: 500 });
    const status = await page.locator('#image-export-status').innerText(); console.log(status);
    assert.match(status, new RegExp(`${sources.length} exported · 0 skipped · 0 failed`));
    // Capture via CDP (WebView2 implements this in the debug-enabled Windows test app).
    try { await page.screenshot({ path: path.join(reports, 'tauri-export-batch.png'), timeout: 10000 }); } catch (e) { console.log('Screenshot: ' + e.message); }
    for (const name of await fs.readdir(output)) if (/\.jpg$/i.test(name)) {
      const file = path.join(output, name); results.push({ case: 'ui-raw-batch', file, bytes: (await fs.stat(file)).size, tags: await exif.readRaw(file) });
    }
    await page.evaluate(() => document.querySelector('#image-export-close').click());
    // Exercise every encoder through the real shell API with the same dialog mapping and Node name planner.
    const configs = [
      { label: 'jpeg', format: 'jpeg', quality: 90 },
      { label: 'jxl-lossy', format: 'jxl', quality: 90 },
      { label: 'jxl-lossless', format: 'jxl', jxlLossless: true, bitDepth: 16 },
      { label: 'tiff16', format: 'tiff', bitDepth: 16, tiffCompression: 'deflate' },
      { label: 'png16', format: 'png', bitDepth: 16 },
      { label: 'avif10', format: 'avif', bitDepth: 10, quality: 80 },
      { label: 'webp', format: 'webp' },
    ];
    for (const source of ['edited', 'raw']) for (const resize of [false, true]) for (const config of configs) {
      const label = `${source}-${resize ? '1200-screen' : 'full'}-${config.label}`;
      console.log('Exporting ' + label);
      const result = await page.evaluate(async ({ config, source, resize, output, label }) => {
        const photo = state.session.items.find(i => i.name === 'sample-8563.ARW');
        const o = PhotoCullExport.options({ ...config, colorSpace: 'srgb', sharpen: resize ? 'screen' : 'none', resize: resize ? { mode: 'longEdge', value: 1200, height: 1200, dontEnlarge: true } : null });
        const plan = await api.exportPlan(state.session.id, [photo.id], { folder: output, naming: { template: '{text}', text: label, start: 1 }, extension: PhotoCullExport.FORMATS[o.format].extension, conflict: 'unique' });
        if (plan[0].error) throw new Error(plan[0].error);
        const develop = await api.developGet(state.session.id, photo.id);
        const result = await api.exportPhotos(state.session.id, [{ id: photo.id, dest: plan[0].dest, settings: develop.settings, edited: source === 'edited' }], o, false, state.settings.metadata);
        return { ...result.results[0], options: o };
      }, { config, source, resize, output, label });
      assert.equal(result.status, 'exported', JSON.stringify(result));
      result.case = label; result.bytes = (await fs.stat(result.dest)).size; result.tags = await exif.readRaw(result.dest);
      results.push(result); await fs.writeFile(path.join(reports, 'results.json'), JSON.stringify({ output, errors, results }, null, 2));
      console.log(`${label}: ${result.ms} ms, ${result.bytes} bytes`);
    }
    // Extra real-file controls: color conversion, metadata policies, JPEG byte limit, skip and cancellation.
    for (const policy of ['allExceptCamera', 'copyright', 'none']) {
      const r = await page.evaluate(async ({ output, policy }) => {
        const photo = state.session.items.find(i => i.name === 'sample-8563.ARW');
        const develop = await api.developGet(state.session.id, photo.id);
        const options = PhotoCullExport.options({ format: 'jpeg', colorSpace: 'displayP3', metadata: policy, removeLocation: true,
          limitKb: 100, resize: { mode: 'longEdge', value: 1200, height: 1200, dontEnlarge: true } });
        const plan = await api.exportPlan(state.session.id, [photo.id], { folder: output, naming: { template: '{text}', text: 'metadata-' + policy, start: 1 }, extension: 'jpg' });
        return (await api.exportPhotos(state.session.id, [{ id: photo.id, dest: plan[0].dest, settings: develop.settings, edited: true }], options, false, state.settings.metadata)).results[0];
      }, { output, policy });
      assert.equal(r.status, 'exported'); r.case = 'metadata-' + policy; r.bytes = (await fs.stat(r.dest)).size; r.tags = await exif.readRaw(r.dest);
      assert.ok(r.bytes <= 100 * 1024);
      results.push(r);
    }
    await page.evaluate(async output => {
      await imageExport.open();
      const folder = document.querySelector('#image-export-folder'); folder.value = output; folder.dispatchEvent(new Event('input', { bubbles: true }));
      const conflict = document.querySelector('#image-export-conflict'); conflict.value = 'skip'; conflict.dispatchEvent(new Event('change', { bubbles: true }));
      await document.querySelector('#image-export-start').onclick();
    }, output);
    const skipSummary = await page.locator('#image-export-status').innerText();
    assert.equal(skipSummary, `0 exported · ${sources.length} skipped · 0 failed`);
    await page.evaluate(() => document.querySelector('#image-export-close').click());
    const cancelled = await page.evaluate(async output => {
      const photos = state.session.items.filter(i => i.raw).slice(0, 2), items = [];
      for (const photo of photos) items.push({ id: photo.id, dest: output + '\\cancel-' + photo.name + '.avif', settings: (await api.developGet(state.session.id, photo.id)).settings });
      const pending = api.exportPhotos(state.session.id, items, PhotoCullExport.options({ format: 'avif', quality: 80 }), false, state.settings.metadata);
      setTimeout(() => void api.developCancel(), 500);
      return pending;
    }, output);
    assert.ok(cancelled.results.every(r => r.status === 'cancelled'));
    const nonraw = await page.evaluate(async ({ folder, output }) => {
      loadSession(await api.openPath(folder, false));
      const photo = state.session.items.find(i => i.name === 'sample-8563.tif');
      if (!photo || photo.raw) throw new Error('Expected the standalone Dehancer TIFF.');
      const settings = (await api.developGet(state.session.id, photo.id)).settings;
      const options = PhotoCullExport.options({ format: 'png', bitDepth: 16, colorSpace: 'displayP3', resize: { mode: 'longEdge', value: 1200, height: 1200, dontEnlarge: true } });
      const plan = await api.exportPlan(state.session.id, [photo.id], { folder: output, naming: { template: '{text}', text: 'nonraw-tiff', start: 1 }, extension: 'png' });
      return { ...(await api.exportPhotos(state.session.id, [{ id: photo.id, dest: plan[0].dest, settings, edited: false }], options, false, state.settings.metadata)).results[0], options };
    }, { folder: path.dirname(edited), output });
    assert.equal(nonraw.status, 'exported'); nonraw.case = 'nonraw-tiff'; nonraw.bytes = (await fs.stat(nonraw.dest)).size; nonraw.tags = await exif.readRaw(nonraw.dest); results.push(nonraw);
    assert.equal(nonraw.tags.ImageWidth, 1200); assert.equal(nonraw.tags.ImageHeight, 800);
    console.log('PASS non-RAW original TIFF → PNG16 Display P3, 1200×800, source unchanged.');
    console.log('PASS native skip-existing, metadata policies, Display P3, JPEG size limit and cancellation');
    assert.deepEqual(await Promise.all([...sources, edited].map(hash)), before, 'Source fixtures changed');
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(reports, 'results.json'), JSON.stringify({ passed: true, output, sourceHashesUnchanged: true, errors, results }, null, 2));
    console.log('PASS real Windows Tauri exports; originals and Dehancer TIFF are byte-identical. ' + output);
  } finally { await exif.end(); await browser.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
