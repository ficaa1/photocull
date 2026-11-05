// Run after image-export-windows.cjs, in the isolated Windows checkout.
// Native codecs decode JPEG/JXL/TIFF/PNG/WebP; sharp/libheif decodes AVIF (Lightcraft cannot).
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { promisify } = require('node:util'), { execFile } = require('node:child_process');
const assert = require('node:assert/strict'), sharp = require('sharp');
async function main() {
  const reports = path.resolve(process.argv[2] || 'artifacts/image-export-windows');
  const report = JSON.parse(await fs.readFile(path.join(reports, 'results.json'), 'utf8'));
  const previews = path.join(reports, 'previews'); await fs.mkdir(previews, { recursive: true });
  const cargo = process.platform === 'win32' ? path.join(os.homedir(), '.cargo/bin/cargo.exe') : 'cargo';
  const native = await promisify(execFile)(cargo, ['run', '--manifest-path', 'src-tauri/Cargo.toml', '--example', 'export_readback', '--', report.output, previews], { maxBuffer: 10 * 1024 * 1024, timeout: 240000 });
  await fs.writeFile(path.join(reports, 'readback.jsonl'), native.stdout);
  const rows = native.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  for (const r of report.results.filter(r => r.dest?.endsWith('.avif'))) {
    const m = await sharp(r.dest).metadata();
    await sharp(r.dest).resize({ width: 400, height: 300, fit: 'inside' }).jpeg({ quality: 90 }).toFile(path.join(previews, path.basename(r.dest) + '.jpg'));
    const row = rows.find(row => row.file === path.basename(r.dest));
    Object.assign(row, { width: m.width, height: m.height, bitDepth: m.bitsPerSample || Number(r.tags.ImagePixelDepth.split(' ')[0]), iccBytes: m.icc?.length || 0, externalDecoder: 'sharp/libheif' });
    delete row.decoderError;
  }
  for (const r of report.results.filter(r => r.case !== 'ui-raw-batch' && !r.case.startsWith('metadata-'))) {
    const row = rows.find(row => row.file === path.basename(r.dest)); assert.ok(row && !row.decoderError, r.case);
    const expected = r.case.includes('1200') ? [1200, 800] : r.case.startsWith('edited') ? [7028, 4688] : [7008, 4672];
    assert.deepEqual([row.width, row.height], expected, r.case);
    assert.equal(row.bitDepth, r.options.bitDepth, r.case);
    assert.equal(r.tags.Title, 'Export verification', r.case);
    assert.deepEqual(r.tags.Subject, ['PhotoCull', 'export-test'], r.case);
    assert.equal(r.tags.Model, 'ILCE-7CM2', r.case);
    assert.equal(r.tags.LensModel, 'FE 40mm F2.5 G', r.case);
    assert.ok(r.tags.Artist === 'PhotoCull Export Test' || r.tags.Creator === 'PhotoCull Export Test', r.case);
    assert.equal(r.tags.Copyright, 'Copyright PhotoCull Export Test', r.case);
  }
  for (const policy of ['allExceptCamera', 'copyright', 'none']) {
    const r = report.results.find(r => r.case === 'metadata-' + policy); assert.ok(r);
    assert.equal(r.tags.Model, undefined); assert.equal(r.tags.LensModel, undefined); assert.equal(r.tags.GPSPosition, undefined);
    assert.equal(r.tags.ProfileDescription, 'Display P3'); assert.ok(r.bytes <= 100 * 1024);
    if (policy !== 'allExceptCamera') { assert.equal(r.tags.Title, undefined); assert.equal(r.tags.Subject, undefined); }
    if (policy === 'none') { assert.equal(r.tags.Artist, undefined); assert.equal(r.tags.Copyright, undefined); }
  }
  await fs.writeFile(path.join(reports, 'decoded.json'), JSON.stringify(rows, null, 2));
  const cases = report.results.filter(r => /^(edited|raw)-(full|1200-screen)-/.test(r.case));
  const width = 280, height = 228, layers = [];
  for (const [i, r] of cases.entries()) {
    const left = i % 7 * width, top = Math.floor(i / 7) * height;
    layers.push({ input: await sharp(path.join(previews, path.basename(r.dest) + '.jpg')).resize(270, 190, { fit: 'contain', background: '#192026' }).toBuffer(), left: left + 5, top: top + 3 });
    layers.push({ input: Buffer.from(`<svg width="280" height="35"><text x="8" y="18" fill="#dde7ee" font-family="Arial,sans-serif" font-size="11">${r.case}</text></svg>`), left, top: top + 194 });
  }
  await sharp({ create: { width: width * 7, height: height * 4, channels: 3, background: '#192026' } }).composite(layers).png().toFile(path.join(reports, 'contact-sheet.png'));
  console.log('PASS output readback: 28 images decoded; dimensions, bit depth, camera/lens, creator/copyright, title/keywords and metadata policies verified.');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
