// Display histogram maths and interaction scheduling, shared by the UI and node tests.
// Adapted from Lightcraft d58b4d6, Copyright (c) 2026 ArtCraft Team and contributors.
// MIT license: third-party/lightcraft-LICENSE-MIT.txt; see lightcraft-NOTICE.txt.
(function (root, factory) {
  const value = factory();
  if (typeof module === 'object' && module.exports) module.exports = value;
  else root.PhotoCullDevelopLogic = value;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  const zones = [
    ['blacks', 0, .15], ['shadows', .15, .35], ['exposure', .35, .65],
    ['highlights', .65, .85], ['whites', .85, 1],
  ].map(([control, from, to]) => ({ control: `light.${control}`, from, to }));
  function zoneAt(x) { return Number.isFinite(x) && x >= 0 && x <= 1 ? zones.find(z => x < z.to) || zones[4] : null; }
  function smooth(bins) {
    return Array.from({ length: 256 }, (_, i) => {
      const a = Math.max(0, i - 2), b = Math.min(255, i + 2);
      let sum = 0; for (let j = a; j <= b; j++) sum += bins[j] || 0;
      return sum / (b - a + 1);
    });
  }
  function histogramData(hist) {
    const channels = ['luma', 'r', 'g', 'b'].map(k => smooth(hist[k] || []));
    const peak = Math.max(1, ...channels.slice(1).flatMap(c => c.slice(2, 254)));
    const total = hist.total || 0;
    const fraction = i => total ? Math.max(...['r','g','b'].map(k => hist[k]?.[i] || 0)) / total : 0;
    const difference = Array.from({ length: 256 }, (_, i) => Math.abs((hist.r?.[i] || 0) - (hist.g?.[i] || 0)) + Math.abs((hist.g?.[i] || 0) - (hist.b?.[i] || 0))).reduce((a, b) => a + b, 0);
    return { heights: channels.map(c => c.map(v => Math.min(1, Math.sqrt(v / peak)))), peak,
      gray: difference / Math.max(1, (hist.g || []).reduce((a,b) => a+b, 0)) < .02, shadows: fraction(0) > .003, highlights: fraction(255) > .003 };
  }
  function dragged(spec, base, dx, width, fine) {
    if (![base, dx, width].every(Number.isFinite) || width <= 0) return base;
    return Math.max(spec.min, Math.min(spec.max, base + dx / width * (spec.max - spec.min) * (fine ? .1 : 1)));
  }
  function quantize(spec, value) {
    if (!Number.isFinite(value)) return spec.default || 0;
    return Number(Math.max(spec.min, Math.min(spec.max, Math.round(value / spec.step) * spec.step)).toFixed(6));
  }
  // JPEG/canvas warning mask: any channel at white, all channels at black.
  function clippingMask(pixels) {
    const out = new Uint8ClampedArray(pixels.length);
    for (let i = 0; i < pixels.length; i += 4) {
      if (Math.max(pixels[i], pixels[i+1], pixels[i+2]) >= 255) { out[i] = 255; out[i+3] = 210; }
      else if (Math.max(pixels[i], pixels[i+1], pixels[i+2]) <= 0) { out[i+2] = 255; out[i+3] = 210; }
    }
    return out;
  }
  function merge(base, partial) {
    const out = structuredClone(base || {});
    for (const [k, v] of Object.entries(partial || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(out[k], v) : structuredClone(v);
    return out;
  }
  // One render in flight, latest pending snapshot wins. Settling is a separate request
  // after idle. Completed drafts keep the preview moving during sustained input;
  // invalidated photos never publish, and superseded settled frames are discarded.
  class RenderQueue {
    constructor(render, publish, error, { delay = 250, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id) } = {}) {
      Object.assign(this, { render, publish, error, delay, setTimer, clearTimer, version: 0, epoch: 0, running: false });
    }
    request(value) {
      const version = ++this.version;
      this.clearTimer(this.timer);
      this.pending = { value: structuredClone(value), version, epoch: this.epoch, settled: false };
      void this.pump();
      this.timer = this.setTimer(() => { this.pending = { value: structuredClone(value), version, epoch: this.epoch, settled: true }; void this.pump(); }, this.delay);
    }
    invalidate() { this.version++; this.epoch++; this.pending = null; this.clearTimer(this.timer); }
    async pump() {
      if (this.running || !this.pending) return;
      const job = this.pending; this.pending = null; this.running = true;
      try { const frame = await this.render(job.value, job.settled); if (job.epoch === this.epoch && (!job.settled || job.version === this.version)) await this.publish(frame, job); }
      catch (e) { if (job.version === this.version) this.error(e); }
      finally { this.running = false; void this.pump(); }
    }
  }
  return { zones, zoneAt, smooth, histogramData, dragged, quantize, clippingMask, merge, RenderQueue };
});
