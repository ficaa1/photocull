const fs = require('node:fs');
const path = require('node:path');
const DEFAULT_DEHANCER = 'C:\\Program Files\\Dehancer Lightroom Plugin\\DehancerLightroom.exe';
const SPACES = ['srgb', 'displayP3', 'adobeRgb', 'proPhoto', 'rec2020'];
function dehancerPreset() {
  return { id: 'dehancer', name: 'Dehancer', path: fs.existsSync(DEFAULT_DEHANCER) ? DEFAULT_DEHANCER : '', args: ['{file}'],
    handoff: { format: 'tiff', bitDepth: 16, compression: 'none', colorSpace: 'srgb', jpegQuality: 90 }, detect: 'exit', multiple: false };
}
function normalizeEditors(input) {
  if (!Array.isArray(input) || !input.length || input.length > 50) throw new Error('Configure between 1 and 50 external editors.');
  const ids = new Set();
  const editors = input.map(e => {
    if (!e || !/^[a-zA-Z0-9_-]{1,80}$/.test(e.id) || ids.has(e.id)) throw new Error('Invalid or duplicate editor id.');
    ids.add(e.id);
    const text = (s, max) => typeof s === 'string' && s.length <= max && !/[\x00-\x1f]/.test(s);
    if (!text(e.name, 80) || !e.name.trim() || !text(e.path, 4096) || e.path && !path.isAbsolute(e.path) && !path.win32.isAbsolute(e.path)) throw new Error('Enter an editor name and absolute application path.');
    const args = e.args ?? ['{file}'];
    if (!Array.isArray(args) || args.length > 100 || args.some(a => !text(a, 4096) || /[{}]/.test(a.replaceAll('{file}', '').replaceAll('{files}', '')) || a.includes('{files}') && a !== '{files}')) throw new Error('Arguments must be an array of strings. Use {files} as a separate argument.');
    if (!args.some(a => a.includes('{file}') || a === '{files}')) throw new Error('Include {file} or {files} in editor arguments.');
    if (!['exit', 'watch'].includes(e.detect) || typeof e.multiple !== 'boolean' || e.multiple && (!args.includes('{files}') || args.some(a=>a.includes('{file}')))) throw new Error('Multi-file editors must use {files}; choose exit or watch detection.');
    const h = { ...dehancerPreset().handoff, ...e.handoff };
    if (!['tiff', 'png', 'jpeg'].includes(h.format) || ![8, 16].includes(h.bitDepth) || h.format === 'jpeg' && h.bitDepth !== 8 || !['none', 'lzw', 'deflate'].includes(h.compression) || !SPACES.includes(h.colorSpace) || !Number.isInteger(h.jpegQuality) || h.jpegQuality < 1 || h.jpegQuality > 100) throw new Error('Invalid hand-off format, depth, compression, color space or JPEG quality.');
    return { id: e.id, name: e.name.trim(), path: e.path.trim(), args: [...args], handoff: h, detect: e.detect, multiple: e.multiple };
  });
  if (!ids.has('dehancer')) throw new Error('The built-in Dehancer preset can be reset, but cannot be removed.');
  return editors;
}
async function testEditor(editor) {
  if (!editor?.path) throw new Error('Browse to the editor application first.');
  let file = editor.path;
  if (process.platform === 'darwin' && /\.app\/?$/i.test(file)) {
    const stat = await fs.promises.stat(path.join(file, 'Contents', 'Info.plist'));
    if (!stat.isFile()) throw new Error('Invalid application bundle.');
    return { ok: true, message: 'Application bundle found (launched with open -W).' };
  }
  const stat = await fs.promises.stat(file);
  if (!stat.isFile()) throw new Error('Choose an executable file.');
  if (process.platform === 'win32') { if (!/\.exe$/i.test(file)) throw new Error('Choose an .exe application; scripts require an interpreter configured as the application.'); }
  else await fs.promises.access(file, fs.constants.X_OK);
  return { ok: true, message: 'Application exists and is executable.' };
}
module.exports = { dehancerPreset, normalizeEditors, testEditor, SPACES };
