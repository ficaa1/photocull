// Read-only preflight for RAW-to-TIFF handoff. Matches Rust's stem + .tif naming.
const fs = require('node:fs/promises');
const path = require('node:path');
async function planTiffs(items, folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Choose a TIFF folder.');
  const counts = new Map();
  const rows = items.map(item => {
    const tiff = path.join(folder, `${path.parse(item.name).name}.tif`), key = tiff.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
    return { id: item.id, name: item.name, tiff, raw: item.raw, source: item.path, key };
  });
  return Promise.all(rows.map(async ({ raw, source, key, ...row }) => {
    if (!raw) return { ...row, error: 'Only RAW photos can be developed.' };
    if (counts.get(key) > 1) return { ...row, error: 'Two photos would have the same TIFF name. Send them to separate folders.' };
    if (source && path.resolve(source).toLowerCase() === key) return { ...row, error: 'The TIFF cannot replace a source photo.' };
    try {
      const stat = await fs.lstat(row.tiff);
      return stat.isFile() && !stat.isSymbolicLink() ? { ...row, exists: true } : { ...row, error: 'The destination is not a regular file.' };
    } catch (error) {
      if (error.code !== 'ENOENT') return { ...row, error: error.message };
      return { ...row, exists: false };
    }
  }));
}
module.exports = { planTiffs };
