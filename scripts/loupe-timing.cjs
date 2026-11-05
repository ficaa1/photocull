// Screen-level loupe timings in headless Chromium (browser mode):
//   node scripts/loupe-timing.cjs RAW_FOLDER [LABEL]
// Copies up to eight RAWs (cycling) into a temporary folder, opens it with a
// cold preview cache and measures, from the input event to the decoded image
// being on screen (#review-image data-complete):
//   first      first photo after opening the folder
//   next       ArrowRight after the viewer has been idle for 3 s
//   zoom       click to zoom → full-size pixels on screen
//   zoomNext   ArrowRight while zoomed (old builds reset to Fit here)
//   burst      four ArrowRight presses 60 ms apart, from the last press
// Also counts the image requests issued during the burst. Uses only DOM
// attributes that exist before and after the loupe rework, so the same script
// measures both.
const { launch } = require('./launch.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const RAW = /\.(arw|cr2|cr3|nef|nrw|dng|raf|orf|rw2|pef|srw)$/i;
async function main() {
  const source = process.argv[2], label = process.argv[3] || 'loupe-ui';
  if (!source) throw new Error('Usage: node scripts/loupe-timing.cjs RAW_FOLDER [LABEL]');
  const raws = (await fs.readdir(source)).filter(name => RAW.test(name)).sort();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-loupe-ui-'));
  let app;
  try {
    const photos = path.join(root, 'photos'); await fs.mkdir(photos);
    for (let i = 0; i < 8; i++) await fs.copyFile(path.join(source, raws[i % raws.length]), path.join(photos, `${String(i + 1).padStart(2, '0')}_${raws[i % raws.length]}`));
    app = await launch({ env: { ...process.env, PHOTOCULL_DATA_DIR: path.join(root, 'state') } });
    const page = await app.firstWindow();
    await page.locator('#empty-open').waitFor();
    const requests = [];
    page.on('request', request => { const match = /\/image\/[^/]+\/[^/]+\/(\w+)\?/.exec(request.url()); if (match) requests.push({ kind: match[1], prefetch: /prefetch=/.test(request.url()), cached: /cached=1/.test(request.url()), at: Date.now() }); });
    const shown = (kind, previous) => page.waitForFunction(([kind, previous]) => {
      const image = document.querySelector('#review-image');
      return image.dataset.complete === 'yes' && image.dataset.itemId !== previous && (!kind || image.dataset.stamp.includes(`:${kind}:`));
    }, [kind, previous], { timeout: 120000, polling: 'raf' });
    const current = () => page.locator('#review-image').evaluate(image => image.dataset.itemId);
    const time = async (action, kind, changes = true) => {
      const previous = changes ? await current() : '__none__';
      const start = Date.now(); await action(); await shown(kind, previous); return Date.now() - start;
    };
    const result = { label, measuredAt: new Date().toISOString(), files: 8, viewport: '1440×960 CSS px, devicePixelRatio 1' };
    result.firstMs = await time(() => page.evaluate(folder => window.loadTestFolder(folder), photos), null, false);
    await page.waitForTimeout(3000);
    result.nextMs = await time(() => page.keyboard.press('ArrowRight'), null);
    await page.waitForTimeout(3000);
    const box = await page.locator('#image-viewport').boundingBox();
    result.zoomMs = await time(() => page.mouse.click(box.x + box.width * .6, box.y + box.height * .45), 'full', false);
    await page.waitForTimeout(1500);
    result.zoomNextMs = await time(() => page.keyboard.press('ArrowRight'), null);
    result.zoomNextZoomed = await page.locator('#image-viewport').evaluate(node => node.classList.contains('zoomed'));
    if (result.zoomNextZoomed) await page.keyboard.press('Escape');
    await page.waitForTimeout(3000);
    const before = requests.length;
    const burstStart = await current();
    let last;
    result.burstMs = await (async () => {
      for (let i = 0; i < 4; i++) { await page.keyboard.press('ArrowRight'); if (i < 3) await page.waitForTimeout(60); }
      last = Date.now(); await shown(null, burstStart); return Date.now() - last;
    })();
    await page.waitForTimeout(1500);
    const burst = requests.slice(before);
    result.burstRequests = { total: burst.length, byKind: burst.reduce((n, r) => ({ ...n, [`${r.kind}${r.prefetch ? '(prefetch)' : r.cached ? '(cached probe)' : ''}`]: (n[`${r.kind}${r.prefetch ? '(prefetch)' : r.cached ? '(cached probe)' : ''}`] || 0) + 1 }), {}) };
    result.position = await page.locator('#image-position').textContent();
    await fs.mkdir('artifacts/performance', { recursive: true });
    await fs.writeFile(path.join('artifacts/performance', `${label}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (app) await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
