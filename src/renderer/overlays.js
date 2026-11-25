// Composition and review aids drawn over a photo or the live feed. The pure
// geometry and pixel functions run in Node tests; OverlayLayer is browser-only.
(function(root) {
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const RATIOS = ['2:3', '4:5', '1:1', '16:9', '8:10', '5:7'];
  const GOLDEN = 0.6180339887498949;

  function parseHex(hex) {
    const match = /^#?([\da-f]{6})$/i.exec(String(hex || ''));
    const n = match ? parseInt(match[1], 16) : 0xffffff;
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  }
  const asRect = r => r && 'left' in r ? { x: r.left, y: r.top, width: r.width, height: r.height } : { x: r.x, y: r.y, width: r.width, height: r.height };

  // Snaps a box to whole device pixels so 1px strokes stay sharp at any DPR.
  function imageBox(drawn, dpr = 1) {
    const r = asRect(drawn), x0 = Math.round(r.x * dpr), y0 = Math.round(r.y * dpr);
    const x1 = Math.round((r.x + r.width) * dpr), y1 = Math.round((r.y + r.height) * dpr);
    return { x: x0 / dpr, y: y0 / dpr, width: (x1 - x0) / dpr, height: (y1 - y0) / dpr };
  }
  // CSS coordinate at which a line `deviceWidth` device pixels wide covers whole pixels.
  function crisp(value, dpr = 1, deviceWidth = 1) {
    return (Math.round(value * dpr) + (Math.max(1, Math.round(deviceWidth)) % 2 ? 0.5 : 0)) / dpr;
  }

  function lumaPlane(rgba, w, h) {
    const out = new Float32Array(w * h);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = (0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2]) / 255;
    return out;
  }
  function paint(mask, w, h, color, alpha) {
    const [r, g, b] = parseHex(color), data = new Uint8ClampedArray(w * h * 4), a = Math.round(clamp(alpha, 0, 1) * 255);
    let count = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) { const p = i * 4; data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = a; count++; }
    return { width: w, height: h, data, count };
  }

  // Sobel gradient of luma; |∇|/4 is 1 for a full black-to-white step.
  function computeFocusPeaking(rgba, w, h, { color = '#ffff00', sensitivity = 0.5 } = {}) {
    const L = lumaPlane(rgba, w, h), mask = new Uint8Array(w * h), threshold = 0.40 + (0.05 - 0.40) * clamp(sensitivity, 0, 1);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, a = L[i - w - 1], b = L[i - w], c = L[i - w + 1], d = L[i - 1], f = L[i + 1], g = L[i + w - 1], k = L[i + w], m = L[i + w + 1];
      const gx = c + 2 * f + m - a - 2 * d - g, gy = g + 2 * k + m - a - 2 * b - c;
      if (Math.hypot(gx, gy) / 4 >= threshold) mask[i] = 1;
    }
    return paint(mask, w, h, color, 1);
  }

  // Removes 8-connected marked regions smaller than `min` pixels, in place.
  function suppressSpeckles(mask, w, h, min = 8) {
    const seen = new Uint8Array(w * h), stack = new Int32Array(w * h), region = [];
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || seen[start]) continue;
      let top = 0; stack[top++] = start; seen[start] = 1; region.length = 0;
      while (top) {
        const i = stack[--top], x = i % w, y = (i - x) / w; region.push(i);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy; if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx; if (mask[n] && !seen[n]) { seen[n] = 1; stack[top++] = n; }
        }
      }
      if (region.length < min) for (const i of region) mask[i] = 0;
    }
    return mask;
  }

  // Smoothed luma → |Laplacian| → 5×5 local mean: in-focus texture stands out, noise and soft edges do not.
  function computeFocusMask(rgba, w, h, { color = '#00ff00', opacity = 0.55, threshold = 0.03 } = {}) {
    const L = lumaPlane(rgba, w, h), at = (x, max) => x < 0 ? 0 : x > max ? max : x;
    const horizontal = new Float32Array(w * h), blurred = new Float32Array(w * h), lap = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) horizontal[y * w + x] = (L[y * w + at(x - 1, w - 1)] + 2 * L[y * w + x] + L[y * w + at(x + 1, w - 1)]) / 4;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) blurred[y * w + x] = (horizontal[at(y - 1, h - 1) * w + x] + 2 * horizontal[y * w + x] + horizontal[at(y + 1, h - 1) * w + x]) / 4;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      lap[i] = Math.abs(4 * blurred[i] - blurred[at(y - 1, h - 1) * w + x] - blurred[at(y + 1, h - 1) * w + x] - blurred[y * w + at(x - 1, w - 1)] - blurred[y * w + at(x + 1, w - 1)]);
    }
    const rows = new Float32Array(w * h), mask = new Uint8Array(w * h), limit = clamp(threshold, 0.005, 0.20);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let d = -2; d <= 2; d++) s += lap[y * w + at(x + d, w - 1)]; rows[y * w + x] = s; }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let d = -2; d <= 2; d++) s += rows[at(y + d, h - 1) * w + x]; if (s / 25 >= limit) mask[y * w + x] = 1; }
    suppressSpeckles(mask, w, h, 8);
    return paint(mask, w, h, color, opacity);
  }

  function validWarning(high, low) {
    if (!Number.isInteger(high) || !Number.isInteger(low) || low < 0 || high > 255 || low >= high) throw new RangeError('Exposure warning needs whole numbers with 0 ≤ low < high ≤ 255.');
  }
  // Red where any channel reaches `high`, blue where every channel stays at or below `low`.
  function computeExposureWarning(rgba, w, h, { high = 250, low = 5, shadows = false, zebra = false, stripe = 8 } = {}) {
    validWarning(high, low);
    const data = new Uint8ClampedArray(w * h * 4); let highlights = 0, dark = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4, max = Math.max(rgba[p], rgba[p + 1], rgba[p + 2]);
      const hot = max >= high, cold = shadows && !hot && max <= low;
      if (!hot && !cold) continue;
      if (hot) highlights++; else dark++;
      if (zebra && Math.floor((x + y) / stripe) % 2) continue;
      data[p] = hot ? 255 : 0; data[p + 2] = hot ? 0 : 255; data[p + 3] = 255;
    }
    return { width: w, height: h, data, highlights, shadows: dark };
  }

  function computeHistogram(rgba, w, h) {
    const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), luma = new Uint32Array(256), total = w * h;
    for (let i = 0, p = 0; i < total; i++, p += 4) {
      r[rgba[p]]++; g[rgba[p + 1]]++; b[rgba[p + 2]]++;
      luma[Math.round(0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2])]++;
    }
    return { r, g, b, luma, total };
  }

  // The reference image fits its anchor (the crop when following it), then scales and offsets by anchor fractions.
  function computeOverlayRect(imageRect, cropRect, assetSize, { scale = 1, x = 0, y = 0, followCrop = true } = {}) {
    const anchor = asRect(followCrop && cropRect ? cropRect : imageRect);
    if (!assetSize?.width || !assetSize?.height || !anchor.width || !anchor.height) return null;
    const fit = Math.min(anchor.width / assetSize.width, anchor.height / assetSize.height) * clamp(scale, 0.1, 4);
    const width = assetSize.width * fit, height = assetSize.height * fit;
    const cx = anchor.x + anchor.width / 2 + clamp(x, -1, 1) * anchor.width, cy = anchor.y + anchor.height / 2 + clamp(y, -1, 1) * anchor.height;
    return { x: cx - width / 2, y: cy - height / 2, width, height, clip: anchor };
  }

  function aspectValue(ratio, orientation) {
    if (!RATIOS.includes(ratio)) throw new RangeError('Unknown aspect ratio: ' + ratio);
    const [a, b] = ratio.split(':').map(Number), short = Math.min(a, b), long = Math.max(a, b);
    return orientation === 'portrait' ? short / long : long / short;
  }
  // Largest centered rectangle of the ratio, plus the matte rectangles around it.
  function computeAspectRect(imageRect, ratio = '2:3', orientation = 'portrait') {
    const r = asRect(imageRect), target = aspectValue(ratio, orientation);
    let width = r.width, height = r.width / target;
    if (height > r.height) { height = r.height; width = r.height * target; }
    const rect = { x: r.x + (r.width - width) / 2, y: r.y + (r.height - height) / 2, width, height };
    const mattes = [
      { x: r.x, y: r.y, width: r.width, height: rect.y - r.y },
      { x: r.x, y: rect.y + height, width: r.width, height: r.y + r.height - rect.y - height },
      { x: r.x, y: rect.y, width: rect.x - r.x, height },
      { x: rect.x + width, y: rect.y, width: r.x + r.width - rect.x - width, height },
    ].filter(m => m.width > 1e-6 && m.height > 1e-6);
    return { rect, mattes };
  }

  function computeGridLines(rect, config = {}) {
    const r = asRect(rect), lines = [];
    const vertical = f => lines.push({ x1: r.x + f * r.width, y1: r.y, x2: r.x + f * r.width, y2: r.y + r.height });
    const horizontal = f => lines.push({ x1: r.x, y1: r.y + f * r.height, x2: r.x + r.width, y2: r.y + f * r.height });
    const type = config.type || 'thirds';
    const both = fractions => { for (const f of fractions) vertical(f); for (const f of fractions) horizontal(f); };
    if (type === 'thirds') both([1 / 3, 2 / 3]);
    else if (type === 'goldenRatio') both([1 - GOLDEN, GOLDEN]);
    else if (type === 'crosshair') both([0.5]);
    else if (type === 'custom') {
      const cols = clamp(Math.round(config.cols || 3), 1, 128), rows = clamp(Math.round(config.rows || 3), 1, 128);
      for (let i = 1; i < cols; i++) vertical(i / cols);
      for (let i = 1; i < rows; i++) horizontal(i / rows);
    }
    for (const guide of config.guides || []) {
      if (!(guide.at >= 0 && guide.at <= 1)) continue;
      if (guide.axis === 'x') vertical(guide.at); else if (guide.axis === 'y') horizontal(guide.at);
    }
    return lines;
  }

  // Quarter arcs through successively smaller squares of a golden rectangle fitted in `rect`.
  // Mirror flips horizontally; a vertical flip then sets the requested winding.
  function computeGoldenSpiral(rect, { mirror = false, clockwise = true, minSize = 1 } = {}) {
    const r = asRect(rect), landscape = r.width >= r.height;
    let W = landscape ? r.width : r.height, H = landscape ? r.height : r.width;
    if (W / H > 1 / GOLDEN) W = H / GOLDEN; else H = W * GOLDEN;
    const outer = landscape ? { x: r.x + (r.width - W) / 2, y: r.y + (r.height - H) / 2, width: W, height: H }
      : { x: r.x + (r.width - H) / 2, y: r.y + (r.height - W) / 2, width: H, height: W };
    const arcs = [], box = { x: 0, y: 0, width: W, height: H };
    const STEPS = [
      b => { const s = b.height; return { square: s, cx: b.x + s, cy: b.y + s, start: Math.PI, end: 1.5 * Math.PI, next: { x: b.x + s, y: b.y, width: b.width - s, height: b.height } }; },
      b => { const s = b.width; return { square: s, cx: b.x, cy: b.y + s, start: 1.5 * Math.PI, end: 2 * Math.PI, next: { x: b.x, y: b.y + s, width: b.width, height: b.height - s } }; },
      b => { const s = b.height; return { square: s, cx: b.x + b.width - s, cy: b.y, start: 0, end: 0.5 * Math.PI, next: { x: b.x, y: b.y, width: b.width - s, height: b.height } }; },
      b => { const s = b.width; return { square: s, cx: b.x + s, cy: b.y + b.height - s, start: 0.5 * Math.PI, end: Math.PI, next: { x: b.x, y: b.y, width: b.width, height: b.height - s } }; },
    ];
    let current = box;
    for (let i = 0; i < 40; i++) {
      const step = STEPS[i % 4](current);
      if (step.square < minSize) break;
      arcs.push({ cx: step.cx, cy: step.cy, radius: step.square, start: step.start, end: step.end, anticlockwise: false });
      current = step.next;
    }
    const transforms = [];
    if (!landscape) transforms.push('transpose');
    if (mirror) transforms.push('flipX');
    if (transforms.length % 2 !== (clockwise ? 0 : 1)) transforms.push('flipY');
    const out = arcs.map(arc => {
      let { cx, cy, start, end, anticlockwise } = arc;
      for (const t of transforms) {
        if (t === 'transpose') { [cx, cy] = [cy, cx]; [start, end] = [Math.PI / 2 - start, Math.PI / 2 - end]; }
        else if (t === 'flipX') { cx = outer.width - cx; [start, end] = [Math.PI - start, Math.PI - end]; }
        else { cy = outer.height - cy; [start, end] = [-start, -end]; }
        anticlockwise = !anticlockwise;
      }
      return { cx: outer.x + cx, cy: outer.y + cy, radius: arc.radius, start, end, anticlockwise };
    });
    return { rect: outer, arcs: out };
  }

  const api = { RATIOS, parseHex, imageBox, crisp, computeFocusPeaking, computeFocusMask, suppressSpeckles, computeExposureWarning, computeHistogram, computeOverlayRect, computeAspectRect, computeGridLines, computeGoldenSpiral, aspectValue, validWarning };

  if (typeof document === 'object' && typeof window === 'object') {
    // Draws, back to front: analysis (mask/peaking), exposure warnings, the reference image,
    // the aspect matte and grids. Pointer-transparent except while moving the reference image.
    class OverlayLayer {
      // options.geometry() → { rect:{x,y,width,height}, crop? } in viewport CSS px, or null.
      // options.pixels(maxSide) → Promise<{ key, width, height, data }>; live layers call setFrame instead.
      constructor(viewport, { geometry, pixels = null, live = false, onMove = null, onStatus = () => {} } = {}) {
        this.viewport = viewport; this.geometry = geometry; this.pixels = pixels; this.live = live; this.onMove = onMove; this.onStatus = onStatus;
        this.canvas = document.createElement('canvas'); this.canvas.className = 'overlay-layer'; this.canvas.setAttribute('aria-hidden', 'true');
        viewport.append(this.canvas);
        this.ctx = this.canvas.getContext('2d');
        this.config = {}; this.asset = null; this.analysis = null; this.analysisKey = ''; this.pending = null; this.frame = null;
        this.signature = ''; this.dirty = true; this.raf = 0; this.generation = 0; this.moving = false; this.drag = null; this.enabled = true;
        this.scratch = document.createElement('canvas');
        new ResizeObserver(() => this.invalidate()).observe(viewport);
        this.canvas.addEventListener('pointerdown', event => this.down(event));
        this.canvas.addEventListener('pointermove', event => this.moveTo(event));
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) this.canvas.addEventListener(type, () => this.up());
        this.canvas.addEventListener('keydown', event => this.nudge(event));
      }
      active() {
        const c = this.config;
        return this.enabled && !!(c.grid?.shown || c.aspect?.shown || c.overlay?.shown && this.asset || c.mask?.shown && !this.live || c.peaking?.shown && this.live || c.warning?.shown);
      }
      setConfig(config) { this.config = config || {}; this.analysisKey = ''; this.generation++; this.invalidate(); }
      setEnabled(value) { this.enabled = !!value; this.invalidate(); }
      setAsset(asset) { this.asset = asset; this.invalidate(); }
      setFrame(frame) { this.frame = frame; this.analysisKey = ''; this.invalidate(); }
      imageChanged() { this.analysis = null; this.analysisKey = ''; this.generation++; this.invalidate(); }
      invalidate() {
        this.dirty = true;
        if (!this.raf) this.raf = requestAnimationFrame(() => this.tick());
      }
      // Watches geometry every frame while active: ImageView animates zoom without calling onChange per frame.
      tick() {
        this.raf = 0;
        const on = this.active() && this.viewport.isConnected && this.viewport.offsetParent !== null;
        this.canvas.hidden = !on;
        this.setMoving(this.moving && on);
        if (!on) { this.signature = ''; return; }
        const g = this.geometry(), dpr = window.devicePixelRatio || 1, w = this.viewport.clientWidth, h = this.viewport.clientHeight;
        const signature = JSON.stringify([g, dpr, w, h]);
        if (this.dirty || signature !== this.signature) { this.signature = signature; this.dirty = false; this.draw(g, dpr, w, h); }
        this.raf = requestAnimationFrame(() => this.tick());
      }
      wantAnalysis() {
        const c = this.config;
        if (this.live) return c.peaking?.shown ? 'peaking' : c.warning?.shown ? 'warning' : '';
        return c.mask?.shown || c.warning?.shown ? 'review' : '';
      }
      analysisSettings() {
        const c = this.config;
        return JSON.stringify([c.mask?.shown && !this.live && c.mask, c.peaking?.shown && this.live && c.peaking, c.warning?.shown && c.warning]);
      }
      refreshAnalysis() {
        if (!this.wantAnalysis()) { this.analysis = null; return; }
        const settings = this.analysisSettings();
        if (this.live) {
          if (this.frame && this.frame.key + settings !== this.analysisKey) { this.analysisKey = this.frame.key + settings; this.analysis = this.analyze(this.frame); }
          return;
        }
        if (!this.pixels || this.pending || this.analysisKey) return;
        const generation = this.generation;
        const job = this.pending = this.pixels(1600).then(frame => {
          if (generation !== this.generation) return;
          this.analysisKey = settings; this.analysis = frame ? this.analyze(frame) : null;
          this.onStatus(frame ? '' : 'Pixel analysis is unavailable for this photo.');
        }).catch(error => { if (generation === this.generation) { this.analysis = null; this.analysisKey = settings; this.onStatus('Pixel analysis unavailable: ' + error.message); } })
          .finally(() => { if (this.pending === job) this.pending = null; this.invalidate(); });
      }
      analyze(frame) {
        const c = this.config, layers = [];
        try {
          if (!this.live && c.mask?.shown) layers.push(computeFocusMask(frame.data, frame.width, frame.height, c.mask));
          if (this.live && c.peaking?.shown) layers.push(computeFocusPeaking(frame.data, frame.width, frame.height, c.peaking));
          if (c.warning?.shown) layers.push(computeExposureWarning(frame.data, frame.width, frame.height, { ...c.warning, zebra: this.live }));
        } catch (error) { this.onStatus(error.message); return null; }
        this.scratch.width = frame.width; this.scratch.height = frame.height;
        const ctx = this.scratch.getContext('2d'); ctx.clearRect(0, 0, frame.width, frame.height);
        const tmp = document.createElement('canvas'); tmp.width = frame.width; tmp.height = frame.height;
        for (const layer of layers) { tmp.getContext('2d').putImageData(new ImageData(layer.data, layer.width, layer.height), 0, 0); ctx.drawImage(tmp, 0, 0); }
        return { canvas: this.scratch, mask: layers[0]?.count ?? 0 };
      }
      draw(g, dpr, w, h) {
        const canvas = this.canvas, ctx = this.ctx;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
        canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!g?.rect?.width) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const rect = imageBox(g.rect, dpr), c = this.config;
        this.refreshAnalysis();
        ctx.save(); ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.width, rect.height); ctx.clip();
        if (this.analysis) { ctx.imageSmoothingEnabled = false; ctx.drawImage(this.analysis.canvas, rect.x, rect.y, rect.width, rect.height); ctx.imageSmoothingEnabled = true; }
        if (c.overlay?.shown && this.asset) {
          const place = computeOverlayRect(rect, g.crop || null, this.asset, c.overlay);
          if (place) {
            ctx.save(); ctx.beginPath(); ctx.rect(place.clip.x, place.clip.y, place.clip.width, place.clip.height); ctx.clip();
            ctx.globalAlpha = clamp(c.overlay.opacity ?? 0.5, 0, 1); ctx.drawImage(this.asset.image, place.x, place.y, place.width, place.height); ctx.restore();
            this.placed = place;
          }
        }
        let frame = rect;
        if (c.aspect?.shown) {
          const { rect: inner, mattes } = computeAspectRect(rect, c.aspect.ratio, c.aspect.orientation);
          ctx.fillStyle = `rgba(0,0,0,${clamp(c.aspect.matte ?? 0.65, 0, 1)})`;
          for (const m of mattes) ctx.fillRect(m.x, m.y, m.width, m.height);
          ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1 / dpr;
          ctx.strokeRect(crisp(inner.x, dpr), crisp(inner.y, dpr), Math.round(inner.width * dpr) / dpr, Math.round(inner.height * dpr) / dpr);
          frame = inner;
        }
        if (c.grid?.shown) this.drawGrid(ctx, frame, c.grid, dpr);
        ctx.restore();
      }
      drawGrid(ctx, rect, grid, dpr) {
        const [r, gr, b] = parseHex(grid.color || '#ffffff'), alpha = clamp(grid.opacity ?? 0.5, 0, 1);
        ctx.lineWidth = 1 / dpr; ctx.strokeStyle = `rgba(${r},${gr},${b},${alpha})`;
        ctx.beginPath();
        for (const line of computeGridLines(rect, grid.type === 'goldenSpiral' ? { type: 'none', guides: grid.guides } : grid)) {
          const vertical = line.x1 === line.x2;
          const x1 = vertical ? crisp(line.x1, dpr) : line.x1, y1 = vertical ? line.y1 : crisp(line.y1, dpr);
          ctx.moveTo(x1, y1); ctx.lineTo(vertical ? x1 : line.x2, vertical ? line.y2 : y1);
        }
        ctx.stroke();
        if (grid.type === 'goldenSpiral') {
          const spiral = computeGoldenSpiral(rect, { mirror: grid.mirror, clockwise: grid.clockwise !== false, minSize: 1 / dpr });
          ctx.lineWidth = 1.25 / dpr * Math.max(1, dpr); ctx.beginPath();
          for (const arc of spiral.arcs) { ctx.moveTo(arc.cx + arc.radius * Math.cos(arc.start), arc.cy + arc.radius * Math.sin(arc.start)); ctx.arc(arc.cx, arc.cy, arc.radius, arc.start, arc.end, arc.anticlockwise); }
          ctx.stroke();
        }
      }
      setMoving(on) {
        on = !!on && !!this.asset && !!this.config.overlay?.shown;
        this.moving = on; this.canvas.classList.toggle('moving', on);
        if (on) { this.canvas.tabIndex = 0; this.canvas.setAttribute('aria-hidden', 'false'); this.canvas.setAttribute('role', 'application'); this.canvas.setAttribute('aria-label', 'Move overlay image: drag or use arrow keys, Shift for larger steps, Escape to finish'); }
        else { this.canvas.removeAttribute('tabindex'); this.canvas.setAttribute('aria-hidden', 'true'); this.canvas.removeAttribute('role'); this.canvas.removeAttribute('aria-label'); }
        return on;
      }
      anchorSize() { const g = this.geometry(); const a = this.config.overlay?.followCrop && g?.crop ? g.crop : g?.rect; return a ? asRect(a) : null; }
      down(event) {
        if (!this.moving || event.button !== 0) return;
        event.preventDefault(); this.canvas.setPointerCapture(event.pointerId); this.canvas.focus();
        this.drag = { x: event.clientX, y: event.clientY, start: { x: this.config.overlay.x || 0, y: this.config.overlay.y || 0 } };
      }
      moveTo(event) {
        if (!this.drag) return; const a = this.anchorSize(); if (!a?.width) return;
        this.config.overlay.x = clamp(this.drag.start.x + (event.clientX - this.drag.x) / a.width, -1, 1);
        this.config.overlay.y = clamp(this.drag.start.y + (event.clientY - this.drag.y) / a.height, -1, 1);
        this.invalidate();
      }
      up() { if (!this.drag) return; this.drag = null; this.onMove?.({ x: this.config.overlay.x, y: this.config.overlay.y }); }
      nudge(event) {
        if (!this.moving) return;
        if (event.key === 'Escape' || event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); this.setMoving(false); this.onMove?.({ x: this.config.overlay.x, y: this.config.overlay.y }, true); return; }
        const step = event.shiftKey ? 0.1 : 0.01, d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
        if (!d) return;
        event.preventDefault(); event.stopPropagation();
        const o = this.config.overlay; o.x = clamp(Math.round(((o.x || 0) + d[0]) * 1000) / 1000, -1, 1); o.y = clamp(Math.round(((o.y || 0) + d[1]) * 1000) / 1000, -1, 1);
        this.invalidate(); this.onMove?.({ x: o.x, y: o.y });
      }
    }
    api.OverlayLayer = OverlayLayer;
  }

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PhotoCullOverlays = api;
})(typeof globalThis === 'object' ? globalThis : this);
