const api = window.photocull;
const $ = id => document.getElementById(id);
const state = { deleting: false, session: null, selected: null, marked: new Set(), anchor: null, filter: 'all', query: '', mode: 'review', zoom: false, zoomPercent: 100, fullscreen: false,
  generation: 0, previewRevision: 0, prefetched: [], pendingSaves: 0, saveError: false, busy: false, settings: { autoAdvance: true, recursive: false, autoOpenCards: true, colors: [], naming: { template: '{filename}', text: '', start: 1 } }, settingsReady: false, colorFilter: '', devices: [], deviceError: '', autoOpened: new Set(), copy: { running: false, destination: null, copiedTo: null } };
let toastTimer, metadataTimer, framePending = false;
const gridNodes = new Map(), filmNodes = new Map();
let filmSignature = '';
let layoutPrefs = { sources: true, details: true, gridSize: 205 };
try { const saved = JSON.parse(localStorage.getItem('photocull-layout') || '{}'); layoutPrefs = { sources: saved.sources !== false, details: saved.details !== false, gridSize: Math.min(320, Math.max(160, Number(saved.gridSize) || 205)) }; } catch {}
const glyph = paths => `<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const fullscreenIcons = { enter: glyph('<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>'), exit: glyph('<path d="M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5"/>') };
function storeLayout() { try { localStorage.setItem('photocull-layout', JSON.stringify(layoutPrefs)); } catch {} }
function applyPaneLayout() {
  const narrow = matchMedia('(max-width: 900px)').matches;
  const sources = narrow ? document.body.classList.contains('mobile-sources') : layoutPrefs.sources;
  const details = narrow ? document.body.classList.contains('mobile-details') : layoutPrefs.details;
  document.body.classList.toggle('sources-hidden', !narrow && !sources); document.body.classList.toggle('details-hidden', !narrow && !details);
  $('toggle-sidebar').setAttribute('aria-expanded', String(sources)); $('toggle-sidebar').setAttribute('aria-label', sources ? 'Hide sources' : 'Show sources');
  $('toggle-inspector').setAttribute('aria-expanded', String(details)); $('toggle-inspector').setAttribute('aria-label', details ? 'Hide details' : 'Show details');
  requestGrid();
}
function togglePane(pane) {
  if (matchMedia('(max-width: 900px)').matches) document.body.classList.toggle(pane === 'sources' ? 'mobile-sources' : 'mobile-details');
  else { layoutPrefs[pane] = !layoutPrefs[pane]; storeLayout(); }
  applyPaneLayout();
}
$('toggle-sidebar').onclick = () => togglePane('sources'); $('toggle-inspector').onclick = () => togglePane('details');
$('grid-size').value = layoutPrefs.gridSize; $('grid-size').oninput = () => { layoutPrefs.gridSize = Number($('grid-size').value); storeLayout(); requestGrid(); };
matchMedia('(max-width: 900px)').addEventListener('change', applyPaneLayout);
applyPaneLayout();
const imageView = new PhotoCullView.ImageView($('image-viewport'), $('review-image'), { onToggle: point => toggleZoom(point) });

// The open Del / Shift+Del confirmation, if any: { ids, mode, session, view }.
let deletePrompt = null;
function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500);
}
function photo() { return state.session?.items.find(i => i.id === state.selected); }
function selection() { return state.marked.size > 1 ? filtered().filter(i => state.marked.has(i.id)) : photo() ? [photo()] : []; }
function resetSelection() { state.marked = new Set(state.selected ? [state.selected] : []); state.anchor = state.selected; }
function viewKey() { return JSON.stringify([state.filter, state.query, state.colorFilter]); }
function sameIds(ids, items = selection()) { const marked = new Set(ids); return ids.length === items.length && items.every(item => marked.has(item.id)); }
function additive(event) {
  if (api.platform === 'darwin') return event.metaKey;
  return api.platform === 'web' ? event.ctrlKey || event.metaKey : event.ctrlKey; // web: tests run on macOS, where Ctrl+click is a right-click
}
function reviewed(item) { return item.flag !== 'none' || item.rating > 0 || !!item.color; }
function filtered() {
  return (state.session?.items ?? []).filter(item => {
    // Trashed photos only appear in the Trash view.
    const match = state.filter === 'trash' ? item.trashed : !item.trashed && (state.filter === 'all' || state.filter === 'unreviewed' && !reviewed(item) ||
      state.filter === 'rated' && item.rating > 0 || item.flag === state.filter);
    return match && (!state.colorFilter || colorOf(item) === state.colorFilter) && item.name.toLowerCase().includes(state.query);
  });
}
function imageUrl(item, kind = 'thumb', prefetch = false) {
  return api.imageUrl(state.session.id, item.id, kind, `&v=${state.previewRevision}${prefetch ? '&prefetch=1' : ''}`);
}
function fileSize(bytes) { return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
function setStatus(text, error = false) {
  $('save-status').textContent = text;
  $('save-status').style.color = error ? '#e99787' : '';
}

async function openFolder() {
  if (state.busy || state.copy.running || state.deleting) return;
  state.busy = true;
  $('open-folder').disabled = true; $('empty-open').disabled = true;
  setStatus('Reading folder…');
  try {
    const session = await api.chooseFolder({ recursive: state.settings.recursive });
    if (session) loadSession(session);
    else setStatus(state.session ? 'Saved' : 'Ready');
  } catch (e) { toast(e.message); setStatus('Could not open folder', true); }
  finally { state.busy = false; $('open-folder').disabled = false; $('empty-open').disabled = false; }
}

function loadSession(session) {
  state.session = session; state.selected = session.items[0]?.id ?? null;
  resetSelection();
  state.filter = 'all'; state.colorFilter = ''; $('color-filter').value = ''; state.query = ''; state.zoom = false; state.saveError = false;
  $('search').value = ''; $('grid').scrollTop = 0;
  const folderName = session.folder.split(/[\\/]/).filter(Boolean).pop();
  $('folder-name').textContent = folderName; $('folder-name').title = session.folder;
  $('folder-detail').textContent = `${session.items.length} photos`;
  $('breadcrumb').textContent = session.folder;
  $('breadcrumb').title = session.folder;
  $('export').disabled = !session.items.length;
  gridNodes.clear(); filmNodes.clear(); filmSignature = ''; $('grid-content').replaceChildren();
  render(); renderDevices();
  setStatus('Saved');
  if (session.warnings.length) toast(`${session.warnings.length} file or sidecar warning(s): ${session.warnings[0]}`);
  if (!session.items.length) toast('No supported images found. Try including subfolders.');
}

function renderDevices() {
  const removed = state.session?.deviceId && !state.devices.some(d => d.id === state.session.deviceId);
  $('devices-panel').hidden = !state.devices.length && !state.deviceError && !removed;
  $('device-list').replaceChildren(...state.devices.map(device => {
    const button = document.createElement('button'); button.className = 'device-button';
    button.textContent = `${device.label} · ${device.root}`;
    button.title = device.photoRoot;
    button.disabled = state.busy || state.copy.running || state.deleting;
    button.onclick = () => openDevice(device);
    return button;
  }));
  $('device-status').textContent = removed ? 'Card disconnected' : state.deviceError || '';
}
async function openDevice(device) {
  if (state.busy || state.copy.running || state.deleting) return;
  state.busy = true; $('open-folder').disabled = true; $('empty-open').disabled = true; renderDevices();
  setStatus('Reading camera card…');
  try { loadSession(await api.openDevice(device.id)); }
  catch (error) { toast(error.message); setStatus('Could not open card', true); }
  finally { state.busy = false; $('open-folder').disabled = false; $('empty-open').disabled = false; renderDevices(); }
}
function receiveDevices(snapshot) {
  const previous = new Set(state.devices.map(d => d.id));
  state.devices = snapshot.devices; state.deviceError = snapshot.error;
  renderDevices();
  const cameras = state.devices.filter(d => d.camera);
  if (state.settingsReady && state.settings.autoOpenCards && !document.querySelector('dialog[open]') && !state.session && !state.busy && cameras.length === 1 && !state.autoOpened.has(cameras[0].id)) {
    state.autoOpened.add(cameras[0].id); void openDevice(cameras[0]);
  } else if (state.session && state.devices.some(d => !previous.has(d.id))) toast('Card connected');
  for (const id of state.autoOpened) if (!state.devices.some(d => d.id === id)) state.autoOpened.delete(id);
}
api.onDevices(receiveDevices);
void api.devices().then(receiveDevices).catch(error => { state.deviceError = error.message; renderDevices(); });

function renderCounts() {
  const all = state.session?.items ?? [], items = all.filter(i => !i.trashed);
  const count = items.filter(reviewed).length;
  $('count-trash').textContent = all.length - items.length;
  $('count-all').textContent = items.length;
  $('count-unreviewed').textContent = items.length - count;
  for (const flag of ['pick', 'reject']) $(`count-${flag}`).textContent = items.filter(i => i.flag === flag).length;
  $('count-rated').textContent = items.filter(i => i.rating > 0).length;
  $('progress-text').textContent = `${count} of ${items.length}`;
  $('progress-fill').style.width = `${items.length ? count / items.length * 100 : 0}%`;
  document.querySelectorAll('.filter').forEach(button => { const active = button.dataset.filter === state.filter; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
}

function render(reset = false) {
  renderCounts();
  const items = filtered();
  if (!items.some(i => i.id === state.selected)) state.selected = items[0]?.id ?? null;
  const visible = new Set(items.map(i => i.id)), hadMarked = state.marked.size > 0;
  state.marked = new Set([...state.marked].filter(id => visible.has(id)));
  if (hadMarked && state.selected) state.marked.add(state.selected);
  if (reset) resetSelection();
  if (!visible.has(state.anchor)) state.anchor = state.selected;
  const loaded = !!state.session?.items.length;
  $('empty').hidden = loaded;
  $('no-matches').hidden = !loaded || !!items.length;
  $('review').hidden = !loaded || !items.length || state.mode !== 'review';
  $('grid').hidden = !loaded || !items.length || state.mode !== 'grid';
  $('grid-size-control').hidden = !loaded || state.mode !== 'grid';
  $('review-mode').setAttribute('aria-pressed', String(state.mode === 'review')); $('grid-mode').setAttribute('aria-pressed', String(state.mode === 'grid'));
  $('review-mode').classList.toggle('active', state.mode === 'review');
  $('grid-mode').classList.toggle('active', state.mode === 'grid');
  const titles = { all: 'Photos', unreviewed: 'Unreviewed', pick: 'Picks', reject: 'Rejects', rated: 'Rated', trash: 'Trash' };
  $('view-title').textContent = loaded ? titles[state.filter] : 'Photos';
  $('view-count').textContent = loaded ? `${items.length}${state.marked.size > 1 ? ` · ${state.marked.size} selected` : ''}` : '';
  const rejects = scopeItems('reject').length, trashed = scopeItems('trash').length, locked = state.busy || state.copy.running || state.deleting;
  $('delete-rejects').hidden = !loaded || state.filter !== 'reject' || !rejects;
  $('delete-rejects').disabled = locked;
  $('delete-rejects').querySelector('span').textContent = `Delete ${rejects} reject${rejects === 1 ? '' : 's'}`;
  $('trash-restore').hidden = !loaded || state.filter !== 'trash' || !trashed;
  $('empty-trash').hidden = !loaded || state.filter !== 'trash' || !trashed;
  $('trash-restore').disabled = $('empty-trash').disabled = locked;
  if (deletePrompt && (state.session?.id !== deletePrompt.session || viewKey() !== deletePrompt.view || !sameIds(deletePrompt.ids))) hideDeletePrompt();
  renderSelection();
  if (state.mode === 'grid') requestGrid();
}

function renderSelection() {
  const item = photo();
  $('image-details').hidden = !item; $('inspector-empty').hidden = !!item;
  if (!item) { state.generation++; $('review-image').dataset.stamp = ''; if (state.fullscreen) void setFullscreen(false); return; }
  const items = filtered(), index = items.findIndex(i => i.id === item.id);
  const nearbyIds = items.slice(Math.max(0, index - 1), index + 3).map(i => i.id);
  void api.focus(state.session.id, nearbyIds).catch(() => {});
  $('photo-name').textContent = item.name;
  $('photo-size').textContent = `${fileSize(item.size)}${item.paired ? ' · RAW + JPEG pair' : ''}`;
  $('format-badge').textContent = item.raw ? item.paired ? 'RAW + JPEG' : 'RAW' : item.name.split('.').pop().toUpperCase();
  $('image-position').textContent = `${index + 1} / ${items.length}`;
  $('previous').disabled = index <= 0; $('next').disabled = index >= items.length - 1;
  $('detail-name').textContent = item.name;
  $('detail-kind').textContent = `${item.raw ? 'Camera RAW' : 'Image'} · ${fileSize(item.size)}${item.paired ? ' · paired JPEG' : ''}`;
  renderDecision(item);
  renderColorLabels(item);
  renderFilmstrip(items, index);
  if (state.mode === 'review') showImage(item);
  clearTimeout(metadataTimer);
  metadataTimer = setTimeout(() => loadMetadata(item), 180);
}

function renderDecision(item) {
  $('pick').classList.toggle('active', item.flag === 'pick');
  $('reject').classList.toggle('active', item.flag === 'reject');
  if (!$('rating').children.length) {
    $('rating').replaceChildren(...Array.from({ length: 5 }, (_, i) => {
      const button = document.createElement('button'); button.textContent = '★'; button.title = `${i + 1} star${i ? 's' : ''}`;
      button.setAttribute('aria-label', button.title); button.onclick = () => decide({ rating: photo()?.rating === i + 1 ? 0 : i + 1 }); return button;
    }));
  }
  [...$('rating').children].forEach((button, i) => { button.classList.toggle('selected', i < item.rating); button.setAttribute('aria-pressed', String(i < item.rating)); });
  $('pick').setAttribute('aria-pressed', String(item.flag === 'pick')); $('reject').setAttribute('aria-pressed', String(item.flag === 'reject'));
  $('detail-decision').textContent = state.marked.size > 1 ? `${state.marked.size} photos selected` : `${item.flag === 'pick' ? '⚑ Pick' : item.flag === 'reject' ? '× Rejected' : item.rating ? 'Rated' : 'Unreviewed'}${item.rating ? ` · ${'★'.repeat(item.rating)}` : ''}`;
  $('flag-overlay').hidden = item.flag === 'none';
  $('flag-overlay').textContent = item.flag === 'pick' ? 'Picked' : 'Rejected';
  $('flag-overlay').classList.toggle('rejected', item.flag === 'reject');
}

function showImage(item) {
  const target = $('review-image');
  const changed = target.dataset.itemId !== item.id;
  if (changed) { state.zoom = false; target.dataset.itemId = item.id; imageView.reset(); }
  const kind = state.zoom ? 'full' : 'preview';
  const stamp = `${state.session.id}:${item.id}:${kind}:${state.previewRevision}`;
  if (target.dataset.stamp === stamp && (target.dataset.complete || Number(target.dataset.generation) === state.generation)) return;
  applyZoom();
  const generation = ++state.generation; target.dataset.generation = generation;
  const keep = !changed && target.naturalWidth > 0;
  target.dataset.stamp = stamp;
  if (!keep) { target.removeAttribute('src'); imageView.apply(); }
  target.alt = item.name;
  $('image-error').hidden = true; $('retry-preview').hidden = true; $('image-loading').hidden = false;
  $('image-loading').textContent = state.zoom ? 'Loading full image…' : 'Loading preview…';
  $('preview-source').textContent = item.raw ? 'Finding RAW preview…' : 'Original image';
  delete target.dataset.complete;
  const thumb = new Image();
  thumb.onload = () => { if (generation === state.generation && !target.dataset.complete) target.src = thumb.src; };
  if (!keep) thumb.src = imageUrl(item);
  const full = new Image();
  full.onload = () => {
    if (generation !== state.generation) return;
    target.dataset.complete = 'yes'; target.src = full.src;
    $('image-loading').hidden = true;
    $('preview-status').textContent = '';
    state.prefetched = [];
    const items = filtered(), index = items.findIndex(i => i.id === item.id);
    for (const offset of [1, 2, -1]) {
      const neighbor = items[index + offset]; if (!neighbor) continue;
      const image = new Image(); image.src = imageUrl(neighbor, 'preview', true); state.prefetched.push(image);
    }
    void loadMetadata(item);
    void updatePreviewStatus(item, generation);
  };
  full.onerror = () => {
    if (generation !== state.generation) return;
    $('image-loading').hidden = true; $('image-error').hidden = false;
    $('image-error').textContent = 'Preview unavailable';
    $('retry-preview').hidden = false;
    void updatePreviewStatus(item, generation, true);
  };
  full.src = imageUrl(item, kind);
}

async function updatePreviewStatus(item, generation, failed = false) {
  try {
    const status = await api.previewStatus(state.session.id, item.id, state.zoom ? 'full' : 'preview');
    if (generation !== state.generation || state.selected !== item.id) return;
    if (failed) {
      $('image-error').textContent = status.error || 'Preview unavailable';
    } else if (status.info) {
      const info = status.info;
      $('preview-source').textContent = `${info.source}${info.cached ? ' · cached' : ''}`;
      if (info.limited) $('preview-status').textContent = 'Limited resolution';
      $('retry-preview').hidden = !info.renderError;
      if (info.renderError) $('preview-status').textContent = `Using smaller preview · RAW render failed`;
    }
  } catch { /* The session may have changed during navigation. */ }
}

api.onPreviewState(status => {
  if (status.id !== state.selected || state.mode !== 'review' || $('review-image').dataset.complete) return;
  if (status.state === 'queued' || status.state === 'rendering') {
    $('image-loading').hidden = false;
    $('image-loading').textContent = status.state === 'queued' ? 'RAW render queued…' : 'Developing RAW sensor data…';
  }
});

function refreshPreviews() {
  state.previewRevision++; state.generation++;
  gridNodes.clear(); $('grid-content').replaceChildren();
  $('review-image').dataset.stamp = '';
  render();
}
$('retry-preview').onclick = async () => {
  const item = photo(); if (!item) return;
  $('retry-preview').disabled = true;
  try { await api.retryPreview(state.session.id, item.id); if (photo()?.id === item.id) refreshPreviews(); }
  catch (error) { toast(error.message); }
  finally { $('retry-preview').disabled = false; }
};


function formatCaptureDate(value) {
  const match = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}:\d{2})/.exec(value || '');
  if (!match) return value;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${Number(match[3])} ${months[Number(match[2]) - 1] || match[2]} ${match[1]}, ${match[4]}`;
}

