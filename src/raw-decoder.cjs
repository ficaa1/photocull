const path = require('node:path');
const { Worker } = require('node:worker_threads');

const DECODER_ID = 'libraw-0.22.1-wasm-1.6.0-nothread.1-rgb8-camera-wb-linear-v1';
function renderRaw(file, output, { halfSize = true, timeoutMs = 45000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('RAW rendering canceled.'), { code: 'CANCELED' }));
    const worker = new Worker(path.join(__dirname, 'raw-worker.cjs'), { workerData: { file, output, halfSize } });
    let finished = false;
    const finish = async (error, result) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      // Wait for worker exit before resolving so callers can safely remove files.
      await worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => void finish(Object.assign(new Error('RAW rendering canceled.'), { code: 'CANCELED' }));
    const timer = setTimeout(() => void finish(Object.assign(new Error('RAW rendering exceeded its time limit. You can retry this image.'), { code: 'RENDER_TIMEOUT' })), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.on('message', result => void finish(result.ok ? null : Object.assign(new Error(result.message), { code: result.code }), result));
    worker.on('error', error => void finish(error));
    worker.on('exit', code => { if (!finished) void finish(Object.assign(new Error(`RAW renderer exited without an image (${code}).`), { code: 'RENDER_EXIT' })); });
  });
}

module.exports = { renderRaw, DECODER_ID };
