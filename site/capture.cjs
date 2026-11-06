// node site/capture.cjs SAMPLE_FOLDER OUTPUT_FOLDER
// Captures the page's screenshots from the real renderer and Node backend in browser mode,
// at 1440×900 and 2× pixel density. SAMPLE_FOLDER holds anonymously named photos
// (sample-01.JPG, sample-05.ARW…) with location and owner metadata removed; they are copied
// to a temporary "Sample shoot" card and never modified. Browser mode has no Rust engine,
// so Develop rendering and sharpness scores are computed here from the same previews.
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '..');
const [samples, output] = process.argv.slice(2).map(p => p && path.resolve(p));
if (!samples || !output) { console.error('usage: node site/capture.cjs SAMPLE_FOLDER OUTPUT_FOLDER'); process.exit(2); }

const NATIVE = `(() => {
const real = window.photocull;
const bitmap = async (s, id) => createImageBitmap(await (await fetch(real.imageUrl(s, id, 'preview', '&v=site'))).blob());
const toLinear = v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4, toDisplay = v => v <= .0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - .055;
// Luminance Laplacian variance on a 480 px preview, the measure the desktop app ranks with.
const sharpness = async (s, id) => {
  const b = await bitmap(s, id), w = 480, h = Math.round(b.height * w / b.width), c = new OffscreenCanvas(w, h), x = c.getContext('2d');
  x.drawImage(b, 0, 0, w, h); const d = x.getImageData(0, 0, w, h).data, L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = .2126 * d[i * 4] + .7152 * d[i * 4 + 1] + .0722 * d[i * 4 + 2];
  let sum = 0, sq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let k = 1; k < w - 1; k++) { const i = y * w + k, v = 4 * L[i] - L[i - 1] - L[i + 1] - L[i - w] - L[i + w]; sum += v; sq += v * v; n++; }
  return (sq / n - (sum / n) ** 2) / 10;
};
// A tone curve over the preview: exposure in linear light, then shadows, highlights and contrast.
const render = async (s, id, settings = {}) => {
  const b = await bitmap(s, id), c = new OffscreenCanvas(b.width, b.height), x = c.getContext('2d'); x.drawImage(b, 0, 0);
  const img = x.getImageData(0, 0, b.width, b.height), d = img.data, l = settings.light || {}, gain = 2 ** (l.exposure || 0);
  const sh = (l.shadows || 0) / 100, hi = (l.highlights || 0) / 100, con = (l.contrast || 0) / 100, warm = ((settings.wb?.temp || 5200) - 5200) / 12000;
  const lut = Array.from({ length: 256 }, (_, i) => { let v = toDisplay(Math.min(1, toLinear(i / 255) * gain)); v += sh * .6 * v * (1 - v) ** 2; v += hi * .6 * v * v * (1 - v); v += con * (v - .5) * v * (1 - v) * 1.6; return Math.max(0, Math.min(255, Math.round(v * 255))); });
  const hist = { total: 0, r: new Array(256).fill(0), g: new Array(256).fill(0), b: new Array(256).fill(0), luma: new Array(256).fill(0) };
  for (let i = 0; i < d.length; i += 4) {
    const r = lut[Math.min(255, Math.round(d[i] * (1 + warm)))], g = lut[d[i + 1]], bl = lut[Math.max(0, Math.round(d[i + 2] * (1 - warm)))];
    d[i] = r; d[i + 1] = g; d[i + 2] = bl;
    if ((i >> 2) % 3 === 0) { hist.total++; hist.r[r]++; hist.g[g]++; hist.b[bl]++; hist.luma[Math.round(.2126 * r + .7152 * g + .0722 * bl)]++; }
  }
  x.putImageData(img, 0, 0);
  return { blob: await c.convertToBlob({ type: 'image/jpeg', quality: .92 }), width: b.width, height: b.height, renderMs: 0, loadMs: 0, histogram: hist };
};
window.photocull = Object.freeze({ ...real, canAnalyze: true, canDevelop: true, sharpness: (s, id) => sharpness(s, id),
  developInfo: async () => ({ base: { profile: { id: 'lc.neutral' }, wb: { mode: 'asShot', temp: 5200, tint: 2 }, light: { exposure: 0 }, optics: { lens_profile: true, vignetting_midpoint: 50 }, detail: { sharpen_amount: 0, nr_luminance: 0, nr_color: 0 } }, asShot: { temp: 5200, tint: 2 }, camera: 'Sony ILCE-7CM2', lensProfile: null, lensCorrection: false, lensDatabase: false }),
  developRender: (s, id, settings) => render(s, id, settings), developResult: (s, id) => render(s, id, {}), lensDatabase: async () => ({ installed: false, megabytes: 3 }) });
})();\n`;