async function loadMetadata(item) {
  const sessionId = state.session.id, imageId = item.id, generation = state.generation;
  if ($('metadata').dataset.image !== imageId) {
    $('metadata').dataset.image = imageId;
    $('metadata').textContent = 'Loading…';
  }
  try {
    const metadata = await api.metadata(sessionId, imageId, state.zoom ? 'full' : 'preview');
    if (state.selected !== imageId || state.session.id !== sessionId || state.generation !== generation) return;
    const rows = [['Camera', metadata.camera], ['Lens', metadata.lens], ['Exposure', [metadata.shutter ? `${metadata.shutter} s` : '', metadata.aperture, metadata.iso ? `ISO ${metadata.iso}` : ''].filter(Boolean).join(' · ')],
      ['Captured', formatCaptureDate(metadata.captured)], ['Preview', metadata.width && metadata.height ? `${metadata.width} × ${metadata.height}` : ''], ['Source', metadata.source]];
    $('metadata').replaceChildren(...rows.flatMap(([name, value]) => {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = name; dd.textContent = value || '—'; return [dt, dd];
    }));
    $('preview-source').textContent = metadata.source || item.source;
  } catch { if (state.selected === imageId) $('metadata').textContent = 'Metadata unavailable'; }
}

function renderFilmstrip(items, index) {
  const start = Math.max(0, index - 3), nearby = items.slice(start, Math.min(items.length, index + 5));
  if (state.mode === 'review') void api.visible(state.session.id, nearby.map(i => i.id)).catch(() => {});
  const signature = `${state.session.id}:${state.previewRevision}:${nearby.map(item => item.id).join(':')}`;
  const nodes = nearby.map((item, i) => {
    let button = filmNodes.get(item.id);
    if (!button || button.dataset.revision !== String(state.previewRevision)) {
      button = document.createElement('button'); button.dataset.revision = state.previewRevision; button.className = 'film-card';
      button.title = item.name; button.setAttribute('aria-label', item.name);
      const image = document.createElement('img'); image.src = imageUrl(item); image.alt = ''; image.decoding = 'async';
      image.onerror = () => { image.style.opacity = '0'; };
      const label = document.createElement('span'); label.className = 'film-label'; button.append(image, label);
      button.onclick = event => { select(item.id, event); if (state.fullscreen && event.detail) button.blur(); }; filmNodes.set(item.id, button);
    }
    button.classList.toggle('selected', state.marked.has(item.id)); button.classList.toggle('current', item.id === state.selected); button.setAttribute('aria-current', String(item.id === state.selected));
    button.querySelector('.film-label').textContent = String(start + i + 1).padStart(2, '0');
    button.querySelectorAll('.mini-flag, .mini-color').forEach(node => node.remove()); addFlag(button, item); return button;
  });
  if (signature !== filmSignature) { $('filmstrip').replaceChildren(...nodes); filmSignature = signature; }
  const retained = new Set(nearby.map(item => item.id)); for (const id of filmNodes.keys()) if (!retained.has(id)) filmNodes.delete(id);

}

