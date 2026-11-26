const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { photoPaths } = require('./library.cjs');
const path = require('node:path');
const sharp = require('sharp');
const { layout, cell, ratingText, exifText } = require('./renderer/contact-sheet-layout.js');

const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const xml = value => String(value).replace(/[^\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, ' ').replace(/[&<>"']/g, c => entities[c]);

async function renderPage(items, g, page, pages, previews, signal, warnings, progress) {
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
    try {
      const source = await previews.getForPresentation(item, kind);
      signal.throwIfAborted();
      const thumb = await sharp(source).rotate().resize(g.cellWidth, g.imageHeight, { fit: 'inside' })
        .toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
      layers.push({ input: thumb.data, raw: { width: thumb.info.width, height: thumb.info.height, channels: thumb.info.channels },
        left: x + Math.floor((g.cellWidth - thumb.info.width) / 2), top: y + Math.floor((g.imageHeight - thumb.info.height) / 2) });
    } catch (error) {
      signal.throwIfAborted();
      warnings.push({ filename: item.name, kind: 'preview', message: error.message });
      labels.push(`<rect x="${x}" y="${y}" width="${g.cellWidth}" height="${g.imageHeight}" fill="${dark ? '#383838' : '#ededed'}"/>`);
      const message = o.captions.filename ? ['Preview unavailable'] : ['Preview unavailable', xml(item.name)];
      const lineHeight = Math.min(g.line, Math.floor(g.imageHeight / message.length));
      const top = y + Math.floor((g.imageHeight - lineHeight * message.length) / 2);
      message.forEach((text, i) => label(x, top + i * lineHeight, g.cellWidth, lineHeight, text, Math.min(font, lineHeight * .8)));
    }
    const lines = [];
    if (o.captions.filename) lines.push(xml(item.name));
    if (o.captions.rating) {
      const color = item.sheetColor;
      const dot = color && /^#[\da-f]{6}$/i.test(color.hex) ? `<tspan fill="${color.hex}">●</tspan>` : '';
      lines.push([dot, ratingText(item)].filter(Boolean).join('  '));
    }
    if (o.captions.exif) {
      try { lines.push(xml(exifText(await previews.metadata(item)))); }
      catch (error) {
        signal.throwIfAborted();
        warnings.push({ filename: item.name, kind: 'metadata', message: error.message });
        lines.push('EXIF unavailable');
      }
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

async function protectSources(targets, protectedPaths) {
  const names = new Set(targets.map(file => path.basename(file).toLowerCase()));
  const folder = path.dirname(targets[0]).toLowerCase();
  for (const file of protectedPaths) {
    if (!names.has(path.basename(file).toLowerCase())) continue;
    const parent = await fs.realpath(path.dirname(file)).catch(error => {
      if (error.code === 'ENOENT') return path.dirname(file);
      throw error;
    });
    if (parent.toLowerCase() === folder) throw new Error('A contact sheet would replace a source photo. Choose another name.');
  }
}

async function publish(staged, target, created, signal) {
  const stamp = await fs.stat(staged, { bigint: true });
  try {
    await fs.link(staged, target);
    created.set(target, stamp);
    return;
  } catch (error) {
    if (!['EPERM', 'EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL'].includes(error.code)) throw error;
  }
  // FAT volumes lack hard links. Keep writing through the exclusively opened handle.
  const output = await fs.open(target, 'wx');
  try {
    created.set(target, await output.stat({ bigint: true }));
    for await (const chunk of createReadStream(staged, { signal })) await output.writeFile(chunk);
    await output.sync();
  } finally { await output.close(); }
}

async function rollback(created) {
  const failures = [];
  for (const [file, stamp] of created) {
    try {
      const current = await fs.lstat(file, { bigint: true });
      if (!stamp.ino) failures.push(file);
      else if (current.isFile() && current.dev === stamp.dev && current.ino === stamp.ino && current.birthtimeNs === stamp.birthtimeNs) await fs.unlink(file);
    } catch (e) { if (e.code !== 'ENOENT') failures.push(file); }
  }
  return failures;
}

async function exportContactSheet({ photos, options, file, previews, colors = [], metadata = {}, protectedPaths = photoPaths(photos), isCard, signal = new AbortController().signal, onProgress = () => {} }) {
  const g = layout(options), o = g.options;
  if (typeof file !== 'string' || !path.isAbsolute(file) || !(o.format === 'pdf' ? /\.pdf$/i : /\.jpe?g$/i).test(file))
    throw new Error('Choose a filename with the matching contact sheet extension.');
  const items = photos.filter(i => !i.trashed && (o.scope !== 'picks' || i.flag === 'pick')).map(i => ({
    ...i, develop: i.develop?.missing ? null : i.develop, sheetColor: colors.find(c => c.id === (i.color ?? metadata[i.flag + 'Color'])),
  }));
  if (!items.length) throw new Error('No photos in this scope.');
  const pages = Math.ceil(items.length / g.capacity), folder = await fs.realpath(path.dirname(file));
  if (await isCard?.(folder)) throw new Error('Choose a contact sheet destination outside the camera card.');
  file = path.join(folder, path.basename(file));
  const targets = o.format === 'pdf' || pages === 1 ? [file] : Array.from({ length: pages }, (_, i) =>
    path.join(folder, path.parse(file).name + '_p' + String(i + 1).padStart(Math.max(2, String(pages).length), '0') + '.jpg'));
  await protectSources([file, ...targets], protectedPaths);
  signal.throwIfAborted();
  const stage = await fs.mkdtemp(path.join(folder, '.photocull-sheet-'));
  const staged = i => path.join(stage, String(i));
  const created = new Map(), warnings = [];
  const render = i => renderPage(items.slice(i * g.capacity, (i + 1) * g.capacity), g, i + 1, pages, previews, signal, warnings,
    n => onProgress({ done: i * g.capacity + n, total: items.length, page: i + 1, pages }));
  try {
    try {
      onProgress({ done: 0, total: items.length, page: 1, pages });
      if (o.format === 'pdf') await writePdf(staged(0), g, pages, render);
      else for (let i = 0; i < pages; i++) await fs.writeFile(staged(i), await render(i));
      signal.throwIfAborted();
      const unavailable = warnings.filter(w => w.kind === 'preview');
      if (unavailable.length === items.length) throw new Error('No previews available: ' + unavailable.map(w => w.filename).join(', '));
      for (const [i, target] of targets.entries()) {
        signal.throwIfAborted();
        await publish(staged(i), target, created, signal);
      }
    } finally { await fs.rm(stage, { recursive: true }); }
    signal.throwIfAborted();
    return { folder, pages, photos: items.length, files: targets.length, warnings };
  } catch (error) {
    const failures = await rollback(created);
    if (failures.length) throw new Error(error.message + '. Could not remove: ' + failures.join(', '));
    signal.throwIfAborted();
    if (error.code === 'EEXIST') throw new Error('A contact sheet filename already exists. Choose another name.');
    throw error;
  }
}
module.exports = { exportContactSheet };
