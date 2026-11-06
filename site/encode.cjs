// node site/encode.cjs CAPTURE_FOLDER
// Encodes the screenshots the page uses from site/capture.cjs output into site/img/:
// AVIF and WebP at two widths, plus the social preview JPEG.
const path = require('node:path'), fs = require('node:fs/promises');
const sharp = require('sharp');
const input = process.argv[2], out = path.join(__dirname, 'img');
if (!input) { console.error('usage: node site/encode.cjs CAPTURE_FOLDER'); process.exit(2); }
// Full windows are 2880 px wide (1440 CSS px at 2×); dialog crops come at half and full capture size.
const windows = ['review-dusk', 'grid', 'focus', 'compare', 'develop'], dialogs = ['backup-dialog', 'editors-dialog', 'export-dialog', 'palette-dialog'];
(async () => {
  await fs.mkdir(out, { recursive: true });
  const shots = Object.fromEntries(windows.map(name => [name, [1280, 2400]]));
  for (const name of dialogs) { const { width } = await sharp(path.join(input, name + '.png')).metadata(); shots[name] = [Math.round(width / 2), width]; }
  for (const [name, widths] of Object.entries(shots)) for (const width of widths) {
    const image = () => sharp(path.join(input, name + '.png')).resize({ width });
    await image().avif({ quality: 52, effort: 6 }).toFile(path.join(out, `${name}-${width}.avif`));
    await image().webp({ quality: 80, effort: 6 }).toFile(path.join(out, `${name}-${width}.webp`));
    const { height } = await sharp(path.join(out, `${name}-${width}.webp`)).metadata();
    console.log(name, width, height);
  }
  // Phones get the photo and decision bar from the Review window, without the side panes.
  const phone = () => sharp(path.join(input, 'review-dusk.png')).extract({ left: 480, top: 0, width: 1840, height: 1800 }).resize({ width: 960 });
  await phone().avif({ quality: 52, effort: 6 }).toFile(path.join(out, 'review-dusk-phone-960.avif'));
  await phone().webp({ quality: 80, effort: 6 }).toFile(path.join(out, 'review-dusk-phone-960.webp'));
  await sharp(path.join(input, 'review-dusk.png')).resize(1200, 630, { fit: 'cover', position: 'top' }).jpeg({ quality: 82, mozjpeg: true }).toFile(path.join(out, 'social.jpg'));
})().catch(e => { console.error(e); process.exitCode = 1; });
