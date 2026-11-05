// Backend timings for the loupe's representations on real RAWs:
//   node scripts/loupe-benchmark.cjs RAW_FOLDER [LABEL]
// Copies up to eight RAWs (cycling if there are fewer) into a temporary folder
// so the supplied files are only read, then measures with a cold preview cache:
// the fit preview, the zoom-size ("full") representation and a memory hit.
// Excludes browser decode and display; see scripts/loupe-timing.cjs for that.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { PreviewService } = require('../src/previews.cjs');
const { Library } = require('../src/library.cjs');

const RAW = /\.(arw|cr2|cr3|nef|nrw|dng|raf|orf|rw2|pef|srw)$/i;
const stats = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return { medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(1), maxMs: +sorted.at(-1).toFixed(1), runs: values.map(v => +v.toFixed(1)) };
};
async function main() {
  const source = process.argv[2];
  if (!source) throw new Error('Usage: node scripts/loupe-benchmark.cjs RAW_FOLDER [LABEL]');
  const label = process.argv[3] || 'loupe';
  const raws = (await fs.readdir(source)).filter(name => RAW.test(name)).sort();
  if (!raws.length) throw new Error('No RAW files found.');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-loupe-bench-'));
  const services = [];
  try {
    const photos = path.join(root, 'photos'); await fs.mkdir(photos);
    for (let i = 0; i < 8; i++) {
      const name = raws[i % raws.length];
      await fs.copyFile(path.join(source, name), path.join(photos, `${String(i + 1).padStart(2, '0')}_${name}`));
    }
    const library = new Library(path.join(root, 'state'));
    const session = await library.scan(photos);
    const items = session.items.map(i => library.item(session.id, i.id));
    const service = new PreviewService(path.join(root, 'cache')); services.push(service);
    const result = { preview: [], full: [], fullMemoryHit: [] };
    for (const item of items) {
      let t = performance.now(); await service.get(item, 'preview', 100); result.preview.push(performance.now() - t);
      t = performance.now(); const full = await service.get(item, 'full', 100); result.full.push(performance.now() - t);
      t = performance.now(); await service.get(item, 'full', 100); result.fullMemoryHit.push(performance.now() - t);
      result.fullBytes = full.length;
    }
    const report = { label, measuredAt: new Date().toISOString(), platform: `${process.platform} ${process.arch}`, node: process.version,
      files: items.length, note: 'Cold preview cache per file (each copy is a new identity); OS file cache warm after the copy.',
      preview: stats(result.preview), full: stats(result.full), fullMemoryHit: stats(result.fullMemoryHit), fullBytes: result.fullBytes,
      info: service.info(items[0], 'full'), stats: service.stats };
    await fs.mkdir('artifacts/performance', { recursive: true });
    await fs.writeFile(path.join('artifacts/performance', `${label}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await Promise.allSettled(services.map(s => s.close()));
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
