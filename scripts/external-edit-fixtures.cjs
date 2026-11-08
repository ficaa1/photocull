const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { ExifTool } = require('exiftool-vendored');
const { Library } = require('../src/library.cjs');
const { SettingsStore } = require('../src/settings.cjs');

async function externalEditFixtures(root, count = 3) {
  const data = path.join(root, 'data'), card = path.join(root, 'card'), photos = path.join(root, 'nas'), edits = path.join(root, 'edits');
  const originals = path.join(card, 'DCIM', '100MSDCF');
  await Promise.all([originals, photos, edits].map(dir => fs.mkdir(dir, { recursive: true })));
  const files = [];
  const exif = new ExifTool({ maxProcs: 1 });
  try {
    for (let n = 0; n < count; n++) {
      const name = `DSC${String(n + 1).padStart(3, '0')}`, file = path.join(edits, `result-${n + 1}.tif`);
      const buffer = await sharp({ create: { width: 120, height: 80, channels: 3, background: { r: (60 + n * 20) % 256, g: 100, b: 140 } } })
        .tiff().toBuffer();
      await fs.writeFile(file, buffer);
      await exif.write(file, { Make: 'Fixture', Model: 'Synthetic camera', Software: 'Dehancer', DateTimeOriginal: `2026:09:26 11:${String(30 + n).padStart(2, '0')}:40`, SubSecTimeOriginal: '029', OffsetTimeOriginal: '+02:00', LensModel: 'Synthetic lens' }, ['-overwrite_original']);
      await fs.copyFile(file, path.join(originals, name + '.ARW'));
      await sharp(buffer).jpeg().toFile(path.join(originals, name + '.JPG'));
      await fs.utimes(path.join(originals, name + '.ARW'), 1700000000 + n, 1700000000 + n);
      files.push({ name, file, original: path.join(originals, name + '.ARW') });
    }
  } finally { await exif.end(); }
  const settings = new SettingsStore(data); await settings.init(); await settings.update({ handoffFolder: edits });
  const library = new Library(data), session = await library.scan(card, true, { removable: true });
  for (const f of files) {
    const id = session.items.find(i => i.name === f.name + '.ARW').id;
    await library.developMark(session.id, id, { tiff: f.file, editedBy: 'dehancer' });
    for (const extension of ['.ARW', '.JPG']) await fs.copyFile(path.join(originals, f.name + extension), path.join(photos, f.name + extension));
    await fs.utimes(path.join(photos, f.name + '.ARW'), 1699996400, 1699996400);
  }
  const nas = await library.scan(photos);
  await library.developMark(nas.id, nas.items.find(i => i.name === 'DSC003.ARW').id, { tiff: files[2].file, editedBy: 'dehancer' });
  await library.close();
  return { data, card, photos, edits, files, settings: settings.value };
}

module.exports = { externalEditFixtures };