function addFlag(node, item) {
  const color = state.settings.colors.find(c => c.id === colorOf(item));
  if (color) { const dot = document.createElement('span'); dot.className = 'mini-color'; dot.style.setProperty('--label-color', color.hex); dot.title = color.name; node.append(dot); }
  if (item.flag !== 'none' || item.rating) {
    const flag = document.createElement('span'); flag.className = `mini-flag${item.flag === 'reject' ? ' rejected' : ''}`;
    flag.textContent = `${item.flag === 'pick' ? '⚑' : item.flag === 'reject' ? '×' : ''}${item.rating ? '★'.repeat(item.rating) : ''}`;
    node.append(flag);
  }
}

function requestGrid() {
  if (framePending) return;
  framePending = true; requestAnimationFrame(() => { framePending = false; renderGrid(); });
}
function gridLayout() {
  const columns = Math.max(1, Math.floor($('grid').clientWidth / layoutPrefs.gridSize));
  const width = Math.floor(($('grid').clientWidth - 12) / columns), rowHeight = Math.round(width * .77) + 35;
  return { columns, width, rowHeight };
}
function renderGrid() {
  if (state.mode !== 'grid' || $('grid').hidden) return;
  const viewport = $('grid'), container = $('grid-content'), items = filtered();
  const { columns, width, rowHeight } = gridLayout();
  container.style.height = `${Math.ceil(items.length / columns) * rowHeight}px`;
  const first = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - 1) * columns;
  const last = Math.min(items.length, (Math.ceil((viewport.scrollTop + viewport.clientHeight) / rowHeight) + 1) * columns);
  const retained = new Set();
  for (let i = first; i < last; i++) {
    const item = items[i], signature = `${item.id}:${item.flag}:${item.rating}:${item.color}:${state.previewRevision}`;
    retained.add(item.id);
    let node = gridNodes.get(item.id);
    if (!node || node.dataset.signature !== signature) {
      node?.remove(); node = document.createElement('button'); node.className = 'grid-card'; node.dataset.signature = signature;
      const wrap = document.createElement('div'); wrap.className = 'thumb-wrap';
      const img = document.createElement('img'); img.alt = item.name; img.src = imageUrl(item); img.decoding = 'async';
      img.onerror = () => { img.style.opacity = '0'; wrap.title = 'Preview unavailable'; };
      wrap.append(img); addFlag(wrap, item);
      const caption = document.createElement('div'); caption.className = 'grid-caption';
      const name = document.createElement('span'); name.textContent = item.name;
      const type = document.createElement('span'); type.textContent = item.raw ? 'RAW' : item.name.split('.').pop().toUpperCase(); type.className = 'subtle';
      caption.append(name, type); node.append(wrap, caption);
      node.onclick = event => select(item.id, event); node.ondblclick = () => setMode('review');
      node.setAttribute('aria-label', item.name); container.append(node); gridNodes.set(item.id, node);
    }
    node.classList.toggle('selected', state.marked.has(item.id)); node.classList.toggle('current', item.id === state.selected);
    node.style.left = `${(i % columns) * width}px`; node.style.top = `${Math.floor(i / columns) * rowHeight}px`;
    node.style.width = `${width - 10}px`; node.style.height = `${rowHeight - 12}px`;
  }
  void api.visible(state.session.id, [...retained].slice(0, 128)).catch(() => {});
  for (const [id, node] of gridNodes) { if (!retained.has(id)) { node.remove(); gridNodes.delete(id); } }
}

