const path = require('node:path');
const { ExifTool } = require('exiftool-vendored');
const { normalizeSettings } = require('./preferences.cjs');
class MetadataWriter {
  constructor({ exif } = {}) { this.exif = exif; }
  async write(file, item, settings, signal) {
    if (signal?.aborted) throw new Error('Copy canceled.');
    const config = normalizeSettings(settings), metadata = config.metadata, tags = {};
    const tiff = ['.arw','.dng','.nef','.nrw','.cr2','.tif','.tiff','.jpg','.jpeg'].includes(path.extname(file).toLowerCase());
    if (metadata.creator) {
      tags['XMP-dc:Creator'] = [metadata.creator];
      if (tiff) { tags['IFD0:Artist'] = metadata.creator; tags['IFD0:XPAuthor'] = metadata.creator; }
    }
    if (metadata.copyright) { tags['XMP-dc:Rights'] = metadata.copyright; if(tiff) tags['IFD0:Copyright'] = metadata.copyright; }
    if (metadata.title) { tags['XMP-dc:Title'] = metadata.title; if(tiff) tags['IFD0:XPTitle'] = metadata.title; }
    if (metadata.caption) { tags['XMP-dc:Description'] = metadata.caption; if(tiff) tags['IFD0:XPComment'] = metadata.caption; }
    if (metadata.writeRatings) {
      const rating = item.flag === 'reject' && metadata.rejectRating ? -1 : item.rating;
      tags['XMP-xmp:Rating'] = rating;
      if (tiff) { tags['IFD0:Rating'] = Math.max(0,rating); tags['IFD0:RatingPercent'] = [0,1,25,50,75,99][Math.max(0,rating)]; }
    }
    if (metadata.writeLabels) {
      const id = item.color ?? metadata[item.flag + 'Color'];
      if (item.color !== null && item.color !== undefined || item.flag !== 'none') tags['XMP-xmp:Label'] = config.colors.find(c => c.id === id)?.label || '';
    }
    if (!Object.keys(tags).length && !metadata.keywords.length) return;
    this.exif ||= new ExifTool({ maxProcs: 1, taskTimeoutMillis: 30000 });
    if (metadata.keywords.length) {
      const old = await this.exif.readRaw(file, { readArgs: ['-XMP-dc:Subject', '-IFD0:XPKeywords'] });
      const existing = typeof old.Subject === 'string' ? [old.Subject] : Array.isArray(old.Subject) ? old.Subject : [];
      tags['XMP-dc:Subject'] = [...new Set([...existing, ...metadata.keywords])];
      if(tiff) tags['IFD0:XPKeywords'] = [...new Set([...(String(old.XPKeywords || '').split(';').filter(Boolean)), ...metadata.keywords])].join(';');
    }
    const result = await this.exif.write(file, tags, ['-overwrite_original']);
    if (result.warnings?.length) throw new Error(result.warnings.join('; '));
    // Read back the author after a write rather than silently exporting bad metadata.
    if (metadata.creator) {
      const actual = await this.exif.readRaw(file,{readArgs:['-XMP-dc:Creator', ...(tiff ? ['-IFD0:Artist'] : [])]});
      const creator = Array.isArray(actual.Creator) ? actual.Creator[0] : actual.Creator;
      if (creator !== metadata.creator || tiff && actual.Artist !== metadata.creator) throw new Error('Could not verify creator metadata in the copied image.');
    }
  }
  async close() { await this.exif?.end(); }
}
module.exports = { MetadataWriter };
