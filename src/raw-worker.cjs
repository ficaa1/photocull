// One isolated worker per render releases the entire WASM heap on completion.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const sharp = require('sharp');

(async () => {
  let raw, phase = 'runtime';
  try {
    const dir = path.dirname(require.resolve('libraw-wasm-nothread'));
    const factory = (await import(pathToFileURL(path.join(dir, 'libraw.js')).href)).default;
    const compiled = await WebAssembly.compile(await fs.readFile(path.join(dir, 'libraw.wasm')));
    const module = await factory({
      instantiateWasm(imports, ready) {
        const instance = new WebAssembly.Instance(compiled, imports);
        ready(instance, compiled);
        return instance.exports;
      }, print: () => {}, printErr: () => {},
    });
    raw = new module.LibRaw();
    phase = 'decode';
    const stat = await fs.stat(workerData.file);
    if (stat.size > 256 * 1024 ** 2) throw Object.assign(new Error('RAW exceeds the 256 MB rendering limit.'), { code: 'RAW_LIMIT' });
    raw.open(new Uint8Array(await fs.readFile(workerData.file)), {
      halfSize: workerData.halfSize, useCameraWb: true, outputBps: 8,
      outputColor: 1, userQual: 0, userFlip: 0,
    });
    const meta = raw.metadata(false);
    if (meta.width * meta.height > 160_000_000) throw Object.assign(new Error('RAW exceeds the 160 megapixel rendering limit.'), { code: 'RAW_LIMIT' });
    const image = raw.imageData();
    if (!image.width || !image.height || image.bits !== 8 || ![1, 3, 4].includes(image.colors) ||
      image.data.length !== image.width * image.height * image.colors) throw new Error('Decoder returned an unsupported pixel layout.');
    // LibRaw's flip values describe sensor transforms; leave pixels unrotated
    // above and carry EXIF orientation into the ordinary representation pipeline.
    const orientation = { 0: 1, 1: 2, 2: 4, 3: 3, 4: 5, 5: 8, 6: 6, 7: 7 }[meta.flip] || 1;
    phase = 'encode';
    await sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
      raw: { width: image.width, height: image.height, channels: image.colors },
    }).jpeg({ quality: 93 }).toFile(workerData.output);
    parentPort.postMessage({ ok: true, width: image.width, height: image.height, orientation,
      cameraWidth: meta.width, cameraHeight: meta.height });
  } catch (error) {
    const message = typeof error?.message === 'string' ? error.message : 'LibRaw could not decode this RAW file.';
    parentPort.postMessage({ ok: false, message, code: error?.code || (phase === 'decode' && !(error instanceof WebAssembly.RuntimeError) ? 'RAW_DECODE_FAILED' : 'RENDER_RUNTIME') });
  } finally { raw?.delete?.(); }
})().catch(error => parentPort.postMessage({ ok: false, message: error.message, code: 'RAW_DECODE_FAILED' }));
