// Windows: node scripts/preview-codec-bench.cjs RUST_PROBE_EXE SOURCE_FOLDER REPORT_FOLDER
// Copies 102 files from three RAW/JPEG pairs; no writes beneath SOURCE_FOLDER.
// The probe replaces only pixel encoding. Both paths keep the same selection, queues and cache.
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), { createInterface } = require('node:readline');
const { performance } = require('node:perf_hooks');
const { PreviewService } = require('../src/previews.cjs'), { Library } = require('../src/library.cjs');
const displayPreview = require('../src/display-preview.cjs');
class Probe {
  constructor(executable, root, index) {
    this.root = root; this.index = index; this.sequence = 0;
    this.child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    createInterface({ input: this.child.stdout }).on('line', line => {
      const pending = this.pending; this.pending = null;
      try { const result = JSON.parse(line); if (result.error) throw new Error(result.error); pending.resolve(result); }
      catch (error) { pending?.reject(error); }
    });
    const fail = error => { this.failure = error; this.pending?.reject(error); };
    this.child.on('error', fail); this.child.stdin.on('error', fail);
    this.child.on('close', code => { this.closed = true; fail(new Error(`Preview probe exited: ${code}`)); });
  }
  async encode(file, options) {
    if (this.failure) throw this.failure;
    assert.ok(!this.pending, 'Only one request per probe');
    const output = path.join(this.root, `${this.index}-${this.sequence++}.jpg`);
    await new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.child.stdin.write(JSON.stringify({ file, output, ...options, edge: options.edge || 100000 }) + '\n');
    });
    try { return await fs.readFile(output); } finally { await fs.rm(output, { force: true }); }
  }
  async close() {
    if (this.closed) return;
    const exited = new Promise(resolve => this.child.once('close', resolve));
    this.child.stdin.end(); await exited;
  }
}
async function main() {
  const [exe, source, reports] = process.argv.slice(2);
  assert.ok(exe && source && reports, 'Supply probe, source and report paths');
  await fs.mkdir(reports, { recursive: true });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-preview-parity-')), photos = path.join(root, 'photos');
  await fs.mkdir(photos);
  const names = ['sample-01', 'sample-02', 'sample-03'];
  for (let i = 0; i < 51; i++) for (const ext of ['ARW', 'JPG']) {
    await fs.copyFile(path.join(source, names[i % 3] + '.' + ext), path.join(photos, `${String(i).padStart(3, '0')}-${ext}.${ext}`));
  }
  const library = new Library(path.join(root, 'state')), session = await library.scan(photos);
  const items = session.items.map(i => library.item(session.id, i.id)); assert.equal(items.length, 102);
  const rows = [];
  const sharpEncode = displayPreview.encodeDisplayPreview;
  for (let repeat = 0; repeat < 2; repeat++) for (const kind of ['thumb', 'preview']) for (const mode of repeat ? ['rust', 'sharp'] : ['sharp', 'rust']) {
    const start = performance.now();
    const probes = mode === 'rust' ? [0, 1, 2].map(i => new Probe(exe, root, i)) : [];
    const available = [...probes];
    const encode = mode === 'rust' ? async (file, options) => {
      const probe = available.pop(); assert.ok(probe);
      try { return await probe.encode(file, options); } finally { available.push(probe); }
    } : undefined;
    displayPreview.encodeDisplayPreview = encode || sharpEncode;
    const service = new PreviewService(path.join(root, `${mode}-${kind}-${repeat}`));
    const completed = [], errors = [];
    try {
      await Promise.all(items.map(async item => {
        try { await service.get(item, kind, 100); completed.push(performance.now() - start); }
        catch (error) { errors.push({ name: item.name, error: error.message }); }
      }));
      const totalMs = performance.now() - start;
      const row = { mode, kind, repeat, images: completed.length, firstMs: completed[0], gridMs: completed.at(-1), totalMs, imagesPerSecond: completed.length / totalMs * 1000, errors, stats: service.stats };
      rows.push(row); console.log(JSON.stringify(row));
      await fs.writeFile(path.join(reports, 'preview-codecs.json'), JSON.stringify({ platform: process.platform, node: process.version, fixture: '102 distinct copies of 3 Sony A7C II RAW/JPEG pairs (51 RAW, 51 JPEG); warm OS filesystem, cold application caches; includes extraction, encoding, cache writes and Rust process startup; excludes scanning, HTTP and screen presentation', rows }, null, 2));
      assert.deepEqual(errors, []);
    } finally { displayPreview.encodeDisplayPreview = sharpEncode; await service.close(); await Promise.all(probes.map(p => p.close())); }
  }
  console.log(`Temporary copies and caches: ${root}`);
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { Probe };
