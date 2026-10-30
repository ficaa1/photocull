(function (root) {
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  function layout(image, view, zoomed, percent, center = { x: .5, y: .5 }) {
    if (!image.width || !image.height || !view.width || !view.height) return { width: 0, height: 0, left: 0, top: 0 };
    const scale = zoomed ? percent / 100 : Math.min(view.width / image.width, view.height / image.height, 1);
    const width = image.width * scale, height = image.height * scale;
    return { width, height,
      left: width <= view.width ? (view.width - width) / 2 : clamp(view.width / 2 - center.x * width, view.width - width, 0),
      top: height <= view.height ? (view.height - height) / 2 : clamp(view.height / 2 - center.y * height, view.height - height, 0) };
  }
  function pointInImage(position, box) {
    return { x: clamp((position.x - box.left) / box.width, 0, 1), y: clamp((position.y - box.top) / box.height, 0, 1) };
  }
  class ImageView {
    constructor(viewport, image, { onToggle = () => {} } = {}) {
      this.viewport = viewport; this.image = image; this.onToggle = onToggle;
      this.zoomed = false; this.percent = 100; this.center = { x: .5, y: .5 }; this.pointer = null;
      image.addEventListener('load', () => this.apply());
      new ResizeObserver(() => this.apply()).observe(viewport);
      viewport.addEventListener('pointerdown', event => this.down(event));
      viewport.addEventListener('pointermove', event => this.move(event));
      viewport.addEventListener('pointerup', event => this.up(event));
      viewport.addEventListener('pointercancel', () => this.cancel());
      viewport.addEventListener('lostpointercapture', () => this.cancel());
    }
    size() { return { width: this.viewport.clientWidth, height: this.viewport.clientHeight }; }
    dimensions() { return { width: this.image.naturalWidth, height: this.image.naturalHeight }; }
    box() { return layout(this.dimensions(), this.size(), this.zoomed, this.percent, this.center); }
    reset() { this.cancel(); this.center = { x: .5, y: .5 }; this.apply(); }
    setZoom(zoomed, percent, point) {
      this.cancel(); this.zoomed = zoomed; this.percent = percent;
      if (point) this.center = point;
      this.viewport.classList.toggle('zoomed', zoomed);
      this.viewport.setAttribute('aria-label', zoomed ? `${percent}% · drag to pan, click to fit` : 'Click to zoom');
      this.apply();
    }
    apply() {
      const box = this.box();
      Object.assign(this.image.style, { visibility: box.width ? 'visible' : 'hidden', width: `${box.width}px`, height: `${box.height}px`, transform: `translate(${box.left}px, ${box.top}px)` });
    }
    down(event) {
      if (event.button !== 0 || !event.isPrimary || !this.image.naturalWidth) return;
      const rect = this.viewport.getBoundingClientRect(), box = this.box();
      const position = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (position.x < box.left || position.x > box.left + box.width || position.y < box.top || position.y > box.top + box.height) return;
      this.pointer = { id: event.pointerId, startX: event.clientX, startY: event.clientY, box, point: pointInImage(position, box), moved: false };
      this.viewport.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
    move(event) {
      const pointer = this.pointer; if (!pointer || pointer.id !== event.pointerId) return;
      const dx = event.clientX - pointer.startX, dy = event.clientY - pointer.startY;
      if (Math.hypot(dx, dy) > 4) pointer.moved = true;
      if (!pointer.moved || !this.zoomed) return;
      this.viewport.classList.add('panning');
      const size = this.size();
      const left = pointer.box.width > size.width ? clamp(pointer.box.left + dx, size.width - pointer.box.width, 0) : pointer.box.left;
      const top = pointer.box.height > size.height ? clamp(pointer.box.top + dy, size.height - pointer.box.height, 0) : pointer.box.top;
      this.center = { x: (size.width / 2 - left) / pointer.box.width, y: (size.height / 2 - top) / pointer.box.height };
      this.apply();
    }
    up(event) {
      const pointer = this.pointer; if (!pointer || pointer.id !== event.pointerId) return;
      const click = !pointer.moved && Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) <= 4;
      this.cancel();
      if (click) this.onToggle(this.zoomed ? null : pointer.point);
    }
    cancel() {
      const pointer = this.pointer; this.pointer = null; this.viewport.classList.remove('panning');
      if (pointer && this.viewport.hasPointerCapture(pointer.id)) this.viewport.releasePointerCapture(pointer.id);
    }
  }
  const api = { layout, pointInImage, ImageView };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PhotoCullView = api;
})(globalThis);