let marquee = null, suppressGridClick = false;
$('grid').addEventListener('dragstart', event => event.preventDefault());
$('grid').addEventListener('click', event => {
  if (suppressGridClick) { event.preventDefault(); event.stopPropagation(); suppressGridClick = false; }
}, true);
$('grid').addEventListener('pointerdown', event => {
  if (event.button !== 0 || !event.isPrimary || state.deleting) return;
  const bounds = $('grid').getBoundingClientRect();
  // Presses on the scrollbar scroll; they never start a selection box.
  if (event.clientX - bounds.left >= $('grid').clientWidth || event.clientY - bounds.top >= $('grid').clientHeight) return;
  marquee = { pointer: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX - bounds.left + $('grid').scrollLeft,
    startY: event.clientY - bounds.top + $('grid').scrollTop, clientX: event.clientX, clientY: event.clientY,
    base: event.shiftKey || additive(event) ? new Set(state.marked) : new Set(), current: state.selected,
    session: state.session.id, view: viewKey(), active: false, frame: null, node: null };
});
function updateMarquee() {
  const drag = marquee; if (!drag?.active) return;
  if (state.mode !== 'grid' || state.session?.id !== drag.session || viewKey() !== drag.view) { endMarquee(); return; }
  const viewport = $('grid'), bounds = viewport.getBoundingClientRect();
  const x = Math.max(0, Math.min(viewport.clientWidth, drag.clientX - bounds.left)) + viewport.scrollLeft;
  const y = Math.max(0, Math.min(viewport.clientHeight, drag.clientY - bounds.top)) + viewport.scrollTop;
  const left = Math.min(drag.startX, x), top = Math.min(drag.startY, y), right = Math.max(drag.startX, x), bottom = Math.max(drag.startY, y);
  Object.assign(drag.node.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
  const { columns, width, rowHeight } = gridLayout(), items = filtered(), marked = new Set(drag.base);
  let current = null;
  // Hit-test layout coordinates: most of the intersecting cards may not be mounted.
  const first = Math.max(0, Math.floor(top / rowHeight)) * columns;
  const last = Math.min(items.length, (Math.floor(bottom / rowHeight) + 1) * columns);
  for (let i = first; i < last; i++) {
    const cardX = i % columns * width, cardY = Math.floor(i / columns) * rowHeight;
    if (cardX <= right && cardX + width - 10 >= left && cardY <= bottom && cardY + rowHeight - 12 >= top) {
      marked.add(items[i].id); current ??= items[i].id;
    }
  }
  current ??= marked.values().next().value ?? drag.current;
  if (current !== state.selected || marked.size !== state.marked.size || [...marked].some(id => !state.marked.has(id))) {
    state.selected = current; state.marked = marked; state.anchor = current; state.zoom = false; render();
  }
}
function scrollMarquee(time) {
  const drag = marquee; if (!drag?.active) return;
  const viewport = $('grid'), bounds = viewport.getBoundingClientRect(), edge = 40;
  const velocity = drag.clientY < bounds.top + edge ? -Math.min(1, (bounds.top + edge - drag.clientY) / edge)
    : drag.clientY > bounds.bottom - edge ? Math.min(1, (drag.clientY - bounds.bottom + edge) / edge) : 0;
  viewport.scrollTop += velocity * Math.min(32, time - (drag.time ?? time)) * .6; drag.time = time;
  updateMarquee();
  if (marquee === drag) drag.frame = requestAnimationFrame(scrollMarquee);
}
window.addEventListener('pointermove', event => {
  const drag = marquee; if (!drag || event.pointerId !== drag.pointer) return;
  drag.clientX = event.clientX; drag.clientY = event.clientY;
  if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 5) {
    drag.active = true; $('grid').setPointerCapture(drag.pointer);
    drag.node = document.createElement('div'); drag.node.className = 'marquee'; $('grid-content').append(drag.node);
    drag.frame = requestAnimationFrame(scrollMarquee);
  }
  if (drag.active) { event.preventDefault(); updateMarquee(); }
});
function endMarquee() {
  const drag = marquee; if (!drag) return;
  marquee = null; cancelAnimationFrame(drag.frame); drag.node?.remove();
  if (drag.active) {
    suppressGridClick = true;
    // The synthetic click follows pointerup before the next task; later clicks are independent.
    setTimeout(() => { suppressGridClick = false; }, 0);
    if ($('grid').hasPointerCapture(drag.pointer)) $('grid').releasePointerCapture(drag.pointer);
  }
}
window.addEventListener('pointerup', event => { if (event.pointerId === marquee?.pointer) { if (marquee.active) updateMarquee(); endMarquee(); } });
window.addEventListener('pointercancel', event => { if (event.pointerId === marquee?.pointer) endMarquee(); });
$('grid').addEventListener('lostpointercapture', event => { if (event.pointerId === marquee?.pointer) endMarquee(); });

function select(id, event = {}) {
  const wasMulti = state.marked.size > 1;
  if (event.shiftKey) {
    const items = filtered(), anchor = items.findIndex(i => i.id === state.anchor), index = items.findIndex(i => i.id === id);
    const start = anchor < 0 ? index : anchor;
    state.marked = new Set(items.slice(Math.min(start, index), Math.max(start, index) + 1).map(i => i.id));
    state.selected = id;
  } else if (additive(event)) {
    if (state.marked.has(id)) { state.marked.delete(id); if (state.selected === id) state.selected = state.marked.values().next().value ?? id; }
    else { state.marked.add(id); state.selected = id; }
    state.anchor = id;
  } else { state.selected = id; resetSelection(); }
  state.zoom = false;
  // Plain navigation stays on the cheap path; only selection-size changes need the full render.
  if (wasMulti || state.marked.size > 1 || deletePrompt) render(); else renderSelection();
  if (state.mode === 'grid') {
    const items = filtered(), index = items.findIndex(i => i.id === id);
    const { columns, rowHeight } = gridLayout();
    const y = Math.floor(index / columns) * rowHeight;
    if (y < $('grid').scrollTop) $('grid').scrollTop = y;
    else if (y + rowHeight > $('grid').scrollTop + $('grid').clientHeight) $('grid').scrollTop = y + rowHeight - $('grid').clientHeight;
    requestGrid();
  }
}
function navigate(delta, extend = false) {
  const items = filtered(), index = items.findIndex(i => i.id === state.selected);
  const next = items[Math.max(0, Math.min(items.length - 1, index + delta))];
  if (next) select(next.id, { shiftKey: extend });
}
function setMode(mode) { if (mode === 'grid' && state.fullscreen) void setFullscreen(false); state.generation++; state.mode = mode; state.zoom = false; render(); }

function nextSurvivor(items, ids) {
  let last = -1;
  for (let i = 0; i < items.length; i++) if (ids.has(items[i].id)) last = i;
  return items.slice(last + 1).find(i => !ids.has(i.id)) ?? items.slice(0, last).reverse().find(i => !ids.has(i.id));
}
async function decide(patch) {
  const targets = selection();
  if (!targets.length) return;
  const sessionId = state.session.id;
  const items = filtered(), ids = new Set(targets.map(i => i.id)), nextId = nextSurvivor(items, ids)?.id;
  for (const item of targets) Object.assign(item, patch, { edited: true });
  if ('trashed' in patch || targets.length === 1 && patch.flag && state.settings.autoAdvance && nextId) {
    state.selected = nextId ?? null; resetSelection();
  }
  state.pendingSaves++; setStatus('Saving…');
  render();
  try {
    if (targets.length > 1) await api.decideMany(sessionId, [...ids], patch);
    else await api.decide(sessionId, targets[0].id, patch);
  } catch (e) { state.saveError = true; toast(`Could not save: ${e.message}`); }
  finally {
    state.pendingSaves--;
    if ($('export-dialog').open) renderCopyOptions();
    if (!state.pendingSaves) setStatus(state.saveError ? 'Save failed' : 'Saved', state.saveError);
  }
}

async function history(direction) {
  if (!state.session) return;
  try {
    const result = await api.history(state.session.id, direction);
    if (!result) return toast(direction === 'redo' ? 'Nothing to redo' : 'Nothing to undo');
    const items = result.items || [result], byId = new Map(state.session.items.map(i => [i.id, i]));
    for (const item of items) Object.assign(byId.get(item.id), item);
    state.selected = items[0].id; state.anchor = state.selected; state.marked = new Set(items.map(i => i.id));
    render(); setStatus('Saved');
  } catch (e) { toast(e.message); }
}

