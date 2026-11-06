// Makes disposable variants only beneath the explicitly supplied test directory.
const fs = require('node:fs/promises');
const path = require('node:path');
const { ExifTool } = require('exiftool-vendored');
async function prepare(root) {
  root = path.resolve(root);
  const source = path.join(root, 'sample-01.ARW');
  const exif = new ExifTool();
  try {
    const tags = await exif.readRaw(source, { readArgs: ['-G1', '-s', '-PreviewImageStart', '-PreviewImageLength', '-JpgFromRawStart', '-JpgFromRawLength', '-StripOffsets', '-StripByteCounts', '-ThumbnailOffset', '-ThumbnailLength'] });
    const ranges = [['IFD0:PreviewImageStart', 'IFD0:PreviewImageLength'], ['IFD2:JpgFromRawStart', 'IFD2:JpgFromRawLength'], ['IFD1:ThumbnailOffset', 'IFD1:ThumbnailLength']].map(([a,b]) => [Number(tags[a]), Number(tags[b])]);
    const sensorStart = Number(tags['SubIFD:StripOffsets']), sensorLength = Number(tags['SubIFD:StripByteCounts']);
    if (!sensorStart || !sensorLength) throw new Error('Expected Sony sensor strip was not found; refusing to alter offsets.');
    const bytes = await fs.readFile(source);
    for (const [start, length] of ranges) {
      if (!start || !length || start + length > bytes.length || start < sensorStart + sensorLength && start + length > sensorStart) throw new Error('Unsafe preview range.');
    }
    const output = path.join(root, 'photocull-cases');
    await fs.mkdir(output, { recursive: true });
    for (const [name, remove] of [['raw-only', []], ['no-previews', ranges], ['small-preview', ranges.slice(0, 2)]]) {
      const folder = path.join(output, name); await fs.mkdir(folder, { recursive: true });
      const copy = Buffer.from(bytes);
      for (const [start, length] of remove) copy.fill(0, start, start + length);
      await fs.writeFile(path.join(folder, 'sample-01.ARW'), copy);
    }
    await fs.mkdir(path.join(output, 'corrupt'), { recursive: true });
    await fs.writeFile(path.join(output, 'corrupt', 'broken.ARW'), bytes.subarray(0, 1024));
    await fs.writeFile(path.join(output, 'preparation.json'), JSON.stringify({ source, ranges, sensorStart, sensorLength,
      method: 'Zero embedded JPEG payloads in copies, preserving TIFF metadata and the entire sensor strip.' }, null, 2));
    console.log(output);
    return output;
  } finally { await exif.end(); }
}
if (require.main === module) prepare(process.argv[2]).catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { prepare };
