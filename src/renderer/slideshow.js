window.PhotoCullSlideshow = { init({ $, items, current, imageUrl, colorOf, fullscreen, setFullscreen }) {
  const dialog = $('slideshow'), frame = $('slide-frame'), hud = $('slide-hud'), status = $('slide-status');
  const interval = $('slide-interval'), loop = $('slide-loop'), captions = $('slide-captions'), play = $('slide-play');
  let photos = [], index = 0, playing = false, ready = false, ended = false, closing = false;
  let timer, hudTimer, generation = 0, preload, loading, previousFullscreen, listeners;
  try {
    const saved = JSON.parse(localStorage.getItem('photocull-slideshow') || '{}');
    if ([2, 3, 5, 8, 12].includes(saved.interval)) interval.value = String(saved.interval);
    loop.checked = saved.loop === true; captions.checked = saved.captions !== false;
  } catch {}
  function save() {
    try { localStorage.setItem('photocull-slideshow', JSON.stringify({ interval: Number(interval.value), loop: loop.checked, captions: captions.checked })); } catch {}
  }
  function wake() {
    clearTimeout(hudTimer); dialog.classList.remove('slide-idle');
    hudTimer = setTimeout(() => dialog.classList.add('slide-idle'), 2500);
  }
  function controls() {
    play.textContent = playing ? 'Pause' : ended ? 'Replay' : 'Play';
    $('slide-prev').disabled = index === 0 && !loop.checked;
    $('slide-next').disabled = index === photos.length - 1 && !loop.checked;
  }
  function pause() { clearTimeout(timer); playing = false; controls(); }
  function finish() {
    ended = true; pause(); status.textContent = 'End of slideshow'; wake();
  }
  function schedule() {
    clearTimeout(timer);
    if (playing && ready) timer = setTimeout(() => {
      if (index === photos.length - 1 && !loop.checked) finish(); else move(1);
    }, Number(interval.value) * 1000);
  }
  function prepare(at) {
    const img = new Image(); img.alt = photos[at].name; img.decoding = 'async'; img.src = imageUrl(photos[at], 'full');
    return { at, img, decoded: img.decode().then(() => true, () => false) };
  }
  function discard(entry) { entry?.img.removeAttribute('src'); }
  function prefetch() {
    discard(preload); preload = null;
    const next = (index + 1) % photos.length;
    if (next !== index && (next || loop.checked)) preload = prepare(next);
  }
  function caption(item) {
    $('slide-caption').hidden = !captions.checked;
    $('slide-name').textContent = item.name;
    $('slide-rating').textContent = ['★'.repeat(item.rating || 0), item.flag === 'pick' ? 'Pick' : item.flag === 'reject' ? 'Reject' : ''].filter(Boolean).join(' · ');
    const badge = $('slide-color'), color = colorOf(item);
    badge.hidden = !color; badge.style.setProperty('--label-color', color?.hex || 'transparent'); badge.title = color?.name || '';
    $('slide-index').textContent = (index + 1) + ' / ' + photos.length;
  }
  async function show(at) {
    clearTimeout(timer); ready = ended = false; status.textContent = '';
    const stamp = ++generation;
    index = at; controls();
    discard(loading);
    const entry = preload?.at === at ? preload : prepare(at);
    if (preload !== entry) discard(preload);
    preload = null; loading = entry;
    const loaded = await entry.decoded;
    if (stamp !== generation) return;
    loading = null;
    caption(photos[at]);
    if (!loaded) { frame.replaceChildren(); pause(); status.textContent = 'Preview unavailable'; return; }
    frame.replaceChildren(entry.img); ready = true;
    prefetch(); schedule();
  }
  function move(delta) {
    const next = index + delta;
    if (!loop.checked && (next < 0 || next >= photos.length)) return;
    void show((next + photos.length) % photos.length);
  }
  function toggle() {
    if (playing) return pause();
    playing = true;
    if (ended || !ready && !loading) void show(ended ? 0 : index);
    else { controls(); schedule(); }
  }
  async function exit(restoreWindow = true) {
    if (closing || !listeners) return;
    closing = true; hud.inert = true; generation++; pause(); clearTimeout(hudTimer);
    listeners.abort(); listeners = null; discard(preload); discard(loading); preload = loading = null;
    try { if (restoreWindow) await setFullscreen(previousFullscreen); }
    finally { dialog.close(); frame.replaceChildren(); photos = []; ready = false; closing = false; hud.inert = false; }
  }
  function keydown(event) {
    wake();
    if (event.key === 'Escape') { event.preventDefault(); void exit(); return; }
    if (event.target === interval && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) return;
    if (event.key === ' ' && event.target.closest('button, input, select, a[href]')) return;
    if (![' ', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); if (closing) return;
    if (event.key === ' ') { if (!event.repeat) toggle(); } else move(event.key === 'ArrowLeft' ? -1 : 1);
  }
  function open() {
    if (listeners || closing || document.querySelector('dialog[open]')) return;
    photos = items();
    if (!photos.length) return;
    previousFullscreen = fullscreen();
    listeners = new AbortController();
    const events = { signal: listeners.signal };
    dialog.addEventListener('keydown', keydown, events);
    dialog.addEventListener('pointermove', wake, events);
    dialog.addEventListener('pointerdown', wake, events);
    dialog.addEventListener('focusin', wake, events);
    window.addEventListener('blur', pause, events);
    document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); }, events);
    dialog.showModal(); frame.focus(); wake(); playing = true;
    void setFullscreen(true, true);
    void show(Math.max(0, photos.findIndex(i => i.id === current())));
  }
  play.onclick = toggle;
  $('slide-prev').onclick = () => move(-1); $('slide-next').onclick = () => move(1);
  interval.onchange = () => { save(); schedule(); };
  loop.onchange = () => { save(); controls(); if (ready) prefetch(); };
  captions.onchange = () => { save(); $('slide-caption').hidden = !captions.checked; };
  $('slide-exit').onclick = () => exit();
  dialog.onclose = () => { if (!dialog.open) void exit(); };
  dialog.oncancel = event => { event.preventDefault(); void exit(); };
  return { open, exit };
} };
