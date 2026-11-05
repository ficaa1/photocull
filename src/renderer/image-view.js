// Loupe geometry and the zoomable image viewport.
//
// Coordinates: `source` is the photo's real pixel size, `view` the viewport in
// CSS pixels. A zoom percentage is relative to the source's pixels on the
// physical display, so 100% shows one photo pixel per device pixel (Lightroom's
// 1:1) whatever the display scaling. A `box` is where the photo is drawn in the
// viewport; a `center` is the photo point (0–1 on each axis) at the middle of
// the viewport. Functions here are pure so tests can run them in Node; the
// ImageView class at the end applies them to the DOM.
(function (root) {
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const MAX_PERCENT = 1600;
  const ZOOM_LEVELS = [12.5, 25, 33.3, 50, 66.7, 100, 200, 300, 400, 800, 1600];
  const CLICK_ZOOMS = [100, 200, 300, 400, 800];
  const DRAG_THRESHOLD = 4;
  const ANIMATION_MS = 150;
  const valid = size => !!size && size.width > 0 && size.height > 0;

  // Fit never enlarges a photo past 100% when its real size is known.
  function fitScale(source, view, dpr = 1, exact = true) {
    if (!valid(source) || !valid(view)) return 0;
    const scale = Math.min(view.width / source.width, view.height / source.height);
    return exact ? Math.min(scale, 1 / dpr) : scale;
  }
  function fillScale(source, view) {
    if (!valid(source) || !valid(view)) return 0;
    return Math.max(view.width / source.width, view.height / source.height);
  }
  // zoom: { mode: 'fit' | 'fill' | 'ratio', percent }
  function scaleFor(zoom, source, view, dpr = 1, exact = true) {
    if (zoom.mode === 'fit') return fitScale(source, view, dpr, exact);
    if (zoom.mode === 'fill') return fillScale(source, view);
    return valid(source) ? zoom.percent / 100 / dpr : 0;
  }
  const percentOf = (scale, dpr = 1) => scale * dpr * 100;

  // An axis smaller than the viewport is centered; a larger one is clamped so
  // the photo never leaves the viewport.
  function axis(size, viewSize, center) {
    return size <= viewSize ? (viewSize - size) / 2 : clamp(viewSize / 2 - center * size, viewSize - size, 0);
  }
  function place(source, view, scale, center = { x: .5, y: .5 }) {
    if (!valid(source) || !valid(view) || !(scale > 0)) return { width: 0, height: 0, left: 0, top: 0 };
    const width = source.width * scale, height = source.height * scale;
    return { width, height, left: axis(width, view.width, center.x), top: axis(height, view.height, center.y) };
  }
  // Kept for callers that think in "zoomed at percent" terms (and older tests).
  function layout(source, view, zoomed, percent, center, dpr = 1) {
    return place(source, view, scaleFor(zoomed ? { mode: 'ratio', percent } : { mode: 'fit' }, source, view, dpr), center);
  }
  function centerOf(box, view) {
    return { x: (view.width / 2 - box.left) / box.width, y: (view.height / 2 - box.top) / box.height };
  }
  function clampCenter(source, view, scale, center) {
    const box = place(source, view, scale, center);
    return box.width ? centerOf(box, view) : { ...center };
  }
  function pointAt(position, box) { return { x: (position.x - box.left) / box.width, y: (position.y - box.top) / box.height }; }
  function pointInImage(position, box) { const p = pointAt(position, box); return { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) }; }
  function inside(position, box) {
    return box.width > 0 && position.x >= box.left && position.x <= box.left + box.width && position.y >= box.top && position.y <= box.top + box.height;
  }
  // Lightroom's default: the photo point under `anchor` stays under it.
  function zoomAround(source, view, from, toScale, anchor) {
    const point = pointInImage(anchor, from);
    const width = source.width * toScale, height = source.height * toScale;
    const left = anchor.x - point.x * width, top = anchor.y - point.y * height;
    return clampCenter(source, view, toScale, { x: (view.width / 2 - left) / width, y: (view.height / 2 - top) / height });
  }
  // "Zoom clicked point to center": the clicked photo point moves to the middle.
  function centerOn(source, view, toScale, point) { return clampCenter(source, view, toScale, point); }
  function panCenter(source, view, box, dx, dy) {
    return clampCenter(source, view, box.width / source.width, centerOf({ ...box, left: box.left + dx, top: box.top + dy }, view));
  }
  const isDrag = (dx, dy, threshold = DRAG_THRESHOLD) => Math.hypot(dx, dy) > threshold;

  // Ctrl/Cmd +/- step through ZOOM_LEVELS above Fit. Returns a percent, or
  // null for Fit.
  function stepPercent(current, direction, fitPercent) {
    if (direction > 0) {
      const next = ZOOM_LEVELS.find(level => level > Math.max(current, fitPercent) * 1.001);
      return next ?? MAX_PERCENT;
    }
    const lower = ZOOM_LEVELS.toReversed().find(level => level < current / 1.001);
    return lower === undefined || lower <= fitPercent * 1.001 ? null : lower;
  }
  // Continuous Ctrl+wheel / pinch zoom, clamped to Fit…1600%. Returns null for Fit.
  function wheelDelta(event) {
    const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
    return { x: event.deltaX * unit, y: event.deltaY * unit };
  }
  function wheelPercent(current, deltaY, fitPercent) {
    const next = clamp(current * Math.exp(-clamp(deltaY, -250, 250) * .004), fitPercent, MAX_PERCENT);
    return next <= fitPercent * 1.0005 ? null : next;
  }
  // The visible part of the photo, normalized, for the navigator rectangle.
  function visibleRect(box, view) {
    if (!box.width) return { x: 0, y: 0, width: 1, height: 1 };
    const x0 = clamp(-box.left / box.width, 0, 1), y0 = clamp(-box.top / box.height, 0, 1);
    const x1 = clamp((view.width - box.left) / box.width, 0, 1), y1 = clamp((view.height - box.top) / box.height, 0, 1);
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }
  const ease = t => 1 - (1 - t) ** 3;
  const mix = (a, b, t) => ({ width: a.width + (b.width - a.width) * t, height: a.height + (b.height - a.height) * t, left: a.left + (b.left - a.left) * t, top: a.top + (b.top - a.top) * t });

  class ImageView {
    // onClick({ position, inside }) for a press released without dragging;
    // onChange() after any zoom/pan; onHandUse() when the Space hand is used.
    constructor(viewport, image, { onClick = () => {}, onChange = () => {}, onHandUse = () => {} } = {}) {
      this.viewport = viewport; this.image = image;
      this.onClick = onClick; this.onChange = onChange; this.onHandUse = onHandUse;
      this.zoom = { mode: 'fit', percent: 100 }; this.center = { x: .5, y: .5 };
      this.source = null; this.exact = false; this.visible = false;
      this.pointer = null; this.hover = null; this.hand = false; this.animation = null; this.drawn = null;
      this.reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: true };
      new ResizeObserver(() => { this.apply(); this.onChange(); }).observe(viewport);
      viewport.addEventListener('pointerdown', event => this.down(event));
      viewport.addEventListener('pointermove', event => this.move(event));
      viewport.addEventListener('pointerup', event => this.up(event));
      viewport.addEventListener('pointercancel', () => this.cancel());
      viewport.addEventListener('lostpointercapture', () => this.cancel());
      viewport.addEventListener('pointerleave', () => { if (!this.pointer) this.hover = null; });
      viewport.addEventListener('wheel', event => this.wheel(event), { passive: false });
      // WKWebView (macOS) reports trackpad pinch as gesture events instead of Ctrl+wheel.
      viewport.addEventListener('gesturestart', event => { event.preventDefault(); this.gesture = this.percent(); });
      viewport.addEventListener('gesturechange', event => {
        event.preventDefault(); if (!this.gesture) return;
        const fit = this.fitPercent(), percent = Math.min(MAX_PERCENT, this.gesture * event.scale);
        if (percent <= fit * 1.0005) this.set({ mode: 'fit', percent: this.zoom.percent });
        else this.set({ mode: 'ratio', percent }, { anchor: this.position(event) });
      });
      viewport.addEventListener('gestureend', () => { this.gesture = null; });
    }
    dpr() { return (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1; }
    size() { return { width: this.viewport.clientWidth, height: this.viewport.clientHeight }; }
    scale(zoom = this.zoom) { return scaleFor(zoom, this.source, this.size(), this.dpr(), this.exact); }
    box(zoom = this.zoom, center = this.center) { return place(this.source, this.size(), this.scale(zoom), center); }
    percent() { return this.zoom.mode === 'ratio' ? this.zoom.percent : percentOf(this.scale(), this.dpr()); }
    fitPercent() { return percentOf(this.scale({ mode: 'fit' }), this.dpr()); }
    get zoomed() { return this.zoom.mode !== 'fit'; }
    pannable() { const box = this.box(), size = this.size(); return box.width > size.width + .5 || box.height > size.height + .5; }
    position(event) { const rect = this.viewport.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
    // Hover position if the pointer is over the photo, for keyboard zoom.
    anchor() { return this.hover && inside(this.hover, this.box()) ? { ...this.hover } : null; }

    // size: the photo's pixel dimensions. exact: they are its real size (so
    // Fit must not enlarge it), not just a stand-in preview's.
    setSource(size, exact = false) {
      const same = this.source && size && this.source.width === size.width && this.source.height === size.height && this.exact === exact;
      this.source = valid(size) ? { width: size.width, height: size.height } : null; this.exact = !!exact;
      if (!same) this.apply();
    }
    setVisible(visible) { if (this.visible !== visible) { this.visible = visible; this.apply(); } }
    setHand(on) { this.hand = on; this.viewport.classList.toggle('hand', on); }
    reset() { this.cancel(); this.finish(); this.zoom = { mode: 'fit', percent: this.zoom.percent }; this.center = { x: .5, y: .5 }; this.apply(); this.onChange(); }

    // Moves to `zoom`. anchor: keep the photo point under this viewport
    // position; centerOn: put this photo point in the middle; center: use this
    // view center; otherwise keep the current center.
    set(zoom, { anchor, centerOn: point, center, animate = false } = {}) {
      const from = this.drawn && this.visible ? { ...this.drawn } : null;
      this.finish();
      if (this.source) {
        const size = this.size(), scale = scaleFor(zoom, this.source, size, this.dpr(), this.exact);
        let next = center || this.center;
        if (point) next = centerOn(this.source, size, scale, point);
        else if (anchor) next = zoomAround(this.source, size, this.box(), scale, anchor);
        else next = clampCenter(this.source, size, scale, next);
        // Fit ignores the center; keeping it lets the next zoom return to the same spot.
        if (zoom.mode !== 'fit' || point || anchor || center) this.center = next;
      } else if (point || center) this.center = { ...(point || center) };
      this.zoom = { mode: zoom.mode, percent: zoom.percent };
      this.apply(animate && from ? from : null);
      this.onChange();
    }
    apply(from = null) {
      if (!from) this.finish();
      const box = this.box();
      const zoomed = this.zoomed;
      this.viewport.classList.toggle('zoomed', zoomed);
      this.viewport.classList.toggle('pannable', this.pannable());
      if (!this.visible || !box.width) { this.image.style.visibility = 'hidden'; this.drawn = null; return; }
      if (from && !this.reduced.matches && (Math.abs(from.width - box.width) > 1 || Math.abs(from.left - box.left) > 1 || Math.abs(from.top - box.top) > 1)) this.animate(from, box);
      else this.draw(box);
    }
    draw(box, frame = box) {
      // During animation the element keeps its final size and a scale
      // transform moves it, which the compositor can do without re-rasterizing.
      const style = this.image.style;
      style.visibility = 'visible'; style.transformOrigin = '0 0';
      style.width = `${box.width}px`; style.height = `${box.height}px`;
      const scale = frame === box ? '' : ` scale(${frame.width / box.width}, ${frame.height / box.height})`;
      style.transform = `translate(${frame.left}px, ${frame.top}px)${scale}`;
      this.drawn = frame;
    }
    animate(from, to) {
      const start = performance.now();
      this.viewport.classList.add('animating');
      const step = now => {
        const t = Math.min(1, (now - start) / ANIMATION_MS);
        this.draw(to, t < 1 ? mix(from, to, ease(t)) : to);
        if (t < 1) this.animation = { frame: requestAnimationFrame(step), to }; else this.finish();
      };
      this.animation = { frame: requestAnimationFrame(step), to };
      this.draw(to, from);
    }
    finish() {
      if (!this.animation) return;
      cancelAnimationFrame(this.animation.frame);
      const to = this.animation.to; this.animation = null;
      this.viewport.classList.remove('animating');
      this.draw(to);
    }

    down(event) {
      if (event.button !== 0 || !event.isPrimary || !this.source || !this.visible) return;
      this.finish();
      const position = this.position(event), box = this.box();
      if (this.hand) this.onHandUse();
      this.pointer = { id: event.pointerId, startX: event.clientX, startY: event.clientY, box, position, inside: inside(position, box), moved: false };
      this.viewport.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
    move(event) {
      this.hover = this.position(event);
      const pointer = this.pointer; if (!pointer || pointer.id !== event.pointerId) return;
      const dx = event.clientX - pointer.startX, dy = event.clientY - pointer.startY;
      if (!pointer.moved && isDrag(dx, dy)) pointer.moved = true;
      if (!pointer.moved || !this.pannable()) return;
      this.viewport.classList.add('panning');
      this.center = panCenter(this.source, this.size(), pointer.box, dx, dy);
      this.draw(this.box());
      this.onChange();
    }
    up(event) {
      const pointer = this.pointer; if (!pointer || pointer.id !== event.pointerId) return;
      const click = !pointer.moved && !isDrag(event.clientX - pointer.startX, event.clientY - pointer.startY);
      this.cancel();
      if (click && !this.hand) this.onClick({ position: pointer.position, inside: pointer.inside });
    }
    cancel() {
      const pointer = this.pointer; this.pointer = null; this.viewport.classList.remove('panning');
      if (pointer && this.viewport.hasPointerCapture(pointer.id)) this.viewport.releasePointerCapture(pointer.id);
    }
    wheel(event) {
      if (!this.source || !this.visible) return;
      const delta = wheelDelta(event);
      if (event.ctrlKey || event.metaKey) {
        // Ctrl+wheel, and trackpad pinch (which browsers report as Ctrl+wheel).
        event.preventDefault();
        const percent = wheelPercent(this.percent(), delta.y, this.fitPercent());
        if (percent === null) { if (this.zoomed) this.set({ mode: 'fit', percent: this.zoom.percent }); }
        else this.set({ mode: 'ratio', percent }, { anchor: this.position(event) });
      } else if (this.pannable()) {
        // Two-finger trackpad scroll (or the mouse wheel) pans a zoomed photo.
        event.preventDefault(); this.finish();
        this.center = panCenter(this.source, this.size(), this.box(), -delta.x, -delta.y);
        this.draw(this.box());
        this.onChange();
      }
      // At Fit a plain wheel does nothing: it never changes photos.
    }
  }

  const api = { MAX_PERCENT, ZOOM_LEVELS, CLICK_ZOOMS, DRAG_THRESHOLD, ANIMATION_MS, fitScale, fillScale, scaleFor, percentOf, place, layout, centerOf, clampCenter,
    pointAt, pointInImage, inside, zoomAround, centerOn, panCenter, isDrag, stepPercent, wheelDelta, wheelPercent, visibleRect, ImageView };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PhotoCullView = api;
})(globalThis);
