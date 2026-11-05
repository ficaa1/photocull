// The single-photo view (review `E` and fullscreen `F`), modelled on
// Lightroom Classic's loupe:
//   - Fit, Fill and a chosen click-zoom ratio; percentages are of the photo's
//     real pixels (see image-view.js).
//   - Click zooms keeping the clicked point under the pointer (or centres it,
//     Settings → General → "Zoom clicked point to center"); a click on a
//     zoomed photo returns to Fit/Fill; a press that moves more than 4 px pans.
//   - Z / Space toggle; holding Space while zoomed is a temporary hand;
//     Ctrl/Cmd +/- step, Ctrl/Cmd 0 fits; Ctrl+wheel or pinch zooms around the
//     pointer; two-finger scroll pans.
//   - A navigator mini-map; zoom level and position carry over to the next photo.
// It also decides which representation to load: the thumbnail (400 px), the
// fit preview (2560 px) or the full-size image. Anything already loaded that is
// at least as large as the drawn size is reused (scaled down, never up), the
// best available one stands in while a larger one loads, fit previews are
// prepared ahead in the direction of travel, and while arrow keys are held the
// expensive request for each passing photo waits until it has been shown
// briefly.
(function (root) {
  const View = typeof module !== 'undefined' && module.exports ? require('./image-view.js') : root.PhotoCullView;
  const KIND_RANK = { thumb: 0, preview: 1, full: 2 };
  const PREVIEW_EDGE = 2560;
  const AHEAD = 5, BEHIND = 1;
  const RAPID_MS = 250, SETTLE_MS = 120;
  const PREFETCH_LIMIT = 2;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const longEdge = size => size ? Math.max(size.width || 0, size.height || 0) : 0;

  // Indices to prepare: the next `ahead` photos in the direction of travel,
  // then `behind` photos the other way, nearest first.
  function prepareAhead(count, index, direction = 1, ahead = AHEAD, behind = BEHIND) {
    const step = direction < 0 ? -1 : 1, result = [];
    for (let i = 1; i <= ahead; i++) { const n = index + step * i; if (n >= 0 && n < count) result.push(n); }
    for (let i = 1; i <= behind; i++) { const n = index - step * i; if (n >= 0 && n < count) result.push(n); }
    return result;
  }
  function travel(previous, index, direction = 1) {
    return previous < 0 || previous === index ? direction : index > previous ? 1 : -1;
  }
  // Leaving the previous photo within RAPID_MS means keys are being held or
  // tapped quickly.
  const isRapid = (now, lastChange, rapidMs = RAPID_MS) => now - lastChange < rapidMs;
  const neededKind = edge => edge > PREVIEW_EDGE ? 'full' : 'preview';
  // Picks what to draw for `needed` device pixels on the long edge, where
  // `want` is the kind that would be requested for that size. A
  // representation is adequate if it is at least as large as the drawn size,
  // (practically) the photo's real size, or of the wanted kind or a larger one
  // (nothing bigger can be obtained for this zoom, e.g. a RAW whose only
  // embedded image is small). The current one is kept while adequate;
  // otherwise the smallest adequate one; otherwise the largest available
  // stands in.
  function chooseRepresentation(reps, needed, sourceEdge = 0, current = null, want = neededKind(needed)) {
    const adequate = rep => KIND_RANK[rep.kind] >= KIND_RANK[want] || longEdge(rep) >= needed - .5 || (sourceEdge > 0 && longEdge(rep) >= sourceEdge * .98);
    if (current && reps.includes(current) && adequate(current)) return { show: current, adequate: true };
    const fitting = reps.filter(adequate).sort((a, b) => longEdge(a) - longEdge(b));
    if (fitting.length) return { show: fitting[0], adequate: true };
    return { show: reps.reduce((best, rep) => !best || longEdge(rep) > longEdge(best) ? rep : best, null), adequate: false };
  }
  // True when the pixels on screen are the camera's own JPEG (embedded in the
  // RAW, or its companion file) rather than a development of the sensor data.
  const cameraPixels = (item, info) => !!item?.raw && !!info && (info.type === 'embedded' || info.type === 'companion');
  function cameraTooltip(info) {
    const size = info.width && info.height ? `, ${info.width} × ${info.height}` : '';
    const what = info.type === 'companion' ? `the JPEG your camera saved next to this RAW${size}` : `the JPEG preview your camera embedded in this RAW file (${info.tag || 'embedded'}${size})`;
    return `Showing ${what}, not a development of the RAW sensor data. Colour, contrast, sharpening and noise reduction are the camera's, so an editor's RAW conversion will look different.${info.limited ? ' It is smaller than the photo, so larger zoom levels enlarge it.' : ''}`;
  }
  function formatPercent(percent) {
    if (!(percent > 0)) return '';
    const rounded = Math.round(percent);
    return Math.abs(percent - rounded) < .05 || percent >= 100 ? `${rounded}%` : `${percent.toFixed(1)}%`;
  }
  // Maps a keydown to a loupe action, or null if the loupe does not use it.
  function keyAction(event) {
    const command = event.ctrlKey || event.metaKey;
    if (command && !event.altKey) {
      if (['+', '='].includes(event.key) || ['Equal', 'NumpadAdd'].includes(event.code)) return 'zoom-in';
      if (['-', '_'].includes(event.key) || ['Minus', 'NumpadSubtract'].includes(event.code)) return 'zoom-out';
      if (event.key === '0' || ['Digit0', 'Numpad0'].includes(event.code)) return 'fit';
      return null;
    }
    if (command || event.altKey) return null;
    if (event.key === ' ') return 'space';
    if (event.key === 'z' || event.key === 'Z') return 'toggle';
    return null;
  }

  // Loads low-priority images in order, at most `limit` at once (so prefetches
  // never occupy all of the browser's connections), and abandons those no
  // longer wanted.
  class Prefetcher {
    constructor(limit = PREFETCH_LIMIT, onLoad = () => {}, createImage = () => new Image()) {
      this.limit = limit; this.onLoad = onLoad; this.createImage = createImage;
      this.queue = []; this.active = new Map();
    }
    set(jobs) {
      const wanted = new Set(jobs.map(job => job.key));
      for (const [key, image] of this.active) {
        if (wanted.has(key)) continue;
        image.onload = image.onerror = null; image.removeAttribute?.('src'); this.active.delete(key);
      }
      this.queue = jobs.filter(job => !this.active.has(job.key));
      this.pump();
    }
    pump() {
      while (this.active.size < this.limit && this.queue.length) {
        const job = this.queue.shift(), image = this.createImage();
        this.active.set(job.key, image);
        const done = ok => {
          if (this.active.get(job.key) !== image) return;
          this.active.delete(job.key);
          if (ok) this.onLoad(job, image);
          this.pump();
        };
        image.onload = () => done(true); image.onerror = () => done(false);
        image.src = job.url;
      }
    }
  }

  class Loupe {
    // elements: viewport, image, loading, error, retry, previewSource,
    //   previewStatus, cameraBadge, zoomFit, zoomFill, zoomPercent, zoomLevel,
    //   navigator, navigatorImage, navigatorView, navigatorPanel, navigatorDock,
    //   navigatorOverlay, navigatorZoom, inspector
    // imageUrl(item, kind, extraQuery); context() → { session, items, mode,
    //   revision, fullscreen }; settings() → { zoomClickCenter };
    // onLoaded(item) once the needed pixels are on screen;
    // onClickZoomChange(percent) when the user picks a click-zoom ratio.
    constructor({ api, elements, imageUrl, context, settings = () => ({}), onLoaded = () => {}, onClickZoomChange = () => {}, createImage = () => new Image() }) {
      Object.assign(this, { api, el: elements, imageUrl, context, settings, onLoaded, onClickZoomChange, createImage });
      this.base = 'fit'; this.clickPercent = 100;
      this.item = null; this.shown = null; this.generation = 0; this.timer = null;
      this.reps = new Map(); this.dims = new Map(); this.dimRequests = new Set(); this.inflight = new Set();
      this.direction = 1; this.lastId = null; this.lastChange = -Infinity; this.rapid = false; this.ahead = [];
      this.space = null; this.navPointer = null;
      this.prefetcher = new Prefetcher(PREFETCH_LIMIT, (job, image) => this.prefetched(job, image), createImage);
      this.view = new View.ImageView(elements.viewport, elements.image, {
        onClick: event => this.click(event), onChange: () => this.changed(), onHandUse: () => { if (this.space) this.space.used = true; } });
      this.bindControls(); this.bindNavigator();
    }
    get zoomed() { return this.view.zoomed; }
    // The representation kind the inspector should describe.
    kind() { return this.shown?.kind === 'full' || this.want() === 'full' ? 'full' : 'preview'; }

    // Called whenever the current photo is (re)selected, in any view. Tracks
    // the direction of travel and whether keys are being held; returns the ids
    // to prepare, nearest first.
    select(items, index, now = performance.now()) {
      const item = items[index]; if (!item) return [];
      if (item.id !== this.lastId) {
        const previous = this.lastId === null ? -1 : items.findIndex(i => i.id === this.lastId);
        this.direction = travel(previous, index, this.direction);
        this.rapid = isRapid(now, this.lastChange);
        this.lastChange = now; this.lastId = item.id;
      }
      this.ahead = prepareAhead(items.length, index, this.direction).map(i => items[i].id);
      return this.ahead;
    }

    show(item) {
      const ctx = this.context(); if (!ctx.session || !item) return;
      const target = this.el.image;
      const changed = this.item?.id !== item.id || target.dataset.itemId !== item.id;
      if (changed) {
        this.abandon(item.id);
        this.item = item; this.shown = null; target.dataset.itemId = item.id;
        this.badge(null);
        this.requestDims(ctx, item);
      }
      this.updateSource();
      const want = this.want(), stamp = `${ctx.session.id}:${item.id}:${want}:${ctx.revision}`;
      if (target.dataset.stamp === stamp && (target.dataset.complete || Number(target.dataset.generation) === this.generation)) { this.renderControls(); this.renderNavigator(); return; }
      const generation = ++this.generation;
      target.dataset.generation = generation; target.dataset.stamp = stamp; delete target.dataset.complete;
      clearTimeout(this.timer);
      target.alt = item.name;
      this.el.error.hidden = true; this.el.retry.hidden = true;
      if (changed) this.el.previewSource.textContent = item.raw ? 'Finding RAW preview…' : 'Original image';
      const choice = chooseRepresentation(this.repList(item.id), this.neededEdge(), this.sourceEdge(item), this.shown, this.want());
      if (choice.show) this.display(item, choice.show);
      else if (changed) { target.removeAttribute('src'); this.view.setVisible(false); }
      this.renderControls(); this.renderNavigator();
      if (choice.adequate) { this.complete(item); return; }
      this.el.loading.hidden = false;
      this.el.loading.textContent = want === 'full' ? 'Loading full image…' : 'Loading preview…';
      if (!choice.show && !this.has(item.id, 'thumb')) this.load(item, 'thumb');
      const fetch = () => { if (generation === this.generation && !target.dataset.complete) this.load(item, want); };
      // Held arrow keys: show what is cached at once, but only start
      // generating this photo's preview once it has stayed for SETTLE_MS.
      if (changed && this.rapid && performance.now() - this.lastChange < RAPID_MS) { this.load(item, want, '&cached=1', true); this.timer = setTimeout(fetch, SETTLE_MS); }
      else fetch();
      this.prepare(ctx, item);
    }
    refresh() { if (this.item && this.context().mode === 'review') { this.show(this.item); this.offer(this.item); } }
    load(item, kind, extra = '', probe = false) {
      const key = `${item.id}:${kind}${probe ? ':probe' : ''}`;
      for (const job of this.inflight) if (job.key === key) return;
      const image = this.createImage(), job = { key, id: item.id, image };
      const url = this.imageUrl(item, kind, extra);
      this.inflight.add(job);
      image.onload = async () => {
        this.inflight.delete(job);
        // Decode before swapping so a large image never flashes blank.
        if (!probe && this.item?.id === item.id && image.decode) { try { await image.decode(); } catch { /* Shown undecoded. */ } }
        this.store(item.id, { kind, url, width: image.naturalWidth, height: image.naturalHeight });
        this.offer(item);
      };
      image.onerror = () => {
        this.inflight.delete(job);
        if (probe || kind === 'thumb' || this.item?.id !== item.id || this.el.image.dataset.complete || this.want() !== kind) return;
        this.failed(item);
      };
      image.src = url;
    }
    // Stops loading photos that are no longer shown (prefetching continues separately).
    abandon(id) {
      for (const job of this.inflight) {
        if (job.id === id) continue;
        job.image.onload = job.image.onerror = null; job.image.removeAttribute?.('src'); this.inflight.delete(job);
      }
    }
    store(id, rep) {
      if (!this.reps.has(id)) this.reps.set(id, new Map());
      const reps = this.reps.get(id);
      if (!reps.has(rep.kind) && rep.width) reps.set(rep.kind, rep);
    }
    has(id, kind) { return !!this.reps.get(id)?.has(kind); }
    hasAtLeast(id, kind) { return this.repList(id).some(rep => KIND_RANK[rep.kind] >= KIND_RANK[kind]); }
    repList(id) { return [...(this.reps.get(id)?.values() ?? [])]; }
    offer(item) {
      if (this.item?.id !== item.id) return;
      this.updateSource();
      const choice = chooseRepresentation(this.repList(item.id), this.neededEdge(), this.sourceEdge(item), this.shown, this.want());
      if (choice.show && choice.show !== this.shown) this.display(item, choice.show);
      if (choice.adequate && !this.el.image.dataset.complete) this.complete(item);
    }
    display(item, rep) {
      this.shown = rep;
      if (this.el.image.getAttribute('src') !== rep.url) this.el.image.src = rep.url;
      this.el.image.dataset.kind = rep.kind;
      this.updateSource(); this.view.setVisible(true);
      if (rep.info) this.badge(rep.info, item);
      else if (item.raw && rep.kind !== 'thumb' && !rep.asked) { rep.asked = true; void this.status(item, rep.kind, false, false); }
      this.renderNavigator();
    }
    complete(item) {
      this.el.image.dataset.complete = 'yes';
      this.el.loading.hidden = true; this.el.previewStatus.textContent = '';
      clearTimeout(this.timer);
      this.onLoaded(item);
      void this.status(item, this.shown?.kind === 'full' ? 'full' : this.want());
      this.prepare(this.context(), item);
    }
    failed(item) {
      this.el.loading.hidden = true; this.el.retry.hidden = false;
      if (this.shown) this.el.previewStatus.textContent = 'Larger preview unavailable';
      else { this.el.error.hidden = false; this.el.error.textContent = 'Preview unavailable'; }
      void this.status(item, this.want(), true);
    }
    // Reuses the backend's description of a representation for the source
    // chip, the inspector and the "Camera preview" badge.
    async status(item, kind, failed = false, describe = true) {
      const session = this.context().session?.id;
      try {
        const status = await this.api.previewStatus(session, item.id, kind);
        if (this.item?.id !== item.id) return;
        if (failed) {
          if (this.shown) this.el.previewStatus.textContent = status.error ? `Larger preview unavailable · ${status.error}` : 'Larger preview unavailable';
          else this.el.error.textContent = status.error || 'Preview unavailable';
          return;
        }
        const info = status.info; if (!info) return;
        const rep = this.reps.get(item.id)?.get(kind);
        if (rep) rep.info = info;
        if (rep && rep === this.shown) this.badge(info, item);
        if (!describe) return;
        this.el.previewSource.textContent = `${info.source}${info.cached ? ' · cached' : ''}`;
        if (info.limited) this.el.previewStatus.textContent = 'Limited resolution';
        this.el.retry.hidden = !info.renderError;
        if (info.renderError) this.el.previewStatus.textContent = 'Using smaller preview · RAW render failed';
      } catch { /* The session may have changed during navigation. */ }
    }
    badge(info, item = this.item) {
      const badge = this.el.cameraBadge; if (!badge) return;
      const camera = cameraPixels(item, info);
      badge.hidden = !camera;
      if (camera) { badge.title = cameraTooltip(info); badge.setAttribute('aria-label', `Camera preview. ${badge.title}`); }
    }
    // Real photo size from the backend (preview-status reports it), for this
    // photo and the next one, unless a loaded full-size image is larger (some
    // RAW renders include a few extra edge pixels).
    requestDims(ctx, item) {
      const session = ctx.session.id;
      for (const id of [item.id, this.ahead[0]]) {
        if (!id || this.dims.has(id) || this.dimRequests.has(id)) continue;
        this.dimRequests.add(id);
        this.api.previewStatus(session, id, 'preview').then(status => {
          this.dimRequests.delete(id);
          if (this.context().session?.id !== session) return;
          this.dims.set(id, status?.size?.width && status.size.height ? status.size : null);
          if (this.item?.id === id) this.refresh();
        }, () => this.dimRequests.delete(id));
      }
    }
    sourceFor(item) {
      const known = this.dims.get(item.id), reps = this.repList(item.id);
      const full = reps.find(rep => rep.kind === 'full');
      if (full && (!known || longEdge(full) > longEdge(known))) return { size: full, exact: true };
      if (known) return { size: known, exact: true };
      const largest = reps.reduce((best, rep) => !best || longEdge(rep) > longEdge(best) ? rep : best, null);
      return largest ? { size: largest, exact: false } : null;
    }
    sourceEdge(item) { const source = this.sourceFor(item); return source?.exact ? longEdge(source.size) : 0; }
    updateSource() { const source = this.item && this.sourceFor(this.item); this.view.setSource(source?.size ?? null, source?.exact ?? false); }
    neededEdge() { return longEdge(this.view.box()) * this.view.dpr(); }
    want() { return !this.view.source && this.view.zoomed ? 'full' : neededKind(this.neededEdge()); }

    // Prepares fit-size previews ahead in the direction of travel, at low priority.
    prepare(ctx, item) {
      const items = ctx.items || [], index = items.findIndex(i => i.id === item.id);
      if (index < 0 || ctx.mode !== 'review') { this.prefetcher.set([]); return; }
      const order = prepareAhead(items.length, index, this.direction).map(i => items[i]);
      // Full-size images are large (and may need RAW development), so only the
      // next one is prepared, and only when this view needs full size (zoomed,
      // or Fit on a very large display). The fit previews then stand in.
      const jobs = [];
      if (this.want() === 'full' && this.el.image.dataset.complete && order[0]) jobs.push({ item: order[0], kind: 'full' });
      for (const neighbor of order) jobs.push({ item: neighbor, kind: 'preview' });
      this.prefetcher.set(jobs.filter(job => !this.hasAtLeast(job.item.id, job.kind))
        .map((job, rank) => ({ ...job, key: `${job.item.id}:${job.kind}`, url: this.imageUrl(job.item, job.kind, `&prefetch=${rank + 1}`) })));
      const keep = new Set([item.id, ...order.map(i => i.id)]);
      for (const id of this.reps.keys()) if (!keep.has(id)) this.reps.delete(id);
    }
    prefetched(job, image) {
      this.store(job.item.id, { kind: job.kind, url: job.url, width: image.naturalWidth, height: image.naturalHeight });
      if (this.item?.id === job.item.id) this.offer(this.item);
    }

    click({ position, inside }) {
      if (this.view.zoom.mode === 'ratio') { this.toggle(null); return; }
      if (inside) this.zoomToRatio(this.clickPercent, position);
    }
    // Fit/Fill ↔ click zoom. anchor: viewport position to zoom around (the
    // pointer); without it the last zoomed position is used.
    toggle(anchor) {
      if (this.view.zoom.mode === 'ratio') this.view.set({ mode: this.base, percent: this.view.zoom.percent }, { animate: true });
      else this.zoomToRatio(this.clickPercent, anchor);
    }
    zoomToRatio(percent, anchor) {
      const zoom = { mode: 'ratio', percent };
      if (anchor && this.settings()?.zoomClickCenter && this.view.source) this.view.set(zoom, { centerOn: View.pointInImage(anchor, this.view.box()), animate: true });
      else if (anchor) this.view.set(zoom, { anchor, animate: true });
      else if (this.view.zoomed) this.view.set(zoom, { anchor: this.viewCenter(), animate: true });
      else this.view.set(zoom, { animate: true });
    }
    zoomIn() { if (!this.view.zoomed) this.zoomToRatio(this.clickPercent, null); }
    setMode(mode) { this.base = mode; this.view.set({ mode, percent: this.view.zoom.percent }, { animate: true }); }
    fit() { this.setMode('fit'); }
    step(direction) {
      const next = View.stepPercent(this.view.percent(), direction, this.view.fitPercent());
      if (next === null) { if (this.view.zoomed) this.fit(); return; }
      this.view.set({ mode: 'ratio', percent: next }, { anchor: this.viewCenter(), animate: true });
    }
    viewCenter() { const size = this.view.size(); return { x: size.width / 2, y: size.height / 2 }; }
    setClickPercent(percent, select = true) {
      this.clickPercent = percent;
      const menu = this.el.zoomPercent;
      if (![...menu.options].some(option => Number(option.value) === percent)) {
        const option = document.createElement('option'); option.value = String(percent); option.textContent = formatPercent(percent); menu.append(option);
      }
      if (select) menu.value = [...menu.options].find(option => Number(option.value) === percent).value;
    }

    // Returns true if the loupe handled the key.
    handleKey(event) {
      const action = keyAction(event); if (!action) return false;
      event.preventDefault();
      if (action === 'zoom-in') this.step(1);
      else if (action === 'zoom-out') this.step(-1);
      else if (action === 'fit') this.fit();
      else if (event.repeat) return true;
      else if (action === 'toggle') this.toggle(this.view.anchor());
      else if (action === 'space') {
        // Zoomed: Space is a temporary hand until released; a release without
        // dragging toggles back. At Fit it zooms at once.
        if (this.view.zoom.mode === 'ratio' && this.view.pannable()) { this.space = { used: false }; this.view.setHand(true); }
        else { this.space = { used: true }; this.toggle(this.view.anchor()); }
      }
      return true;
    }
    handleKeyUp(event) {
      if (event.key !== ' ' || !this.space) return false;
      const space = this.space; this.cancelHand();
      if (!space.used) this.toggle(null);
      return true;
    }
    cancelHand() { this.space = null; this.view.setHand(false); }

    bindControls() {
      const el = this.el;
      el.zoomFit.onclick = () => { el.zoomFit.blur(); this.fit(); };
      el.zoomFill.onclick = () => { el.zoomFill.blur(); this.setMode('fill'); };
      el.zoomPercent.onchange = () => {
        const percent = Number(el.zoomPercent.value); el.zoomPercent.blur();
        this.setClickPercent(percent); this.zoomToRatio(percent, null); this.onClickZoomChange(percent);
      };
      el.viewport.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); this.toggle(null); } });
    }
    bindNavigator() {
      const nav = this.el.navigator; if (!nav) return;
      nav.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !this.view.source) return;
        event.preventDefault(); nav.setPointerCapture(event.pointerId); this.navPointer = event.pointerId;
        this.navigate(this.navPoint(event), true);
      });
      nav.addEventListener('pointermove', event => { if (this.navPointer === event.pointerId) this.navigate(this.navPoint(event), false); });
      const end = event => { if (this.navPointer === event.pointerId) this.navPointer = null; };
      nav.addEventListener('pointerup', end); nav.addEventListener('pointercancel', end); nav.addEventListener('lostpointercapture', end);
    }
    navRect() {
      const nav = this.el.navigator, source = this.view.source, width = nav.clientWidth, height = nav.clientHeight;
      if (!source || !width || !height) return null;
      const scale = Math.min(width / source.width, height / source.height), w = source.width * scale, h = source.height * scale;
      return { left: (width - w) / 2, top: (height - h) / 2, width: w, height: h };
    }
    navPoint(event) {
      const rect = this.navRect(), bounds = this.el.navigator.getBoundingClientRect();
      if (!rect) return { x: .5, y: .5 };
      return { x: clamp((event.clientX - bounds.left - rect.left) / rect.width, 0, 1), y: clamp((event.clientY - bounds.top - rect.top) / rect.height, 0, 1) };
    }
    // Lightroom's Navigator: at Fit a click zooms there; when zoomed, click or
    // drag moves the view.
    navigate(point, start) {
      if (!this.view.zoomed) { if (start) this.view.set({ mode: 'ratio', percent: this.clickPercent }, { centerOn: point, animate: true }); return; }
      this.view.set(this.view.zoom, { centerOn: point, animate: start });
    }
    docked() { const inspector = this.el.inspector; return !!inspector && !this.context().fullscreen && inspector.offsetParent !== null; }
    renderNavigator() {
      const el = this.el; if (!el.navigator) return;
      const active = this.context().mode === 'review' && !!this.item, docked = this.docked();
      const host = docked ? el.navigatorDock : el.navigatorOverlay;
      if (el.navigator.parentElement !== host) host.append(el.navigator);
      el.navigatorPanel.hidden = !(active && docked);
      el.navigatorOverlay.hidden = !(active && !docked && this.view.zoomed);
      if (!active) return;
      const url = this.imageUrl(this.item, 'thumb');
      if (el.navigatorImage.getAttribute('src') !== url) el.navigatorImage.src = url;
      const rect = this.navRect(); if (!rect) return;
      const px = value => `${value}px`, visible = View.visibleRect(this.view.box(), this.view.size());
      Object.assign(el.navigatorImage.style, { left: px(rect.left), top: px(rect.top), width: px(rect.width), height: px(rect.height) });
      Object.assign(el.navigatorView.style, { left: px(rect.left + visible.x * rect.width), top: px(rect.top + visible.y * rect.height),
        width: px(visible.width * rect.width), height: px(visible.height * rect.height) });
      el.navigator.classList.toggle('zoomed', this.view.zoomed);
    }
    renderControls() {
      const el = this.el, view = this.view, mode = view.zoom.mode, percent = view.source ? view.percent() : 0;
      el.zoomFit.setAttribute('aria-pressed', String(mode === 'fit'));
      el.zoomFill.setAttribute('aria-pressed', String(mode === 'fill'));
      el.zoomLevel.textContent = formatPercent(percent);
      el.zoomLevel.title = percent ? `Showing ${formatPercent(percent)} of the photo's real pixels` : '';
      el.viewport.setAttribute('aria-label', view.zoomed ? `${formatPercent(percent) || 'Zoomed'} · drag to pan, click to fit` : 'Click to zoom');
      if (el.navigatorZoom) el.navigatorZoom.textContent = mode === 'fit' ? `Fit ${formatPercent(percent)}` : mode === 'fill' ? `Fill ${formatPercent(percent)}` : formatPercent(percent);
    }
    changed() {
      this.renderControls(); this.renderNavigator();
      // The drawn size decides which representation is needed.
      if (this.item && this.context().mode === 'review') this.show(this.item);
    }
    layout() { this.view.apply(); this.renderNavigator(); }
    // A new folder: back to Fit and forget everything loaded.
    reset() {
      this.prefetcher.set([]); this.abandon(null); clearTimeout(this.timer);
      this.reps.clear(); this.dims.clear(); this.item = null; this.shown = null; this.lastId = null; this.lastChange = -Infinity; this.direction = 1;
      this.base = 'fit'; this.cancelHand(); this.el.image.dataset.stamp = ''; delete this.el.image.dataset.itemId;
      this.view.reset();
    }
    // Previews were regenerated (retry, RAW rendering change): reload, keeping
    // the current pixels on screen until replacements arrive.
    invalidate() { this.prefetcher.set([]); this.reps.clear(); this.shown = null; this.el.image.dataset.stamp = ''; }
    clear() { this.generation++; this.el.image.dataset.stamp = ''; this.renderNavigator(); }
  }

  const api = { AHEAD, BEHIND, RAPID_MS, SETTLE_MS, PREVIEW_EDGE, prepareAhead, travel, isRapid, neededKind, chooseRepresentation, cameraPixels, cameraTooltip,
    formatPercent, keyAction, Prefetcher, Loupe, create: options => new Loupe(options) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PhotoCullLoupe = api;
})(globalThis);