async function launch(dataDir, devices, destination) {
  const backend = spawn(process.execPath, [path.join(root, 'src', 'backend.cjs'), '--web', '--port', '0'], { env: { ...process.env, PHOTOCULL_SMOKE_TEST: '1', PHOTOCULL_DATA_DIR: dataDir, PHOTOCULL_TEST_DEVICES: devices, PHOTOCULL_TEST_DESTINATION: destination }, stdio: ['pipe', 'ignore', 'pipe'] });
  const url = await new Promise((resolve, reject) => { let text = ''; backend.stderr.on('data', c => { text += c; const m = /PhotoCull web UI: (\S+)/.exec(text); if (m) resolve(m[1]); }); backend.once('exit', code => reject(new Error(`backend exited ${code}\n${text}`))); });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  page.on('dialog', d => d.dismiss().catch(() => {}));
  page.on('pageerror', e => console.log('page error:', e.message));
  await page.route('**/app.js', async route => { const r = await route.fetch(); await route.fulfill({ response: r, body: NATIVE + await r.text() }); });
  await page.goto(url);
  return { page, close: async () => { await browser.close(); backend.kill('SIGTERM'); } };
}

async function main() {
  await fs.mkdir(output, { recursive: true });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'photos-')), card = path.join(temp, 'Sample shoot'), dcim = path.join(card, 'DCIM', '100MSDCF');
  await fs.mkdir(dcim, { recursive: true }); await fs.mkdir(path.join(temp, 'Backup'));
  for (const name of await fs.readdir(samples)) if (/\.(jpe?g|arw)$/i.test(name)) await fs.copyFile(path.join(samples, name), path.join(dcim, name));
  const devices = path.join(temp, 'devices.json');
  await fs.writeFile(devices, JSON.stringify([{ id: 'sample-card', identity: 'sample-card', label: 'Sample shoot', root: card, photoRoot: path.join(card, 'DCIM'), camera: true }]));
  const app = await launch(path.join(temp, 'state'), devices, path.join(temp, 'Picks')), { page } = app, failures = [];
  const wait = ms => page.waitForTimeout(ms);
  const shot = async (name, fn) => { try { if (fn) await fn(); await page.evaluate(() => { if (!document.querySelector('dialog[open]')) document.activeElement?.blur(); }); await wait(400); await page.screenshot({ path: path.join(output, name + '.png') }); const open = page.locator('dialog[open]'); if (await open.count()) await open.first().screenshot({ path: path.join(output, name + '-dialog.png') }); console.log('ok', name); } catch (e) { failures.push(name); console.log('FAIL', name, e.message.split('\n')[0]); } };
  const loaded = () => page.waitForFunction(() => document.querySelector('#review-image').dataset.complete === 'yes', null, { timeout: 60000 });
  const select = async n => { await page.evaluate(n => { state.marked = new Set(); state.selected = state.session.items.find(i => i.name.startsWith(n)).id; render(true); }, n); };
  const key = async (...keys) => { for (const k of keys) await page.keyboard.press(k); };
  const close = async () => { await key('Escape'); await page.evaluate(() => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); }); await wait(150); };
  try {
    await page.waitForFunction(() => Number(document.querySelector('#count-all').textContent) >= 2, null, { timeout: 60000 });
    await page.evaluate(async () => { syncSettings(await api.settings({ autoAdvance: false, burstGap: 10 })); });
    await page.reload();
    await page.waitForFunction(() => Number(document.querySelector('#count-all').textContent) >= 2, null, { timeout: 60000 });
    // The stand-in renderer's timings say nothing about the desktop engine.
    await page.addStyleTag({ content: '#develop-timing{visibility:hidden}' });
    await page.waitForFunction(() => /ready/i.test(document.querySelector('#analysis-status').textContent), null, { timeout: 180000 }).catch(() => console.log('analysis did not finish'));
    await page.evaluate(() => document.activeElement?.blur());
    const decide = async (n, ...keys) => { await select(n); await key(...keys); };
    await decide('sample-01', 'p', '4'); await decide('sample-02', 'p', '3', 'Alt+3'); await decide('sample-03', 'x');
    await decide('sample-04', 'p', '5', 'Alt+1'); await decide('sample-07', '2'); await decide('sample-08', 'p', '5');
    await decide('sample-09', 'p', '4', 'Alt+4'); await decide('sample-10', 'p', '3');

    await select('sample-04'); await loaded();
    await shot('review');
    await shot('review-dusk', async () => { await select('sample-08'); await loaded(); });
    await shot('grid', async () => { await select('sample-04'); await key('g'); await page.locator('.grid-card').first().waitFor(); await page.evaluate(() => { const s = document.querySelector('#grid-size'); s.value = Number(s.min) + (s.max - s.min) * .6; s.dispatchEvent(new Event('input', { bubbles: true })); }); await wait(1500); });
    await key('e'); await select('sample-05'); await loaded();
    await shot('focus', async () => { await key('a'); await wait(300); await key('Shift+A'); await wait(800); });
    await key('Control+0'); await key('a');
    await shot('keep-sharpest', async () => { await page.locator('#burst-keep').click(); await page.locator('#burst-dialog').waitFor({ state: 'visible' }); });
    await close();
    await shot('compare', async () => { await page.evaluate(() => { const ids = state.session.items.filter(i => /sample-(07|08|09)/.test(i.name)).map(i => i.id); state.selected = ids[1]; state.marked = new Set(ids); render(true); }); await key('c'); await page.locator('.compare-pane').first().waitFor(); await wait(1500); });
    await key('c'); await select('sample-06');
    await shot('develop', async () => {
      await key('d'); await page.waitForFunction(() => document.querySelector('#develop-timing').textContent.includes('settled'), null, { timeout: 30000 });
      for (const [k, v] of [['light.exposure', .55], ['light.shadows', 45], ['light.highlights', -30], ['light.contrast', 12]]) await page.evaluate(([k, v]) => developView.change(k, v), [k, v]);
      await wait(2500);
    });
    await shot('develop-split', async () => { await key('Shift+Backslash'); await page.locator('#develop-wipe').waitFor({ state: 'visible' }); await wait(800); });
    await key('Shift+Backslash');
    await key('e'); await select('sample-08'); await loaded();
    await shot('editors', async () => { await page.locator('#settings-open').click(); await page.locator('[data-settings-tab="editors"]').click(); });
    await close();
    await shot('export', async () => {
      await key('Control+Shift+E'); await page.locator('#image-export-dialog').waitFor({ state: 'visible' });
      await page.locator('#image-export-folder').fill(path.join(temp, 'Finished'));
      await page.evaluate(() => { document.activeElement?.blur(); for (const e of document.querySelectorAll('#image-export-dialog, #image-export-dialog *')) e.scrollTop = 0; });
    });
    await close();
    await shot('palette', async () => { await key('Control+k'); await page.locator('#command-query').fill('export'); });
    await close();
    await shot('help', async () => { await key('?'); await page.locator('#help-dialog[open]').waitFor(); });
    await close();
    await shot('backup', async () => {
      await page.evaluate(() => openBackup()); await page.locator('#backup-dialog').waitFor({ state: 'visible' });
      await page.evaluate(folder => { const input = document.querySelector('#backup-destination'); input.value = folder; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }, path.join(temp, 'Backup'));
      await page.locator('#backup-start').click();
      await page.waitForFunction(() => !document.querySelector('#backup-start').disabled, null, { timeout: 180000 });
    });
  } finally { await app.close(); await fs.rm(temp, { recursive: true, force: true }); }
  if (failures.length) { console.log('failed:', failures.join(', ')); process.exitCode = 1; }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