api.onEdit(() => hideDeletePrompt());
api.onEdit(direction => { if (['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) document.execCommand(direction); else if (!document.querySelector('dialog[open]')) void history(direction); });
api.onOpenFolder(() => hideDeletePrompt());
api.onOpenFolder(() => { if (!document.querySelector('dialog[open]')) void openFolder(); });
api.onSettings(() => hideDeletePrompt());
api.onSettings(() => { if (!document.querySelector('dialog[open]')) void openSettings(); });
document.body.classList.toggle('platform-mac', api.platform === 'darwin');
if (api.platform === 'darwin') document.querySelectorAll('#help-dialog kbd').forEach(key => { key.textContent = key.textContent.replaceAll('Ctrl', '⌘').replaceAll('Alt', '⌥'); });
$('open-folder').onclick = openFolder; $('empty-open').onclick = openFolder;
$('review-mode').onclick = () => setMode('review'); $('grid-mode').onclick = () => setMode('grid');
$('search').oninput = event => { state.query = event.target.value.toLowerCase(); $('grid').scrollTop = 0; render(true); };
document.querySelectorAll('.filter').forEach(button => { button.onclick = () => {
  state.filter = button.dataset.filter; $('grid').scrollTop = 0; render(true);
}; });
$('reset-filter').onclick = () => { state.colorFilter = ''; $('color-filter').value = ''; state.filter = 'all'; state.query = ''; $('search').value = ''; render(true); };
$('previous').onclick = () => navigate(-1); $('next').onclick = () => navigate(1);
$('pick').onclick = () => decide({ flag: photo()?.flag === 'pick' ? 'none' : 'pick' });
$('reject').onclick = () => decide({ flag: photo()?.flag === 'reject' ? 'none' : 'reject' });
$('clear').onclick = () => decide({ flag: 'none' });
function applyZoom(point) {
  imageView.setZoom(state.zoom, state.zoomPercent, point);
  $('zoom').textContent = 'Fit';
  $('zoom').setAttribute('aria-pressed', String(!state.zoom));
}
function toggleZoom(point) {
  if (!photo()) return;
  state.zoom = !state.zoom; applyZoom(state.zoom ? point : null); showImage(photo());
}
$('zoom').onclick = () => { $('zoom').blur(); if (state.zoom) toggleZoom(); };
$('image-viewport').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); toggleZoom(); }
});
$('zoom-percent').onchange = async () => {
  state.zoomPercent = Number($('zoom-percent').value); state.zoom = true;
  $('zoom-percent').blur(); applyZoom(); if (photo()) showImage(photo());
  try { state.settings = await api.settings({ zoomPercent: state.zoomPercent }); } catch (error) { toast(error.message); }
};
let dockTimer, fullscreenRequest = 0;
function dockActive() { return $('review-dock').matches(':hover, :focus-within') || $('filmstrip-hotspot').matches(':hover'); }
function showDock() { clearTimeout(dockTimer); document.body.classList.add('filmstrip-visible'); }
function hideDock(delay = 450) {
  clearTimeout(dockTimer); dockTimer = setTimeout(() => {
    if (!state.fullscreen || !dockActive()) document.body.classList.remove('filmstrip-visible');
  }, delay);
}
for (const id of ['review-dock', 'filmstrip-hotspot']) {
  $(id).addEventListener('pointerenter', showDock); $(id).addEventListener('pointerleave', () => hideDock());
  $(id).addEventListener('focusin', showDock); $(id).addEventListener('focusout', () => hideDock());
}
function applyFullscreen(value) {
  if (value && photo() && state.mode !== 'review') setMode('review');
  const changed = state.fullscreen !== value;
  state.fullscreen = value; document.body.classList.toggle('fullscreen-review', value);
  $('fullscreen').innerHTML = value ? fullscreenIcons.exit : fullscreenIcons.enter;
  $('fullscreen').title = value ? 'Exit fullscreen (Esc)' : 'Fullscreen (F)';
  $('fullscreen').setAttribute('aria-label', value ? 'Exit fullscreen' : 'Fullscreen');
  $('fullscreen').setAttribute('aria-pressed', String(value));
  if (value && changed) { showDock(); hideDock(1200); }
  if (!value) { clearTimeout(dockTimer); document.body.classList.remove('filmstrip-visible'); }
  requestAnimationFrame(() => imageView.apply());
}
async function setFullscreen(value = !state.fullscreen) {
  if (value && !photo()) return;
  if (value && state.mode !== 'review') setMode('review');
  const request = ++fullscreenRequest, previous = state.fullscreen;
  applyFullscreen(value);
  try { const result = await api.fullscreen(value); if (request === fullscreenRequest) applyFullscreen(result.fullscreen); }
  catch (error) { if (request === fullscreenRequest) applyFullscreen(previous); toast(error.message); }
}
$('fullscreen').innerHTML = fullscreenIcons.enter;
$('fullscreen').onclick = () => { $('fullscreen').blur(); void setFullscreen(); };
api.onFullscreen(status => applyFullscreen(status.fullscreen));
api.onFullscreenToggle(() => hideDeletePrompt());
api.onFullscreenToggle(() => { if (!document.querySelector('dialog[open]')) void setFullscreen(); });
$('shortcuts').onclick = () => $('help-dialog').showModal();
$('export').onclick = () => {
  $('export-results').hidden = true;
  const count = state.session.items.filter(i => i.edited).length;
  $('export-xmp').disabled = count === 0;
  renderCopyOptions(); void updateNamePreview();
  $('export-dialog').showModal();
};
function renderCopyOptions() {
  const picks = state.session?.items.filter(i => i.flag === 'pick' && !i.trashed) || [];
  const total = picks.reduce((bytes, i) => bytes + i.size, 0);
  $('copy-scope').textContent = `${picks.length} pick${picks.length === 1 ? '' : 's'} · ${fileSize(total)}${$('copy-jpeg').checked ? ' + JPEGs' : ''}`;
  $('copy-start').disabled = state.copy.running || state.deleting || state.pendingSaves > 0 || !picks.length || !state.copy.destination || $('copy-folder-mode').value === 'named' && !$('copy-folder-name').value.trim();
  $('copy-destination').disabled = state.copy.running;
  $('copy-jpeg').disabled = state.copy.running;
  $('copy-xmp').disabled = state.copy.running;
  for (const id of ['copy-metadata','copy-folder-mode','copy-folder-name']) $(id).disabled = state.copy.running;
  $('copy-destination-path').textContent = state.copy.destination || 'Choose folder…';
  $('copy-cancel').hidden = !state.copy.running;
  $('copy-reveal').hidden = !state.copy.copiedTo || state.copy.running;
  $('export-xmp').disabled = state.copy.running || !state.session?.items.some(i => i.edited);
  $('export-json').disabled = state.copy.running;
  $('copy-preset').disabled = state.copy.running;
  $('copy-settings').disabled = state.copy.running;
  $('copy-naming').querySelectorAll('input, select, button').forEach(input => { input.disabled = state.copy.running; });
}
$('copy-jpeg').onchange = () => { renderCopyOptions(); void saveCopyDefaults(); };
$('copy-xmp').onchange = () => { void saveCopyDefaults(); };
$('copy-metadata').onchange = () => { void saveCopyDefaults(); };
for (const prefix of ['copy', 'settings']) {
  $(`${prefix}-folder-mode`).onchange = () => { $(`${prefix}-folder-name-row`).hidden = $(`${prefix}-folder-mode`).value !== 'named'; if (prefix === 'copy') { renderCopyOptions(); if ($('copy-folder-mode').value !== 'named' || $('copy-folder-name').value.trim()) void saveCopyDefaults(); } };
  if (prefix === 'copy') { $('copy-folder-name').oninput = renderCopyOptions; $('copy-folder-name').onchange = () => { void saveCopyDefaults(); void updateNamePreview(); }; }
}
function readFolders(prefix) { return { mode: $(`${prefix}-folder-mode`).value, name: $(`${prefix}-folder-name`).value }; }
function fillFolders(prefix, value) { $(`${prefix}-folder-mode`).value = value.mode; $(`${prefix}-folder-name`).value = value.name; $(`${prefix}-folder-name-row`).hidden = value.mode !== 'named'; }
$('copy-destination').onclick = async () => {
  try { const destination = await api.chooseCopyDestination(); if (destination) state.copy.destination = destination; renderCopyOptions(); }
  catch (error) { toast(error.message); }
};
function showCopyProgress(progress) {
  $('copy-progress').hidden = false;
  $('copy-progress').max = Math.max(1, progress.totalBytes);
  $('copy-progress').value = progress.bytesCopied;
  $('copy-status').textContent = progress.state === 'planning' ? 'Checking picked originals…' : progress.state === 'metadata' ? `Writing metadata · ${progress.file}` :
    `${progress.completed} / ${progress.total} photos · ${fileSize(progress.bytesCopied)} / ${fileSize(progress.totalBytes)}${progress.file ? ` · ${progress.file}` : ''}`;
}
api.onCopyProgress(progress => { if (state.copy.running) showCopyProgress(progress); });
$('copy-start').onclick = async () => {
  if (state.copy.running || state.pendingSaves || state.deleting) return;
  state.copy.running = true; state.copy.copiedTo = null;
  $('export-results').hidden = true;
  $('copy-status').textContent = 'Checking picked originals…';
  $('open-folder').disabled = true; $('empty-open').disabled = true;
  renderCopyOptions(); renderDevices();
  try {
    const result = await api.copyPicks(state.session.id, state.copy.destination, { includeJpeg: $('copy-jpeg').checked, includeXmp: $('copy-xmp').checked, embedMetadata: $('copy-metadata').checked, naming: readNaming('copy'), folders: readFolders('copy') });
    state.copy.copiedTo = result.destination;
    showCopyProgress(result);
    const heading = `${result.state === 'canceled' ? 'Canceled · ' : ''}${result.copied} copied · ${result.skipped.length} skipped · ${result.failures.length} failed`;
    $('copy-status').textContent = heading;
    $('export-results').hidden = !result.skipped.length && !result.failures.length;
    $('export-results').textContent = [...result.skipped, ...result.failures].map(f => `${f.name}: ${f.reason}`).join('\n');
  } catch (error) { $('copy-status').textContent = error.message; toast(error.message); }
  finally {
    state.copy.running = false; $('open-folder').disabled = false; $('empty-open').disabled = false;
    renderCopyOptions(); renderDevices();
  }
};
$('copy-cancel').onclick = () => { void api.cancelCopy().catch(error => toast(error.message)); };
$('copy-reveal').onclick = () => { if (state.copy.copiedTo) void api.revealDestination(state.copy.copiedTo).catch(error => toast(error.message)); };
$('export-dialog').addEventListener('cancel', event => { if (state.copy.running) { event.preventDefault(); toast('Cancel the copy first'); } });
document.querySelectorAll('.close-dialog').forEach(b => { b.onclick = () => { if (b.closest('dialog').id === 'export-dialog' && state.copy.running) return toast('Cancel the copy first'); b.closest('dialog').close(); }; });
$('export-xmp').onclick = async () => {
  $('export-xmp').disabled = true;
  try {
    const result = await api.exportXmp(state.session.id, readSettings());
    $('metadata-results').hidden = false;
    $('metadata-results').textContent = `${result.written} written · ${result.failures.length} failed\n` + result.failures.map(f => `${f.name}: ${f.reason}`).join('\n');
    toast(`${result.written} XMP sidecars written${result.failures.length ? `; ${result.failures.length} failed` : ''}`);
  } catch (e) { toast(e.message); }
  finally { $('export-xmp').disabled = false; }
};
$('export-json').onclick = async () => {
  try { const file = await api.exportManifest(state.session.id); if (file) toast('Decisions manifest saved.'); }
  catch (e) { toast(e.message); }
};
$('grid').onscroll = requestGrid;
new ResizeObserver(requestGrid).observe($('grid'));
document.addEventListener('keydown', event => {
  // A dialog opened over the prompt (e.g. from a native menu) owns the keyboard.
  if (deletePrompt && document.querySelector('dialog[open]')) hideDeletePrompt();
  if (deletePrompt) {
    // Enter confirms; any other key cancels and is otherwise ignored, so a
    // stray P or X does not change the photo the prompt was about.
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Enter' && !event.repeat) void confirmDeletePrompt(); else hideDeletePrompt();
    return;
  }
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (document.querySelector('dialog[open]')) return;
  if ((event.ctrlKey || event.metaKey) && event.key === ',') { event.preventDefault(); void openSettings(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); void openFolder(); return; }
  if (event.key === 'F11') { event.preventDefault(); void setFullscreen(); return; }
  if (event.key === 'Tab' && event.ctrlKey) { event.preventDefault(); setMode(state.mode === 'review' ? 'grid' : 'review'); return; }
  if (typing) return;
  if ([' ', 'Enter'].includes(event.key) && document.activeElement?.matches('button, summary')) return;
  if (event.key === 'Escape') { event.preventDefault(); if (state.marked.size > 1) { resetSelection(); render(); } else if (state.fullscreen) void setFullscreen(false); else if (state.zoom) toggleZoom(); return; }
  if (event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); void setFullscreen(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); void history(event.shiftKey ? 'redo' : 'undo'); return; }
  if (additive(event) && event.key.toLowerCase() === 'a') { event.preventDefault(); state.marked = new Set(filtered().map(i => i.id)); render(); return; }
  if (event.altKey && /^[0-8]$/.test(event.key)) { event.preventDefault(); void decide({ color: event.key === '0' ? '' : event.key }); return; }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'Delete' || event.key === 'Backspace') {
    // Del moves the photo to PhotoCull's Trash; in the Trash view it deletes
    // for real. Shift+Del always asks to delete permanently.
    event.preventDefault();
    if (event.shiftKey) showDeletePrompt('permanent');
    else if (state.filter === 'trash') showDeletePrompt(deleteMode());
    else void moveToTrash();
    return;
  }
  if (event.key.toLowerCase() === 'r' && state.filter === 'trash') { event.preventDefault(); void restoreFromTrash(); return; }
  if (event.key.toLowerCase() === 'b') { event.preventDefault(); togglePane('sources'); return; }
  if (event.key.toLowerCase() === 'i') { event.preventDefault(); togglePane('details'); return; }
  if (event.key === 'ArrowLeft') { event.preventDefault(); navigate(-1, event.shiftKey); }
  else if (event.key === 'ArrowRight') { event.preventDefault(); navigate(1, event.shiftKey); }
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); navigate((event.key === 'ArrowDown' ? 1 : -1) * (state.mode === 'grid' ? gridLayout().columns : 1), event.shiftKey && state.mode === 'grid');
  }
  else if (event.key.toLowerCase() === 'p') { event.preventDefault(); void decide({ flag: 'pick' }); }
  else if (event.key.toLowerCase() === 'x') { event.preventDefault(); void decide({ flag: 'reject' }); }
  else if (event.key.toLowerCase() === 'u') { event.preventDefault(); void decide({ flag: 'none' }); }
  else if (/^[0-5]$/.test(event.key)) { event.preventDefault(); void decide({ rating: Number(event.key) }); }
  else if (/^[6-9]$/.test(event.key)) { event.preventDefault(); void decide({ color: String(Number(event.key) - 5) }); }
  else if (event.key === ' ') {
    event.preventDefault();
    if (photo()) {
      if (state.mode !== 'review') setMode('review'); else toggleZoom();
    }
  }
  else if (event.key.toLowerCase() === 'g') { event.preventDefault(); setMode('grid'); }
  else if (event.key.toLowerCase() === 'e') { event.preventDefault(); setMode('review'); }
  else if (event.key === '?') { event.preventDefault(); $('help-dialog').showModal(); }
});

