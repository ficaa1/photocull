const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { layout, cell } = require('./renderer/contact-sheet-layout.js');

const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const xml = value => String(value).replace(/[^\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, ' ').replace(/[&<>"']/g, c => entities[c]);

async function renderPage(items, g, page, pages, previews, signal, progress) {
  const { options: o, width, height, margin, font } = g;
  const kind = Math.max(g.cellWidth, g.imageHeight) > 2560 ? 'full' : 'preview';
  const dark = o.theme === 'dark', ink = dark ? '#f4f4f4' : '#242424';
  const layers = [], labels = [];
  const counter = 'Page ' + page + ' of ' + pages;
  const headerFont = Math.round(font * 1.6), right = width - margin;
  // Nested SVG viewports clip even unbroken Unicode filenames to the cell.
  function label(x, y, w, h, content, size = font) {
    labels.push(`<svg x="${x}" y="${y}" width="${w}" height="${h}" overflow="hidden"><text y="${size}" font-size="${size}">${content}</text></svg>`);
  }
  label(margin, margin, right - margin - counter.length * font, g.header, xml(o.headerTitle), headerFont);
  labels.push(`<text x="${right}" y="${margin + headerFont}" text-anchor="end" font-size="${font}">${counter}</text>`);
  for (const [index, item] of items.entries()) {
    signal.throwIfAborted();
    const { x, y } = cell(g, index);
    const source = await previews.get(item, kind, 100);
    signal.throwIfAborted();
    const thumb = await sharp(source).rotate().resize(g.cellWidth, g.imageHeight, { fit: 'inside' })
      .toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
    layers.push({ input: thumb.data, raw: { width: thumb.info.width, height: thumb.info.height, channels: thumb.info.channels },
      left: x + Math.floor((g.cellWidth - thumb.info.width) / 2), top: y + Math.floor((g.imageHeight - thumb.info.height) / 2) });
    const lines = [];
    if (o.captions.filename) lines.push(xml(item.name));
    if (o.captions.rating) {
      const color = item.sheetColor;
      const dot = color && /^#[\da-f]{6}$/i.test(color.hex) ? `<tspan fill="${color.hex}">●</tspan>` : '';
      lines.push([dot, '★'.repeat(item.rating || 0), item.flag === 'pick' ? 'Pick' : item.flag === 'reject' ? 'Reject' : ''].filter(Boolean).join('  '));
    }
    if (o.captions.exif) {
      const m = await previews.metadata(item);
      lines.push(xml([m.focalLength, m.aperture, m.shutter && m.shutter + ' s', m.iso && 'ISO ' + m.iso].filter(Boolean).join(' · ')));
    }
    lines.forEach((line, i) => label(x, y + g.imageHeight + i * g.line, g.cellWidth, g.line, line));
    progress(index + 1);
  }
  signal.throwIfAborted();
  layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="sans-serif" fill="${ink}">${labels.join('')}</svg>`), left: 0, top: 0 });
  return sharp({ create: { width, height, channels: 3, background: dark ? '#292929' : '#ffffff' } }).composite(layers)
    .withDensity(o.dpi).jpeg({ quality: o.jpegQuality, chromaSubsampling: '4:4:4' }).toBuffer();
}

async function writePdf(file, g, pages, render) {
  const handle = await fs.open(file, 'wx');
  const offsets = [0];
  let position = 0;
  async function write(data) {
    await handle.writeFile(data);
    position += Buffer.byteLength(data);
  }
  async function object(id, ...parts) {
    if (position > 9_999_999_999) throw new Error('The PDF exceeds the maximum size for a PDF 1.4 cross-reference table.');
    offsets[id] = position;
    await write(id + ' 0 obj\n');
    for (const part of parts) await write(part);
    await write('\nendobj\n');
  }
  try {
    await write(Buffer.from('%PDF-1.4\n%âãÏÓ\n', 'latin1'));
    await object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    const kids = Array.from({ length: pages }, (_, i) => (3 + i * 3) + ' 0 R').join(' ');
    await object(2, `<< /Type /Pages /Count ${pages} /Kids [${kids}] >>`);
    const w = +g.widthPt.toFixed(4), h = +g.heightPt.toFixed(4);
    for (let i = 0; i < pages; i++) {
      const id = 3 + i * 3, jpg = await render(i);
      await object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>`);
      await object(id + 1, `<< /Type /XObject /Subtype /Image /Width ${g.width} /Height ${g.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`, jpg, '\nendstream');
      const contents = `q\n${w} 0 0 ${h} 0 0 cm\n/Im Do\nQ\n`;
      await object(id + 2, `<< /Length ${contents.length} >>\nstream\n${contents}endstream`);
    }
    const start = position;
    await write(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
    await write(offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join(''));
    await write(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
  } finally { await handle.close(); }
}

async function exportContactSheet({ photos, options, file, previews, colors = [], metadata = {}, signal = new AbortController().signal, onProgress = () => {} }) {
  const g = layout(options), o = g.options;
  if (typeof file !== 'string' || !path.isAbsolute(file) || !(o.format === 'pdf' ? /\.pdf$/i : /\.jpe?g$/i).test(file))
    throw new Error('Choose a filename with the matching contact sheet extension.');
  const items = photos.filter(i => !i.trashed && (o.scope !== 'picks' || i.flag === 'pick')).map(i => ({
    ...i, develop: i.develop?.missing ? null : i.develop, sheetColor: colors.find(c => c.id === (i.color ?? metadata[i.flag + 'Color'])),
  }));
  if (!items.length) throw new Error('No photos in this scope.');
  const pages = Math.ceil(items.length / g.capacity), folder = path.dirname(file);
  const targets = o.format === 'pdf' || pages === 1 ? [file] : Array.from({ length: pages }, (_, i) =>
    path.join(folder, path.parse(file).name + '_p' + String(i + 1).padStart(Math.max(2, String(pages).length), '0') + '.jpg'));
  signal.throwIfAborted();
  const stage = await fs.mkdtemp(path.join(folder, '.photocull-sheet-'));
  const staged = i => path.join(stage, String(i));
  const reserved = [];
  const render = i => renderPage(items.slice(i * g.capacity, (i + 1) * g.capacity), g, i + 1, pages, previews, signal,
    n => onProgress({ done: i * g.capacity + n, total: items.length, page: i + 1, pages }));
  try {
    onProgress({ done: 0, total: items.length, page: 1, pages });
    if (o.format === 'pdf') await writePdf(staged(0), g, pages, render);
    else for (let i = 0; i < pages; i++) await fs.writeFile(staged(i), await render(i));
    // Reserve every sibling exclusively before publishing any page, including on FAT volumes.
    for (const target of targets) {
      signal.throwIfAborted();
      const handle = await fs.open(target, 'wx');
      reserved.push(target);
      await handle.close();
    }
    for (const [i, target] of targets.entries()) {
      signal.throwIfAborted();
      await fs.rename(staged(i), target);
    }
    return { folder, pages, photos: items.length, files: targets.length };
  } catch (e) {
    for (const target of reserved) await fs.unlink(target);
    if (e.code === 'EEXIST') throw new Error('A contact sheet filename already exists. Choose another name.');
    throw e;
  } finally { await fs.rm(stage, { recursive: true }); }
}
module.exports = { exportContactSheet };
