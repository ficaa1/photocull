const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { normalizeSettings } = require('./preferences.cjs');
const { renderName, needsCapture } = require('./renderer/naming.js');
const { MetadataWriter } = require('./metadata-writer.cjs');
const { updateXmp } = require('./xmp.cjs');

const canceled = () => Object.assign(new Error('Copy canceled. Completed images are kept.'), { code: 'CANCELED' });
const inside = (parent, file) => { const relative = path.relative(parent, file); return relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
async function sourceStat(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Source must be a regular file.');
  return stat;
}
async function parentDirectory(root, relative) {
  let current = root;
  for (const part of path.dirname(relative).split(path.sep).filter(p => p !== '.')) {
    current = path.join(current, part);
    try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Destination subfolders must be regular directories.');
  }
}
async function existing(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

class TransferService {
  constructor({ onProgress = () => {}, captureDate = async () => null, recipeSettings = () => null, metadataWriter } = {}) { this.recipeSettings = recipeSettings; this.onProgress = onProgress; this.captureDate = captureDate; this.active = null; this.metadataWriter = metadataWriter || new MetadataWriter(); }
  async copy(session, destination, { includeJpeg = false, includeXmp = false, metadataSettings, naming, folders, embedMetadata = false, verify = false } = {}) {
    if (this.active) throw new Error('Another copy is already running.');
    const validated = normalizeSettings({ naming: naming || {}, folders: folders || {} });
    naming = validated.naming; folders = validated.folders;
    const controller = new AbortController();
    const operation = { id: randomUUID(), controller }; this.active = operation;
    const work = this.run(operation, session, destination, { includeJpeg: includeJpeg === true, includeXmp: includeXmp === true, metadataSettings, naming, folders, embedMetadata: embedMetadata === true, verify: verify === true });
    operation.work = work;
    try { return await work; } finally { if (this.active === operation) this.active = null; }
  }
  cancel() { this.active?.controller.abort(); }
  async close() { this.cancel(); await this.active?.work?.catch(() => {}); await this.metadataWriter.close(); }
  async run(operation, session, destination, options) {
    // Capture decisions before any filesystem or destination-dialog delays.
    const picks = session.items.filter(i => i.flag === 'pick' && !i.trashed).map(i => ({ ...i }));
    if (!picks.length) throw new Error('Pick at least one photo before copying.');
    const signal = operation.controller.signal;
    const root = await fs.realpath(destination), sourceRoot = await fs.realpath(session.folder);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('Choose a destination folder.');
    if (inside(sourceRoot, root)) throw new Error('Choose a destination outside the source folder.');
    const progress = { id: operation.id, destination: options.folders.mode === 'named' ? path.join(root, options.folders.name) : root, state: 'planning', total: picks.length, completed: 0, copied: 0,
      copiedFiles: 0, skipped: [], failures: [], bytesCopied: 0, totalBytes: 0, file: '' };
    let lastEvent = 0;
    const emit = force => { const now = Date.now(); if (force || now - lastEvent >= 120) { lastEvent = now; this.onProgress({ ...progress, skipped: [...progress.skipped], failures: [...progress.failures] }); } };
    emit(true);
    const groups = [], targets = new Map(), now = new Date();
    for (const [index, item] of picks.entries()) {
      if (signal.aborted) break;
      try {
        const stat = await sourceStat(item.path), sourcePath = await fs.realpath(item.path);
        const originalRelative = path.relative(sourceRoot, sourcePath);
        const captured = needsCapture(options.naming.template) ? await this.captureDate(item) : null;
        const renamed = renderName(item.name, options.naming, index, { captured, now });
        const directory = options.folders.mode === 'preserve' ? path.dirname(originalRelative) : options.folders.mode === 'named' ? options.folders.name : '';
        const relative = path.join(directory, renamed.filename);
        if (!relative || !inside(sourceRoot, sourcePath)) throw new Error('Photo is outside the source folder.');
        if (stat.size !== item.size || stat.mtimeMs !== item.mtimeMs) throw new Error('Source changed. Reopen the folder before copying.');
        const files = [{ source: sourcePath, relative, stat }];
        if (options.includeJpeg && item.companion) {
          const stat = await sourceStat(item.companion);
          if (item.companionSize !== undefined && (stat.size !== item.companionSize || stat.mtimeMs !== item.companionMtimeMs)) throw new Error('Companion JPEG changed. Reopen the folder before copying.');
          files.push({ source: item.companion, relative: path.join(directory, renamed.stem + path.extname(item.companion)), stat });
        }
        if (options.includeXmp || session.removable && normalizeSettings(options.metadataSettings).writeSidecars !== 'never') {
          let xml = '';
          try {
            const info = await sourceStat(item.sidecar);
            if (info.size > 2 * 1024 ** 2) throw new Error('Existing XMP exceeds 2 MB.');
            xml = await fs.readFile(item.sidecar, 'utf8');
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          const bytes = Buffer.from(updateXmp(xml, { ...item, path: sourcePath, photoRoot: sourceRoot, develop: item.develop ? { ...item.develop, settings: item.develop.settings ?? this.recipeSettings(item.develop.recipe) ?? null } : null }, options.metadataSettings));
          const darktable = item.sidecar === item.path + '.xmp';
          files.push({ bytes, relative: path.join(directory, renamed.stem + (darktable ? renamed.extension : '') + '.xmp') });
        }
        const group = { item, files };
        for (const file of files) {
          if (!inside(root, path.resolve(root, file.relative))) throw new Error('Invalid destination path.');
          const key = process.platform === 'win32' ? file.relative.toLowerCase() : file.relative;
          if (targets.has(key)) { group.conflict = true; targets.get(key).conflict = true; }
          else targets.set(key, group);
          progress.totalBytes += file.bytes?.length ?? file.stat.size;
        }
        groups.push(group);
      } catch (error) { progress.failures.push({ name: item.name, reason: error.message }); progress.completed++; }
    }
    progress.state = 'copying'; emit(true);
    for (const group of groups) {
      if (signal.aborted) break;
      const created = []; let written = 0;
      try {
        if (group.conflict) throw Object.assign(new Error('Selected photos would share a destination filename or XMP sidecar.'), { code: 'CONFLICT' });
        for (const file of group.files) {
          const target = path.join(root, file.relative);
          await parentDirectory(root, file.relative);
          if (await existing(target)) throw Object.assign(new Error(`Already exists: ${file.relative}`), { code: 'CONFLICT' });
        }
        for (const file of group.files) {
          if (signal.aborted) throw canceled();
          progress.file = file.relative; emit(true);
          const target = path.join(root, file.relative);
          let input, output;
          const staging = file.bytes ? `${target}.${randomUUID()}.tmp` : target;
          try {
            if (file.source) {
              const now = await sourceStat(file.source);
              if (now.size !== file.stat.size || now.mtimeMs !== file.stat.mtimeMs) throw new Error('Source changed before copying.');
              input = await fs.open(file.source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
              const opened = await input.stat();
              if (opened.size !== file.stat.size || opened.mtimeMs !== file.stat.mtimeMs) throw new Error('Source changed before copying.');
            }
            output = await fs.open(staging, 'wx'); if (!file.bytes) created.push(target);
            if (file.bytes) {
              await output.writeFile(file.bytes); written += file.bytes.length; progress.bytesCopied += file.bytes.length;
            } else {
              let firstChunk = true;
              for await (const chunk of input.createReadStream({ autoClose: true, highWaterMark: 1024 * 1024, signal })) {
                if (signal.aborted) throw canceled();
                await output.writeFile(chunk);
                written += chunk.length; progress.bytesCopied += chunk.length; emit(firstChunk); firstChunk = false;
              }
              const after = await sourceStat(file.source);
              if (after.size !== file.stat.size || after.mtimeMs !== file.stat.mtimeMs) throw new Error('Source changed during copying.');
            }
            await output.sync();
            if ((await output.stat()).size !== (file.bytes?.length ?? file.stat.size)) throw new Error('Copy size did not match the source.');
            if (file.bytes) {
              await output.close(); output = null;
              if (await existing(target)) throw Object.assign(new Error(`Already exists: ${file.relative}`), { code: 'CONFLICT' });
              await fs.rename(staging, target); created.push(target);
            }
          } finally {
            await Promise.allSettled([input?.close(), output?.close()]);
            if (file.bytes) await fs.rm(staging, { force: true });
          }
        }
        if (options.verify) {
          progress.state = 'verifying'; emit(true);
          const { hashFile } = require('./backup.cjs'), { createHash } = require('node:crypto');
          for (const file of group.files) {
            const source = file.bytes ? createHash('sha256').update(file.bytes).digest('hex') : (await hashFile(file.source, signal)).hash;
            if ((await hashFile(path.join(root,file.relative),signal)).hash !== source) throw new Error('Copy verification failed: hash mismatch.');
          }
          progress.state = 'copying';
        }
        if (options.embedMetadata) {
          for (const file of group.files.filter(file => file.source)) {
            if (signal.aborted) throw canceled();
            progress.file = file.relative; progress.state = 'metadata'; emit(true);
            await this.metadataWriter.write(path.join(root,file.relative), group.item, options.metadataSettings, signal);
          }
          progress.state = 'copying';
        }
        if (signal.aborted) throw canceled();
        if (options.verify) progress.verified = (progress.verified || 0) + group.files.length;
        progress.copied++; progress.copiedFiles += created.length;
      } catch (error) {
        const cleanupErrors = [];
        for (const file of created) await fs.rm(file, { force: true }).catch(cleanup => cleanupErrors.push(`${path.relative(root, file)}: ${cleanup.message}`));
        if (cleanupErrors.length) progress.failures.push({ name: group.item.name, reason: `Could not remove incomplete copies: ${cleanupErrors.join('; ')}` });
        progress.bytesCopied -= written;
        if (!signal.aborted) {
          const list = ['CONFLICT', 'EEXIST'].includes(error.code) ? progress.skipped : progress.failures;
          list.push({ name: group.item.name, reason: error.message });
        }
      }
      progress.state = 'copying'; progress.completed++; emit(true);
    }
    progress.state = signal.aborted ? 'canceled' : 'done'; progress.file = ''; emit(true);
    return progress;
  }
}
module.exports = { TransferService, inside };