// Deletion. Camera cards have no trash, so photos there are always deleted
// permanently; elsewhere the user's last choice is remembered in settings.
// PhotoCull's own Trash view is "Trash"; the operating system's is named here.
const systemTrash = api.platform === 'win32' ? 'Recycle Bin' : 'system Trash';
function trashAvailable() { return api.canTrash && !state.session?.removable; }
function deleteMode() { return trashAvailable() ? state.settings.deleteMode || 'trash' : 'permanent'; }
function plural(count, word) { return `${count} ${word}${count === 1 ? '' : 's'}`; }
async function deletePhotos(ids, mode) {
  if (!state.session || !ids.length || state.deleting || state.copy.running || state.busy) return null;
  const sessionId = state.session.id;
  // Copying or opening another folder mid-deletion is refused here and in the backend.
  state.deleting = true; setDeleting(true); setStatus(mode === 'trash' ? `Moving to the ${systemTrash}…` : 'Deleting…');
  try {
    const result = await api.deletePhotos(sessionId, ids, mode);
    if (state.session?.id !== sessionId) return result;
    removeFromSession(result.deleted);
    const done = mode === 'trash' ? `Moved ${plural(result.deleted.length, 'photo')} to the ${systemTrash}` : `Deleted ${plural(result.deleted.length, 'photo')}`;
    toast(result.warning ? `${done}. ${result.warning}` : result.failures.length ? `${done}; ${result.failures.length} failed: ${result.failures[0].name}: ${result.failures[0].reason}` : done);
    setStatus(result.warning ? 'Session not saved' : 'Saved', !!result.warning);
    return result;
  } catch (error) { toast(error.message); setStatus('Delete failed', true); return null; }
  finally { state.deleting = false; setDeleting(false); }
}
function setDeleting(value) {
  $('open-folder').disabled = value; $('empty-open').disabled = value; $('export').disabled = value || !state.session?.items.length;
  render(); renderDevices(); renderCopyOptions();
}
function removeFromSession(ids) {
  if (!ids.length) return;
  const gone = new Set(ids), before = filtered();
  if (before.some(i => gone.has(i.id) && state.marked.has(i.id))) {
    state.selected = nextSurvivor(before, gone)?.id ?? null; resetSelection();
  }
  state.session.items = state.session.items.filter(i => !gone.has(i.id));
  for (const id of gone) { gridNodes.get(id)?.remove(); gridNodes.delete(id); filmNodes.delete(id); }
  filmSignature = ''; $('review-image').dataset.itemId = ''; $('review-image').dataset.stamp = '';
  $('folder-detail').textContent = `${state.session.items.length} photos`;
  $('export').disabled = !state.session.items.length;
}
async function moveToTrash() {
  const item = photo(), count = selection().length;
  if (!item || item.trashed || state.deleting) return;
  await decide({ trashed: true });
  toast(`Moved ${count > 1 ? plural(count, 'photo') : item.name} to Trash · ${api.platform === 'darwin' ? '⌘' : 'Ctrl+'}Z to undo`);
}
async function restoreFromTrash() {
  const item = photo(), count = selection().length;
  if (!item?.trashed || state.deleting) return;
  await decide({ trashed: false });
  toast(`Restored ${count > 1 ? plural(count, 'photo') : item.name}`);
}
$('trash-restore').onclick = () => void restoreFromTrash();
function showDeletePrompt(mode) {
  const item = photo();
  if (!item || state.deleting || state.copy.running || state.busy) return;
  if (!trashAvailable()) mode = 'permanent';
  const ids = selection().map(i => i.id);
  deletePrompt = { ids, mode, session: state.session.id, view: viewKey() };
  const name = ids.length > 1 ? plural(ids.length, 'photo') : `${item.name}${item.paired ? ' + JPEG' : ''}`;
  $('delete-prompt-text').textContent = `${mode === 'trash' ? 'Move' : 'Permanently delete'} ${name}${mode === 'trash' ? ` to the ${systemTrash}` : ''}?`;
  $('delete-prompt').hidden = false;
}
function hideDeletePrompt() { deletePrompt = null; $('delete-prompt').hidden = true; }
async function confirmDeletePrompt() {
  if (!deletePrompt) return;
  const { ids, mode, session, view } = deletePrompt; hideDeletePrompt();
  const visible = new Set(filtered().map(i => i.id));
  if (state.session?.id !== session || viewKey() !== view || !sameIds(ids) || !ids.every(id => visible.has(id)) || document.querySelector('dialog[open]')) return;
  await deletePhotos(ids, mode);
}
document.addEventListener('pointerdown', () => { if (deletePrompt) hideDeletePrompt(); }, true);
// The dialog's selection is its own state: saving the preference happens in
// the background and its replies must not change what the user sees chosen.
let deleteChoice = 'trash', deleteSaves = 0;
function renderDeleteMode() {
  const trash = trashAvailable(), mode = trash ? deleteChoice : 'permanent';
  $('delete-mode-trash').disabled = !trash; $('delete-mode-trash').nextElementSibling.textContent = `Move to ${systemTrash}`;
  $('delete-mode-trash').checked = mode === 'trash'; $('delete-mode-permanent').checked = mode === 'permanent';
  $('delete-note').textContent = !api.canTrash ? 'The Trash is only available in the desktop app. Files are deleted permanently.'
    : state.session?.removable ? 'Camera cards have no Trash, so these files are deleted permanently.'
    : mode === 'permanent' ? 'Files are deleted immediately and cannot be recovered.' : `You can restore them from the ${systemTrash}.`;
  $('delete-confirm').textContent = mode === 'trash' ? `Move to ${systemTrash}` : 'Delete permanently';
}
// The delete dialog empties either the Rejects view or PhotoCull's Trash.
let deleteScope = 'reject';
function scopeItems(scope) {
  const items = state.session?.items ?? [];
  return scope === 'trash' ? items.filter(i => i.trashed) : items.filter(i => i.flag === 'reject' && !i.trashed);
}
$('delete-rejects').onclick = () => openDeleteDialog('reject');
$('empty-trash').onclick = () => openDeleteDialog('trash');
function openDeleteDialog(scope) {
  const rejects = scopeItems(scope);
  if (!rejects.length) return;
  deleteScope = scope;
  const bytes = rejects.reduce((total, i) => total + i.size, 0), pairs = rejects.filter(i => i.paired).length;
  $('delete-title').textContent = scope === 'trash' ? `Empty trash · ${plural(rejects.length, 'photo')}` : `Delete ${plural(rejects.length, 'rejected photo')}`;
  $('delete-scope').textContent = `${fileSize(bytes)}${pairs ? ` · ${plural(pairs, 'RAW + JPEG pair')}` : ''}. Companion JPEGs and XMP sidecars are deleted with them.`;
  $('delete-status').textContent = ''; $('delete-results').hidden = true; $('delete-confirm').disabled = false;
  deleteChoice = deleteMode(); renderDeleteMode(); $('delete-dialog').showModal(); $('delete-cancel').focus();
}
for (const input of document.querySelectorAll('input[name=delete-mode]')) input.onchange = async () => {
  deleteChoice = input.value; renderDeleteMode();
  state.settings = { ...state.settings, deleteMode: input.value };
  const save = ++deleteSaves;
  try { const saved = await api.settings({ deleteMode: input.value }); if (save === deleteSaves) state.settings = saved; } catch (error) { toast(error.message); }
};
$('delete-cancel').onclick = () => $('delete-dialog').close();
$('delete-confirm').onclick = async () => {
  // Re-read the photos at confirm time; decisions may have changed since the dialog opened.
  const ids = scopeItems(deleteScope).map(i => i.id);
  const mode = trashAvailable() ? deleteChoice : 'permanent';
  $('delete-confirm').disabled = true; $('delete-status').textContent = mode === 'trash' ? `Moving to the ${systemTrash}…` : 'Deleting…';
  const result = await deletePhotos(ids, mode);
  if (result && !result.failures.length && !result.warning) { $('delete-dialog').close(); return; }
  $('delete-status').textContent = result ? `${result.deleted.length} deleted · ${result.failures.length} failed${result.warning ? ` · ${result.warning}` : ''}` : 'Nothing was deleted.';
  if (result?.failures.length) { $('delete-results').hidden = false; $('delete-results').textContent = result.failures.map(f => `${f.name}: ${f.reason}`).join('\n'); }
  $('delete-confirm').disabled = false;
};
$('delete-dialog').addEventListener('cancel', event => { if (state.deleting) event.preventDefault(); });

