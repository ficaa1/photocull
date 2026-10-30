const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { PreviewService } = require('../src/previews.cjs');
const { Library } = require('../src/library.cjs');
const { fixtures } = require('./fixtures.cjs');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-bench-'));
  let service, fresh;
  try {
    const supplied = process.argv[2];
    const photos = supplied ? path.resolve(supplied) : await fixtures(path.join(root, 'photos'), 48);
    const library = new Library(path.join(root, 'state'));
    const start = performance.now(), session = await library.scan(photos);
    const scanMs = performance.now() - start;
    const items = session.items.slice(0, 48).map(i => library.item(session.id, i.id));
    const cache = path.join(root, 'cache'); service = new PreviewService(cache);
    const measure = async (engine, kind) => {
      const values = [], failures = [];
      for (const item of items) {
        const t = performance.now();
        try { await engine.get(item, kind, 100); values.push(performance.now() - t); }
        catch (e) { failures.push({ file: item.name, error: e.message }); }
      }
      const sorted = values.toSorted((a, b) => a - b);
      return { images: sorted.length, totalMs: +values.reduce((a, b) => a + b, 0).toFixed(2),
        medianMs: sorted.length ? +sorted[Math.floor(sorted.length / 2)].toFixed(2) : null,
        p95Ms: sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))].toFixed(2) : null, failures };
    };
    const cold = await measure(service, 'preview');
    const memory = await measure(service, 'preview');
    fresh = new PreviewService(cache);
    const disk = await measure(fresh, 'preview');
    const report = { measuredAt: new Date().toISOString(), platform: `${process.platform} ${process.arch}`, node: process.version,
      dataset: supplied ? photos : '48 generated 1800 × 1200 JPEGs (one EXIF-rotated)', note: 'Backend cache/decode measurements. Excludes GPU display, network, and Photo Mechanic; these are not a comparison with Photo Mechanic.',
      discovered: session.items.length, scanMs: +scanMs.toFixed(2), cold, memory, disk };
    await fs.mkdir('artifacts', { recursive: true });
    await fs.writeFile('artifacts/benchmark.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await Promise.allSettled([service?.close(), fresh?.close()]);
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
