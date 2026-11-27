// Live View Focus Meter: relative detail over time at the loupe area or up to three pinned points.
// The pure region, measure and series functions run in Node tests; FocusMeter is browser-only.
(function(root) {
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const CAP = 640, CAPACITY = 120, SMOOTHING = 3, INTERVAL = 100, STALE_MS = 2000, AT_PEAK = 0.97;
  const POINTS = [{ id: 'A', color: '#64b9be', dash: [] }, { id: 'B', color: '#dc9959', dash: [5, 3] }, { id: 'C', color: '#b48ce0', dash: [1.5, 2.5] }];
  const LOUPE = { id: 'Loupe', color: '#e6e3da', dash: [] };

  // RMS of a four-neighbour Laplacian on Rec. 709 luma: the square root of src/sharpness.cjs's
  // measure without its focus weighting, so it tracks the desktop sharpness score.
  function laplacianContrast(rgba, w, h) {
    if (w < 3 || h < 3) return 0;
    const L = new Float32Array(w * h);
    for (let i = 0, p = 0; i < L.length; i++, p += 4) L[i] = 0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2];
    let n = 0, sum = 0, squares = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, v = L[i - 1] + L[i + 1] + L[i - w] + L[i + w] - 4 * L[i];
      n++; sum += v; squares += v * v;
    }
    return Math.sqrt(Math.max(0, squares / n - (sum / n) ** 2));
  }

  // Whole-pixel box centred on (cx, cy) in frame pixels, kept inside the frame.
  function box(size, cx, cy, width, height) {
    width = Math.max(1, Math.min(size.width, Math.round(width))); height = Math.max(1, Math.min(size.height, Math.round(height)));
    return { x: Math.round(clamp(cx - width / 2, 0, size.width - width)), y: Math.round(clamp(cy - height / 2, 0, size.height - height)), width, height };
  }
  // A pinned point measures a square a tenth of the frame's short side (24–160 px) around it.
  function pointRegion(size, point) {
    const side = clamp(Math.round(Math.min(size.width, size.height) * 0.1), 24, 160);
    return box(size, point.x * size.width, point.y * size.height, side, side);
  }
  // The pixels the 1:1 loupe shows around `center` (Live View's pan clamp), capped around their middle.
  // `view` is the viewport in device pixels; fit and 1:1 therefore measure the same pixels.
  function loupeRegion(size, center, view, cap = CAP) {
    const vw = Math.min(size.width, view.width), vh = Math.min(size.height, view.height);
    const left = clamp(center.x * size.width - vw / 2, 0, size.width - vw), top = clamp(center.y * size.height - vh / 2, 0, size.height - vh);
    return box(size, left + vw / 2, top + vh / 2, Math.min(vw, cap), Math.min(vh, cap));
  }
  // Frame pixels → viewport CSS px through Live View's drawn rect, letterbox and pan included.
  function regionToView(region, size, rect) {
    const sx = rect.width / size.width, sy = rect.height / size.height;
    return { x: rect.x + region.x * sx, y: rect.y + region.y * sy, width: region.width * sx, height: region.height * sy };
  }
  // Viewport CSS px → frame fractions; null over the letterbox unless `clamped`.
  function viewToFrame(x, y, rect, clamped = false) {
    const fx = (x - rect.x) / rect.width, fy = (y - rect.y) / rect.height;
    if (clamped) return { x: clamp(fx, 0, 1), y: clamp(fy, 0, 1) };
    return fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 ? { x: fx, y: fy } : null;
  }
  const round3 = value => Math.round(value * 1000) / 1000;
  function nudge(point, key, large = false) {
    const step = large ? 0.05 : 0.01, d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key];
    return d ? { x: clamp(round3(point.x + d[0] * step), 0, 1), y: clamp(round3(point.y + d[1] * step), 0, 1) } : null;
  }
  // A new point starts at `at`, or beside it when another point already sits there.
  function freeSpot(points, at) {
    for (const [dx, dy] of [[0, 0], [0.12, 0], [-0.12, 0], [0, 0.12], [0, -0.12], [0.12, 0.12], [-0.12, -0.12]]) {
      const spot = { x: clamp(round3(at.x + dx), 0, 1), y: clamp(round3(at.y + dy), 0, 1) };
      if (points.every(p => Math.hypot(p.x - spot.x, p.y - spot.y) > 0.06)) return spot;
    }
    return { x: round3(at.x), y: round3(at.y) };
  }

  // Bounded history of short running means. The peak holds from the last reset, so a frame that
  // stays soft never reads as "at peak" just because sharper frames scrolled out of the graph.
  class FocusSeries {
    constructor(capacity = CAPACITY, smoothing = SMOOTHING) { this.capacity = capacity; this.smoothing = smoothing; this.clear(); }
    clear() { this.recent = []; this.values = []; this.peak = 0; }
    push(value) {
      if (!Number.isFinite(value) || value < 0) return;
      this.recent.push(value); if (this.recent.length > this.smoothing) this.recent.shift();
      const mean = this.recent.reduce((a, b) => a + b, 0) / this.recent.length;
      this.values.push(mean); if (this.values.length > this.capacity) this.values.shift();
      this.peak = Math.max(this.peak, mean);
    }
    get latest() { return this.values.length ? this.values[this.values.length - 1] : null; }
    ratio() { return this.peak > 0 && this.latest !== null ? this.latest / this.peak : null; }
  }

  const api = { POINTS, LOUPE, CAPACITY, laplacianContrast, pointRegion, loupeRegion, regionToView, viewToFrame, nudge, freeSpot, FocusSeries };

  if (typeof document === 'object' && typeof window === 'object') {
    const $ = id => document.getElementById(id), SVG = 'http://www.w3.org/2000/svg';
    const percent = ratio => ratio === null ? '—' : `${Math.round(ratio * 100)}%`;
    const regionKey = r => `${r.x},${r.y},${r.width},${r.height}`;

    class FocusMeter {
      // view() → { geometry, size, center, bitmap } from Live View; geometry is null while nothing is drawn.
      constructor(viewport, { view, toast }) {
        this.viewport = viewport; this.view = view; this.toast = toast;
        this.on = false; this.visible = false; this.points = []; this.traces = new Map(); this.drag = null;
        this.lastBitmap = null; this.nextAt = 0; this.timer = 0; this.staleTimer = 0; this.stale = false; this.sizeKey = ''; this.labelAt = 0; this.legendKey = null;
        this.el = { toggle: $('tether-live-meter'), panel: $('tether-meter'), add: $('tether-meter-add'), reset: $('tether-meter-reset'), graph: $('tether-meter-graph'), legend: $('tether-meter-legend'), note: $('tether-meter-note'), region: $('tether-meter-region'), points: $('tether-meter-points') };
        this.scratch = document.createElement('canvas'); this.scratch.width = this.scratch.height = CAP;
        this.ctx = this.scratch.getContext('2d', { willReadFrequently: true });
        this.el.toggle.onclick = () => this.toggle();
        this.el.add.onclick = () => this.add(null);
        this.el.reset.onclick = () => { for (const t of this.traces.values()) t.series.clear(); this.render(); };
        $('tether-live-canvas').addEventListener('click', event => {
          if (!event.shiftKey || !this.active()) return;
          const g = this.view().geometry, r = this.viewport.getBoundingClientRect(), at = g && viewToFrame(event.clientX - r.left, event.clientY - r.top, g.rect);
          if (at) this.add(at);
        });
      }
      active() { return this.on && this.visible && !document.hidden && this.viewport.offsetParent !== null; }
      toggle(on = !this.on) { this.on = on; this.restart(); return on; }
      // Live View calls this as the stage opens, closes, docks or expands; the docked stage has no room for the meter.
      setVisible(visible) { if (visible !== this.visible) { this.visible = visible; this.restart(); } }
      // A new stream, a reopened stage or toggling the meter starts every trace over.
      restart() {
        clearTimeout(this.timer); clearTimeout(this.staleTimer); this.timer = this.staleTimer = 0;
        for (const t of this.traces.values()) t.series.clear();
        this.lastBitmap = null; this.stale = false; this.nextAt = 0; this.drag = null;
        this.render();
      }
      // A fresh decoded frame: measured at most every INTERVAL ms, and slower when measuring takes longer.
      frame() {
        if (!this.active() || this.timer) return;
        this.timer = setTimeout(() => { this.timer = 0; this.measure(); }, Math.max(0, this.nextAt - performance.now()));
      }
      // One trace per pinned point, or the loupe area when none is pinned. Moving a region clears its history.
      sync(v = this.view()) {
        if (!v.size) return [];
        const viewport = this.viewport, dpr = window.devicePixelRatio || 1;
        const wanted = this.points.length ? this.points.map(p => ({ spec: POINTS.find(s => s.id === p.id), region: pointRegion(v.size, p) }))
          : [{ spec: LOUPE, region: loupeRegion(v.size, v.center, { width: viewport.clientWidth * dpr, height: viewport.clientHeight * dpr }) }];
        for (const id of this.traces.keys()) if (!wanted.some(w => w.spec.id === id)) this.traces.delete(id);
        return wanted.map(({ spec, region }) => {
          let trace = this.traces.get(spec.id);
          if (!trace) this.traces.set(spec.id, trace = { spec, key: '', series: new FocusSeries() });
          if (trace.key !== regionKey(region)) { trace.key = regionKey(region); trace.series.clear(); }
          trace.region = region; return trace;
        });
      }
      measure() {
        const v = this.view();
        if (!this.active() || !v.bitmap || !v.size || v.bitmap === this.lastBitmap) return;
        const started = performance.now(), sizeKey = `${v.size.width}x${v.size.height}`;
        if (sizeKey !== this.sizeKey) { this.sizeKey = sizeKey; for (const t of this.traces.values()) t.series.clear(); }
        this.ctx.globalCompositeOperation = 'copy';
        for (const trace of this.sync(v)) {
          const r = trace.region;
          this.ctx.drawImage(v.bitmap, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
          trace.series.push(laplacianContrast(this.ctx.getImageData(0, 0, r.width, r.height).data, r.width, r.height));
        }
        this.lastBitmap = v.bitmap;
        const now = performance.now(); this.nextAt = now + Math.max(INTERVAL, (now - started) * 4);
        clearTimeout(this.staleTimer); this.stale = false;
        this.staleTimer = setTimeout(() => { this.staleTimer = 0; this.stale = true; this.render(); }, STALE_MS);
        this.render();
      }
      add(at) {
        if (!this.active()) return;
        if (this.points.length >= POINTS.length) return this.toast('Up to three focus points. Remove one to pin another.');
        const v = this.view(); if (!v.size) return;
        if (!at) { const dpr = window.devicePixelRatio || 1, r = loupeRegion(v.size, v.center, { width: this.viewport.clientWidth * dpr, height: this.viewport.clientHeight * dpr }); at = freeSpot(this.points, { x: (r.x + r.width / 2) / v.size.width, y: (r.y + r.height / 2) / v.size.height }); }
        const id = POINTS.find(s => !this.points.some(p => p.id === s.id)).id;
        this.points.push({ id, x: round3(at.x), y: round3(at.y) }); this.points.sort((a, b) => a.id.localeCompare(b.id));
        this.render(); this.marker(id)?.focus({ preventScroll: true });
      }
      remove(id) {
        this.points = this.points.filter(p => p.id !== id); this.render();
        this.el.add.focus({ preventScroll: true });
      }
      move(id, at) { const point = this.points.find(p => p.id === id); if (!point) return; point.x = at.x; point.y = at.y; this.render(); }
      marker(id) { return this.el.points.querySelector(`[data-point="${id}"]`); }
      render() {
        const shown = this.on && this.visible, { el } = this;
        el.toggle.setAttribute('aria-pressed', String(this.on));
        el.panel.hidden = !shown; el.panel.classList.toggle('stale', this.stale);
        el.note.textContent = shown && this.stale ? 'No new frames' : '';
        el.add.disabled = this.points.length >= POINTS.length;
        el.add.title = el.add.disabled ? 'Up to three focus points' : 'Pin a focus point (or Shift+click the image)';
        const traces = shown ? this.sync() : [];
        this.renderMarkers(shown); this.renderLegend(traces); this.layout(); this.draw(traces);
      }
      renderMarkers(shown) {
        const ids = shown ? this.points.map(p => p.id).join() : '';
        if (this.el.points.dataset.ids === ids) return;
        this.el.points.dataset.ids = ids;
        this.el.points.replaceChildren(...(shown ? this.points : []).map(point => {
          const spec = POINTS.find(s => s.id === point.id), button = document.createElement('button'), tag = document.createElement('span');
          button.type = 'button'; button.className = 'tether-meter-point'; button.dataset.point = point.id; button.style.setProperty('--trace', spec.color);
          button.setAttribute('aria-describedby', `tether-meter-value-${point.id}`); tag.textContent = point.id; button.append(tag);
          button.addEventListener('pointerdown', event => this.grab(event, point.id));
          button.addEventListener('pointermove', event => this.dragTo(event));
          for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, () => { this.drag = null; });
          button.addEventListener('keydown', event => this.key(event, point.id));
          return button;
        }));
      }
      grab(event, id) {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus({ preventScroll: true });
        this.drag = { id };
      }
      dragTo(event) {
        const g = this.drag && this.view().geometry; if (!g) return;
        const r = this.viewport.getBoundingClientRect(), at = viewToFrame(event.clientX - r.left, event.clientY - r.top, g.rect, true);
        this.move(this.drag.id, { x: round3(at.x), y: round3(at.y) });
      }
      // Arrow keys and Delete stay with the point: they would otherwise pan the loupe or move through photos.
      key(event, id) {
        const point = this.points.find(p => p.id === id); if (!point) return;
        if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); return this.remove(id); }
        const at = nudge(point, event.key, event.shiftKey); if (!at) return;
        event.preventDefault(); event.stopPropagation(); this.move(id, at);
      }
      renderLegend(traces) {
        const key = traces.map(t => t.spec.id).join();
        if (key !== this.legendKey) {
          this.legendKey = key;
          this.el.legend.replaceChildren(...traces.map(({ spec }) => {
            const item = document.createElement('li'), name = document.createElement('b'), value = document.createElement('span');
            item.className = 'tether-meter-trace'; item.dataset.trace = spec.id;
            const swatch = document.createElementNS(SVG, 'svg'), line = document.createElementNS(SVG, 'line');
            swatch.setAttribute('width', '16'); swatch.setAttribute('height', '6'); swatch.setAttribute('aria-hidden', 'true');
            for (const [k, val] of Object.entries({ x1: 1, y1: 3, x2: 15, y2: 3, stroke: spec.color, 'stroke-width': 2, 'stroke-dasharray': spec.dash.join(' ') || 'none' })) line.setAttribute(k, val);
            swatch.append(line);
            name.textContent = spec.id; value.className = 'tether-meter-value tabular'; value.id = `tether-meter-value-${spec.id}`;
            item.append(swatch, name, value);
            if (spec !== LOUPE) {
              const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button quiet tether-meter-remove'; remove.textContent = '×';
              remove.setAttribute('aria-label', `Remove point ${spec.id}`); remove.onclick = () => this.remove(spec.id); item.append(remove);
            }
            return item;
          }));
        }
        for (const { spec, series } of traces) {
          const item = this.el.legend.querySelector(`[data-trace="${spec.id}"]`), ratio = series.ratio(), at = ratio !== null && ratio >= AT_PEAK;
          item.classList.toggle('at-peak', at);
          item.querySelector('.tether-meter-value').textContent = percent(ratio);
          item.title = `${spec === LOUPE ? 'Loupe area' : 'Point ' + spec.id}: ${ratio === null ? 'waiting for a frame' : `${percent(ratio)} of the sharpest frame since the graph started${at ? ' (at peak)' : ''}`}`;
        }
      }
      // Places point markers and the loupe outline over the drawn frame; Live View calls this whenever it repaints.
      layout() {
        const v = this.view(), g = v.geometry, shown = this.on && this.visible && !!g && !!v.size;
        for (const button of this.el.points.children) {
          const point = this.points.find(p => p.id === button.dataset.point);
          button.hidden = !shown || !point; if (button.hidden) continue;
          const r = regionToView(pointRegion(v.size, point), v.size, g.rect), side = Math.max(14, r.width);
          Object.assign(button.style, { left: `${r.x + r.width / 2 - side / 2}px`, top: `${r.y + r.height / 2 - side / 2}px`, width: `${side}px`, height: `${side}px` });
          button.setAttribute('aria-label', `Focus point ${point.id} at ${Math.round(point.x * 100)}% across, ${Math.round(point.y * 100)}% down. Arrow keys move it, Shift for larger steps, Delete removes it.`);
        }
        const outline = this.el.region;
        outline.hidden = !shown || this.points.length > 0;
        if (outline.hidden) return;
        const dpr = window.devicePixelRatio || 1, w = this.viewport.clientWidth, h = this.viewport.clientHeight;
        const r = regionToView(loupeRegion(v.size, v.center, { width: w * dpr, height: h * dpr }), v.size, g.rect);
        const seenWidth = Math.min(w, g.rect.x + g.rect.width) - Math.max(0, g.rect.x), seenHeight = Math.min(h, g.rect.y + g.rect.height) - Math.max(0, g.rect.y);
        // Only outline the area when it is smaller than the visible frame.
        outline.hidden = r.width >= seenWidth - 1 && r.height >= seenHeight - 1;
        Object.assign(outline.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
      }
      draw(traces) {
        const canvas = this.el.graph, w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return;
        const dpr = window.devicePixelRatio || 1, ctx = canvas.getContext('2d');
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // The right gutter holds the "peak" label beside the dashed peak line.
        const top = 5, bottom = h - 2, right = w - 30, line = y => (Math.round(y * dpr) + 0.5) / dpr;
        ctx.lineWidth = 1 / dpr; ctx.setLineDash([2, 3]); ctx.strokeStyle = 'rgba(255,255,255,.22)';
        ctx.beginPath(); ctx.moveTo(0, line(top)); ctx.lineTo(right, line(top)); ctx.stroke();
        ctx.setLineDash([]); ctx.strokeStyle = 'rgba(255,255,255,.1)';
        ctx.beginPath(); ctx.moveTo(0, line(bottom)); ctx.lineTo(right, line(bottom)); ctx.stroke();
        const step = (right - 6) / (CAPACITY - 1);
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        for (const { spec, series } of traces) {
          const { values, peak } = series; if (!values.length || !peak) continue;
          const x = i => right - 3 - (values.length - 1 - i) * step, y = value => bottom - (value / peak) * (bottom - top);
          ctx.strokeStyle = ctx.fillStyle = spec.color; ctx.lineWidth = 1.5; ctx.setLineDash(spec.dash);
          ctx.beginPath(); values.forEach((value, i) => i ? ctx.lineTo(x(i), y(value)) : ctx.moveTo(x(i), y(value))); ctx.stroke();
          ctx.setLineDash([]); ctx.beginPath(); ctx.arc(x(values.length - 1), y(values[values.length - 1]), 2.25, 0, 2 * Math.PI); ctx.fill();
        }
        const now = performance.now();
        if (now - this.labelAt > 1000 || !traces.length) {
          this.labelAt = now;
          canvas.setAttribute('aria-label', traces.length ? 'Focus meter graph. ' + traces.map(t => `${t.spec.id === 'Loupe' ? 'Loupe area' : 'Point ' + t.spec.id} ${percent(t.series.ratio())} of peak`).join(', ') : 'Focus meter graph');
        }
      }
    }
    api.FocusMeter = FocusMeter;
  }

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PhotoCullFocusMeter = api;
})(typeof globalThis === 'object' ? globalThis : this);