let settingsDraft = null, namingTimer, namingGeneration = 0;
const clone = value => structuredClone(value);
function colorOf(item) { return item.color ?? (state.settings.metadata?.[item.flag + 'Color'] || ''); }
function renderColorLabels(item) {
  const palette = JSON.stringify(state.settings.colors);
  if ($('color-labels').dataset.palette !== palette) {
    $('color-labels').dataset.palette = palette;
    $('color-labels').replaceChildren(...state.settings.colors.map(color => {
      const button = document.createElement('button'); button.className = 'color-dot'; button.dataset.color = color.id;
      button.style.setProperty('--label-color', color.hex); button.title = `${color.name} (Alt+${color.id})`; button.setAttribute('aria-label', color.name);
      button.onclick = () => decide({ color: photo() && colorOf(photo()) === color.id ? '' : color.id }); return button;
    }));
    const clear = document.createElement('button'); clear.className = 'color-dot clear'; clear.textContent = '×'; clear.title = 'Clear color (Alt+0)'; clear.setAttribute('aria-label', 'Clear color'); clear.onclick = () => decide({ color: '' }); $('color-labels').append(clear);
  }
  $('color-labels').querySelectorAll('[data-color]').forEach(button => { const active = colorOf(item) === button.dataset.color; button.setAttribute('aria-pressed', String(active)); button.classList.toggle('active', active); });

}
function option(value, label) { const node = document.createElement('option'); node.value = value; node.textContent = label; return node; }
function syncSettings(value) {
  state.settings = value; state.settingsReady = true;
  state.zoomPercent = value.zoomPercent;
  if (![...$('zoom-percent').options].some(option => Number(option.value) === value.zoomPercent)) $('zoom-percent').append(option(String(value.zoomPercent), `${value.zoomPercent}%`));
  $('zoom-percent').value = String(value.zoomPercent); applyZoom();
  $('auto-advance').checked = value.autoAdvance; $('recursive').checked = value.recursive; $('raw-rendering').value = value.rawRendering;
  $('copy-jpeg').checked = value.copyJpeg; $('copy-xmp').checked = value.copyXmp; $('copy-metadata').checked = value.copyMetadata; fillFolders('copy', value.folders);
  $('copy-preset').replaceChildren(...value.presets.map(p => option(p.id, p.name))); $('copy-preset').value = value.activePreset;
  const filter = state.colorFilter;
  $('color-filter').replaceChildren(option('', 'All colors'), ...value.colors.map(c => option(c.id, c.name))); $('color-filter').value = filter;
  buildNaming('copy', value.naming);
  if (state.session) { gridNodes.clear(); $('grid-content').replaceChildren(); render(); }
  receiveDevices({ devices: state.devices, error: state.deviceError });
}
$('color-filter').onchange = () => { state.colorFilter = $('color-filter').value; render(true); };
function setSettingsTab(name) {
  document.querySelectorAll('[data-settings-tab]').forEach(button => { const active = button.dataset.settingsTab === name; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  document.querySelectorAll('[data-settings-page]').forEach(section => { section.hidden = section.dataset.settingsPage !== name; });
}
document.querySelectorAll('[data-settings-tab]').forEach(button => { button.onclick = () => setSettingsTab(button.dataset.settingsTab); });
function buildNaming(prefix, value) {
  const host = $(`${prefix}-naming-fields`); host.className = 'naming-fields';
  host.replaceChildren();
  const choices = [['{filename}', 'Original filename'], ['{text}_{seq:4}', 'Custom text + sequence'], ['{capturedate}_{filename}', 'Capture date + filename'], ['{date}_{seq:4}', 'Export date + sequence'], ['custom', 'Custom template']];
  const select = document.createElement('select'); select.id = `${prefix}-name-format`; select.setAttribute('aria-label', 'Filename format');
  select.append(...choices.map(([key, label]) => option(key, label)));
  select.value = choices.some(([key]) => key === value.template) ? value.template : 'custom';
  const field = (label, input) => { const row = document.createElement('div'); row.className = 'field-row'; const text = document.createElement('label'); text.htmlFor = input.id; text.textContent = label; row.append(text, input); host.append(row); return row; };
  field('Format', select);
  const template = document.createElement('input'); template.id = `${prefix}-name-template`; template.value = value.template; template.maxLength = 180;
  const templateRow = field('Template', template);
  const text = document.createElement('input'); text.id = `${prefix}-name-text`; text.value = value.text; text.maxLength = 80;
  field('Text', text);
  const start = document.createElement('input'); start.id = `${prefix}-name-start`; start.type = 'number'; start.min = '1'; start.max = '999999999'; start.value = value.start;
  field('Start', start);
  const tokens = document.createElement('div'); tokens.className = 'namer-tokens';
  for (const token of ['{filename}', '{text}', '{capturedate}', '{date}', '{seq:4}']) {
    const button = document.createElement('button'); button.textContent = token; button.type = 'button'; button.onclick = () => { select.value = 'custom'; templateRow.hidden = false; template.setRangeText(token, template.selectionStart, template.selectionEnd, 'end'); template.focus(); changed(); }; tokens.append(button);
  }
  host.append(tokens);
  function changed() {
    templateRow.hidden = select.value !== 'custom'; tokens.hidden = select.value !== 'custom';
    if (prefix === 'copy') { void updateNamePreview(); }
    else void updateSettingsNamePreview();
  }
  select.onchange = () => { if (select.value !== 'custom') template.value = select.value; changed(); if (prefix === 'copy') { renderCopyOptions(); if ($('copy-folder-mode').value !== 'named' || $('copy-folder-name').value.trim()) void saveCopyDefaults(); } };
  for (const input of [template, text, start]) { input.oninput = changed; if (prefix === 'copy') input.onchange = () => void saveCopyDefaults(); }
  changed();
}
function readNaming(prefix) { return { template: $(`${prefix}-name-template`).value, text: $(`${prefix}-name-text`).value, start: Number($(`${prefix}-name-start`).value) }; }
async function updateNamePreview() {
  const generation = ++namingGeneration; clearTimeout(namingTimer);
  namingTimer = setTimeout(async () => {
    if (!state.session || !$('copy-name-template')) { $('copy-name-preview').textContent = ''; return; }
    try { const name = await api.namingPreview(state.session.id, readNaming('copy')); if (generation === namingGeneration) $('copy-name-preview').textContent = name; }
    catch (error) { if (generation === namingGeneration) $('copy-name-preview').textContent = error.message; }
  }, 180);
}
let settingsNameGeneration = 0;
async function updateSettingsNamePreview() {
  const generation = ++settingsNameGeneration;
  try {
    const naming = readNaming('settings');
    const name = state.session ? await api.namingPreview(state.session.id, naming) : PhotoCullNaming.renderName('DSC0001.ARW', naming, 0, { captured: new Date().toISOString() }).filename;
    if (generation === settingsNameGeneration) $('settings-name-preview').textContent = name;
  } catch (error) { if (generation === settingsNameGeneration) $('settings-name-preview').textContent = error.message; }
}
async function saveCopyDefaults() {
  try { state.settings = await api.settings({ copyJpeg: $('copy-jpeg').checked, copyXmp: $('copy-xmp').checked, copyMetadata: $('copy-metadata').checked, naming: readNaming('copy'), folders: readFolders('copy') }); }
  catch (error) { $('copy-name-preview').textContent = error.message; }
}
function fillSettings(value) {
  $('auto-advance').checked = value.autoAdvance; $('recursive').checked = value.recursive; $('auto-open-cards').checked = value.autoOpenCards;
  $('preview-cache-limit').value = String(value.previewCacheGB); void showCacheUsage();
  $('raw-rendering').value = value.rawRendering; $('default-jpeg').checked = value.copyJpeg; $('default-xmp').checked = value.copyXmp; $('default-metadata').checked = value.copyMetadata; fillFolders('settings', value.folders);
  $('metadata-preset').replaceChildren(...state.settings.presets.map(p => option(p.id, p.name))); $('metadata-preset').value = value.activePreset;
  $('preset-delete').disabled = !/^[\da-f-]{36}$/i.test(value.activePreset);
  for (const [id, key] of [['write-ratings','writeRatings'], ['write-labels','writeLabels'], ['reject-rating','rejectRating']]) $(id).checked = value.metadata[key];
  for (const flag of ['pick','reject']) { $(`${flag}-color`).replaceChildren(option('', 'None'), ...value.colors.map(c => option(c.id, c.name))); $(`${flag}-color`).value = value.metadata[flag + 'Color']; }
  for (const key of ['creator','copyright','title','caption']) $(`meta-${key}`).value = value.metadata[key];
  $('meta-keywords').value = value.metadata.keywords.join(', ');
  $('color-settings').replaceChildren(...value.colors.map(color => {
    const row = document.createElement('div'); row.className = 'color-setting'; row.dataset.id = color.id;
    for (const [kind, val, label] of [['hex',color.hex,'Color'],['name',color.name,'Name'],['label',color.label,'XMP label']]) {
      const input = document.createElement('input'); input.type = kind === 'hex' ? 'color' : 'text'; input.value = val; input.dataset.field = kind; input.setAttribute('aria-label', `${label} ${color.id}`); input.maxLength = kind === 'name' ? 64 : 128; row.append(input);
    }
    return row;
  }));
  buildNaming('settings', value.naming);
  $('metadata-results').hidden = true; $('export-xmp').disabled = !state.session?.items.some(i => i.edited); $('export-json').disabled = !state.session;
}
function readSettings() {
  const value = clone(settingsDraft);
  value.autoAdvance = $('auto-advance').checked; value.recursive = $('recursive').checked; value.autoOpenCards = $('auto-open-cards').checked;
  value.previewCacheGB = Number($('preview-cache-limit').value);
  value.rawRendering = $('raw-rendering').value; value.copyJpeg = $('default-jpeg').checked; value.copyXmp = $('default-xmp').checked; value.copyMetadata = $('default-metadata').checked; value.folders = readFolders('settings');
  value.activePreset = $('metadata-preset').value;
  for (const [id,key] of [['write-ratings','writeRatings'],['write-labels','writeLabels'],['reject-rating','rejectRating']]) value.metadata[key] = $(id).checked;
  for (const flag of ['pick','reject']) value.metadata[flag + 'Color'] = $(`${flag}-color`).value;
  for (const key of ['creator','copyright','title','caption']) value.metadata[key] = $(`meta-${key}`).value;
  value.metadata.keywords = $('meta-keywords').value.split(',').map(v => v.trim()).filter(Boolean);
  value.colors = [...$('color-settings').children].map(row => ({ id: row.dataset.id, ...Object.fromEntries([...row.querySelectorAll('input')].map(input => [input.dataset.field, input.value])) }));
  value.naming = readNaming('settings'); return value;
}
async function openSettings(tab = 'general') {
  if (state.copy.running) return;
  try { const value = await api.settings(); state.settings = value; settingsDraft = clone(value); fillSettings(settingsDraft); setSettingsTab(tab); $('settings-status').textContent = value.warning || ''; $('settings-dialog').showModal(); }
  catch (error) { toast(error.message); }
}
// The preview cache is disposable: clearing only costs regenerating previews.
async function showCacheUsage() {
  try { const usage = await api.previewCache(); $('preview-cache-usage').textContent = `Using ${fileSize(usage.bytes)}`; }
  catch (error) { $('preview-cache-usage').textContent = error.message; }
}
$('preview-cache-clear').onclick = async () => {
  $('preview-cache-clear').disabled = true;
  try { const result = await api.clearPreviewCache(); $('preview-cache-usage').textContent = `Cleared ${fileSize(result.freed)} · using ${fileSize(result.bytes)}`; }
  catch (error) { $('preview-cache-usage').textContent = error.message; }
  finally { $('preview-cache-clear').disabled = false; }
};
$('settings-open').onclick = () => openSettings();
$('copy-settings').onclick = () => openSettings('metadata');
$('settings-folder').onclick = () => { void api.settingsFolder().catch(error => { $('settings-status').textContent = error.message; }); };
$('settings-cancel').onclick = () => $('settings-dialog').close();
$('settings-save').onclick = async () => {
  $('settings-save').disabled = true;
  try { const oldPolicy = state.settings.rawRendering; syncSettings(await api.settings(readSettings())); if (oldPolicy !== state.settings.rawRendering) refreshPreviews(); $('settings-dialog').close(); }
  catch (error) { $('settings-status').textContent = error.message; }
  finally { $('settings-save').disabled = false; }
};
$('metadata-preset').onchange = () => {
  const value = readSettings(), preset = state.settings.presets.find(p => p.id === $('metadata-preset').value);
  settingsDraft = { ...value, activePreset: preset.id, metadata: clone(preset.metadata), colors: clone(preset.colors), naming: clone(preset.naming), folders: clone(preset.folders) }; fillSettings(settingsDraft);
};
$('preset-save').onclick = async () => {
  $('preset-save').disabled = true;
  try {
    const draft = readSettings(), result = await api.savePreset($('preset-name').value, draft);
    state.settings = result.settings; settingsDraft = { ...draft, activePreset: result.preset.id };
    fillSettings(settingsDraft); $('preset-name').value = ''; $('settings-status').textContent = 'Preset saved';
  } catch (error) { $('settings-status').textContent = error.message; }
  finally { $('preset-save').disabled = false; }
};
$('preset-delete').onclick = async () => {
  try { const draft = readSettings(); state.settings = await api.deletePreset(draft.activePreset); settingsDraft = { ...draft, activePreset: 'standard' }; fillSettings(settingsDraft); }
  catch (error) { $('settings-status').textContent = error.message; }
};
$('copy-preset').onchange = async () => {
  $('copy-start').disabled = true;
  try {
    const preset = state.settings.presets.find(p => p.id === $('copy-preset').value);
    syncSettings(await api.settings({ activePreset: preset.id, metadata: preset.metadata, colors: preset.colors, naming: preset.naming, folders: preset.folders })); renderCopyOptions();
  } catch (error) { $('copy-status').textContent = error.message; }
};
$('export-dialog').addEventListener('close', () => { $('copy-progress').hidden = true; $('copy-status').textContent = ''; });
void api.settings().then(syncSettings).catch(error => toast(error.message));

// Browser mode lets smoke tests open a folder without a native dialog.
if (api.platform === 'web') window.loadTestFolder = async (folder, recursive) => loadSession(await api.openPath(folder, recursive));
render();
