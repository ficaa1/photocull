// Read-only preflight. Only a photo's recorded TIFF may be reused; every other name is reserved.
const fs = require('node:fs/promises');
const path = require('node:path');
const key = file => path.resolve(file).toLowerCase();
async function planTiffs(items, folder, protectedItems = items) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Choose a TIFF folder.');
  const reserved = new Set(), rows = [];
  const diskNames = new Set((await fs.readdir(folder).catch(e=>{if(e.code!=='ENOENT')throw e;return [];})).map(n=>n.toLowerCase()));
  const protectedPaths = new Set(protectedItems.flatMap(i => [i.path, i.companion]).filter(Boolean).map(key));
  for (const item of items) {
    const row = { id: item.id, name: item.name };
    if (!item.raw) { rows.push({ ...row, error: 'Only RAW photos can be developed.' }); continue; }
    const own = item.develop?.tiff;
    const reuse = own && key(path.dirname(own)) === key(folder) && !protectedItems.some(i => i.id !== item.id && i.develop?.tiff && key(i.develop.tiff) === key(own));
    let n = 1;
    try {
      for (;;) {
        const tiff = reuse ? own : path.join(folder, `${path.parse(item.name).name}${n === 1 ? '' : `-${n}`}.tif`);
        const k = key(tiff);
        const stat = await fs.lstat(tiff).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
        if (reuse) {
          if (reserved.has(k) || protectedPaths.has(k) || stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('The destination is not a regular, unshared TIFF.');
        } else if (stat || diskNames.has(path.basename(tiff).toLowerCase()) || reserved.has(k) || protectedPaths.has(k)) { n++; continue; }
        reserved.add(k);
        rows.push({ ...row, tiff, exists: !!stat, edited: !!stat && !!item.develop?.edited, own: !!reuse });
        break;
      }
    } catch (error) { rows.push({ ...row, error: error.message }); }
  }
  return rows;
}
async function writableFolder(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return false;
  const probe = path.join(folder, `.photocull-write-${require('node:crypto').randomUUID()}`);
  try { const file = await fs.open(probe, 'wx'); await file.close(); await fs.unlink(probe); return true; } catch { return false; }
}
module.exports = { planTiffs, writableFolder };
