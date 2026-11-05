// Starts PhotoCull for UI smoke tests: the Node backend in browser mode
// (`src/backend.cjs --web`) and headless Chromium pointed at it. Playwright
// cannot drive the Tauri webviews (WebKitGTK, WKWebView), so the tests drive
// the same renderer and backend through Chromium instead.
//
// Returns the subset of Playwright's former Electron app object the scripts used:
// { firstWindow(), process(), close() }.
const { chromium } = require('playwright-core');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const CANDIDATES = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'];

async function launch({ env = process.env, viewport = { width: 1440, height: 960 }, timeout = 30000 } = {}) {
  // localStorage (pane layout, grid size) is per origin and per browser
  // profile. The desktop app's origin never changes, so relaunches against the
  // same data directory reuse one port and one profile to match.
  const dataDir = env.PHOTOCULL_DATA_DIR;
  const port = dataDir ? 20000 + createHash('sha256').update(path.resolve(dataDir)).digest().readUInt16BE(0) % 20000 : 0;
  const backend = spawn(process.execPath, [path.join(root, 'src', 'backend.cjs'), '--web', '--port', String(port)], { env: { ...env, PHOTOCULL_SMOKE_TEST: '1' }, stdio: ['pipe', 'ignore', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Backend did not start:\n${output}`)), timeout);
    backend.stderr.on('data', chunk => {
      output += chunk;
      const match = /PhotoCull web UI: (\S+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    backend.once('exit', code => { clearTimeout(timer); reject(new Error(`Backend exited (${code}):\n${output}`)); });
  });
  const executablePath = process.env.CHROMIUM_PATH || CANDIDATES.find(file => existsSync(file));
  const options = { executablePath, headless: true, args: ['--disable-gpu'], viewport };
  const browser = dataDir ? await chromium.launchPersistentContext(path.join(dataDir, 'browser-profile'), options) : await chromium.launch(options);
  const page = dataDir ? browser.pages()[0] || await browser.newPage() : await browser.newPage({ viewport });
  // Native prompts stand in for dialogs in browser mode; tests never need them.
  page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
  await page.goto(url);
  return {
    firstWindow: async () => page,
    process: () => backend,
    close: async () => {
      await browser.close().catch(() => {});
      if (backend.exitCode === null) {
        const exited = new Promise(resolve => backend.once('exit', resolve));
        backend.kill('SIGTERM');
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 10000))]);
      }
    },
  };
}

module.exports = { launch };
