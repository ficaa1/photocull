// Run with Windows Node.js against the actual packaged application's modules.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

async function main() {
  assert.equal(process.platform, 'win32');
  const packaged = path.resolve(process.argv[2]);
  const sharp = require(path.join(packaged, 'node_modules', 'sharp'));
  const { Library } = require(path.join(packaged, 'src', 'library.cjs'));
  const { PreviewService } = require(path.join(packaged, 'src', 'previews.cjs'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photocull-win-smoke-'));
  const photos = path.join(root, 'photos');
  await fs.mkdir(photos);
  const previews = new PreviewService(path.join(root, 'cache'));
  try {
    await sharp({ create: { width: 1800, height: 1200, channels: 3, background: '#a0bf8a' } }).jpeg().toFile(path.join(photos, 'test.jpg'));
    let rawChecksum;
    if (process.argv[3]) {
      const rawFile = path.join(photos, 'camera.NEF');
      await fs.copyFile(process.argv[3], rawFile);
      rawChecksum = createHash('sha256').update(await fs.readFile(rawFile)).digest('hex');
    }
    const library = new Library(path.join(root, 'state'));
    const s = await library.scan(photos);
    for (const record of s.items) {
      const item = library.item(s.id, record.id);
      const bytes = await previews.get(item, 'preview', 100);
      const image = await sharp(bytes).metadata();
      assert.ok(image.width >= 1000);
      await library.decide(s.id, item.id, { flag: 'pick', rating: 4 });
      if (item.raw) {
        assert.match(previews.sourceInfo.get(item.id).source, /^Embedded /);
        assert.equal(createHash('sha256').update(await fs.readFile(item.path)).digest('hex'), rawChecksum);
      }
    }
    const result = await library.exportXmp(s.id);
    assert.equal(result.written, s.items.length); assert.equal(result.failures.length, 0);
    const reopened = await new Library(path.join(root, 'state')).scan(photos);
    assert.ok(reopened.items.every(i => i.flag === 'pick' && i.rating === 4));
    const report = { passed: true, platform: process.platform, node: process.version,
      checks: ['packaged native sharp', 'Windows JPEG preview', ...(rawChecksum ? ['Windows ExifTool embedded NEF preview', 'RAW source checksum unchanged'] : []), 'XMP sidecar export', 'saved decisions reopen'], images: s.items.length };
    console.log(JSON.stringify(report, null, 2));
  } finally { await previews.close(); await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
