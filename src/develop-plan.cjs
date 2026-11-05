// Read-only preflight. Only a photo's recorded hand-off may be reused; every other name is reserved.
const fs = require('node:fs/promises');
const path = require('node:path');
const key = file => path.resolve(file).toLowerCase();
async function planTiffs(items, folder, protectedItems = items, extension = 'tif') {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Choose a hand-off folder.');
  if (!['tif', 'png', 'jpg'].includes(extension)) throw new Error('Invalid hand-off extension.');
  const reserved = new Set(), rows = [];
  const diskNames = new Set((await fs.readdir(folder).catch(e=>{if(e.code!=='ENOENT')throw e;return [];})).map(n=>n.toLowerCase()));
  const protectedPaths = new Set(protectedItems.flatMap(i => [i.path, i.companion, ...(i.develop?.handoffs || []).map(r => r.path).filter(p => p !== i.develop?.tiff)]).filter(Boolean).map(key));
  const handoffs = new Set(protectedItems.flatMap(i => [i.develop?.tiff, ...(i.develop?.handoffs || []).map(r=>r.path)]).filter(Boolean).map(key));
  for (const item of items) {
    const row = { id: item.id, name: item.name };
    if (!item.raw) { rows.push({ ...row, error: 'Only RAW photos can be developed.' }); continue; }
    const own = item.develop?.tiff;
    const reuse = own && path.extname(own).toLowerCase() === `.${extension}` && key(path.dirname(own)) === key(folder) && !protectedItems.some(i => i.id !== item.id && (i.develop?.handoffs || [{path:i.develop?.tiff}]).some(r => r.path && key(r.path) === key(own)));
    let n = 1;
    try {
      for (;;) {
        const tiff = reuse ? own : path.join(folder, `${path.parse(item.name).name}${n === 1 ? '' : `-${n}`}.${extension}`);
        const k = key(tiff);
        const stat = await fs.lstat(tiff).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
        if (reuse) {
          if (reserved.has(k) || protectedPaths.has(k) || stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('The destination is not a regular, unshared hand-off file.');
        } else if (handoffs.has(k) || stat || diskNames.has(path.basename(tiff).toLowerCase()) || reserved.has(k) || protectedPaths.has(k)) { n++; continue; }
        reserved.add(k);
        rows.push({ ...row, tiff, exists: !!stat, edited: !!stat && !!(item.develop?.editedBy || item.develop?.edited), own: !!reuse });
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
