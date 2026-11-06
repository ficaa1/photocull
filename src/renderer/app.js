const api = window.photocull;
const $ = id => document.getElementById(id);
const state = { deleting: false, session: null, selected: null, marked: new Set(), anchor: null, filter: 'all', query: '', mode: 'review', fullscreen: false,
  generation: 0, previewRevision: 0, showOriginal: false, pendingSaves: 0, saveError: false, busy: false, settings: { autoAdvance: true, recursive: false, autoOpenCards: true, colors: [], naming: { template: '{filename}', text: '', start: 1 } }, settingsReady: false, colorFilter: '', devices: [], deviceError: '', autoOpened: new Set(), copy: { running: false, destination: null, copiedTo: null } };
let toastTimer, metadataTimer, framePending = false, handoffUsageKey = '', handoffUsageGeneration = 0;
const gridNodes = new Map(), filmNodes = new Map();
let filmSignature = '';
const culling = { metadata:new Map(), jobs:new Map(), scores:new Map(), bursts:[], byId:new Map(), expanded:new Set(), epoch:0, paused:false, running:false };
let survey, burstPrompt=null;
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
  requestGrid(); loupe.layout();
}
function togglePane(pane) {
  if (matchMedia('(max-width: 900px)').matches) document.body.classList.toggle(pane === 'sources' ? 'mobile-sources' : 'mobile-details');
  else { layoutPrefs[pane] = !layoutPrefs[pane]; storeLayout(); }
  applyPaneLayout();
}
$('toggle-sidebar').onclick = () => togglePane('sources'); $('toggle-inspector').onclick = () => togglePane('details');
$('grid-size').value = layoutPrefs.gridSize; $('grid-size').oninput = () => { layoutPrefs.gridSize = Number($('grid-size').value); storeLayout(); requestGrid(); };
// The single-photo view: zoom, pan, navigator and which preview size to load (loupe.js).
const loupe = PhotoCullLoupe.create({ api,
  elements: { viewport: $('image-viewport'), image: $('review-image'), loading: $('image-loading'), error: $('image-error'), retry: $('retry-preview'),
    previewSource: $('preview-source'), previewStatus: $('preview-status'), cameraBadge: $('camera-preview'), zoomFit: $('zoom'), zoomFill: $('zoom-fill'),
    zoomPercent: $('zoom-percent'), zoomLevel: $('zoom-level'), navigator: $('navigator'), navigatorImage: $('navigator-image'), navigatorView: $('navigator-view'),
    navigatorPanel: $('navigator-panel'), navigatorDock: $('navigator-dock'), navigatorOverlay: $('navigator-overlay'), navigatorZoom: $('navigator-zoom'), inspector: $('inspector') },
  imageUrl: (item, kind, extra = '') => api.imageUrl(state.session.id, item.id, kind, `&d=${item.developRevision || 0}&edit=${item.externalEdit ? 1 : 0}&v=${state.previewRevision}${state.showOriginal ? '&original=1' : ''}${extra}`),
  context: () => ({ session: state.session, items: state.session ? filtered() : [], mode: state.mode, revision: state.previewRevision, original: state.showOriginal, fullscreen: state.fullscreen }),
  settings: () => state.settings,
  onLoaded: item => { void loadMetadata(item); },
  onClickZoomChange: async percent => { try { state.settings = await api.settings({ zoomPercent: percent }); } catch (error) { toast(error.message); } } });
matchMedia('(max-width: 900px)').addEventListener('change', applyPaneLayout);
applyPaneLayout();
// Develop owns its controls and render queue; app hooks keep selection and badges shared.
const developView = PhotoCullDevelop.init({ api, selection, toast, status: setStatus, settings: () => state.settings, editorName, openEditors: () => openSettings('editors'), setBusy: value => { state.busy=value; render(); },
  updateItems(session, items) {
    if (state.session?.id !== session) return;
    let changed=false;
    for(const patch of items){const item=state.session.items.find(i=>i.id===patch.id);if(item){changed ||= 'externalEdit' in patch && (item.externalEdit!==patch.externalEdit || item.developRevision!==patch.developRevision);Object.assign(item,patch);}}
    if(changed)refreshPreviews();else render();
  },
  viewResult(session,id) { if(state.session?.id!==session)return; state.selected=id; resetSelection(); setMode('develop'); developView.key=''; render(); },
  async saveSettings(patch) { state.settings = await api.settings(patch); return state.settings; },
});

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
      state.filter === 'external' && item.externalEdit || state.filter === 'rated' && item.rating > 0 || item.flag === state.filter);
    return match && (!state.colorFilter || colorOf(item) === state.colorFilter) && item.name.toLowerCase().includes(state.query);
  });
}
function imageUrl(item, kind = 'thumb', prefetch = false) {
  return api.imageUrl(state.session.id, item.id, kind, `&d=${item.developRevision || 0}&edit=${item.externalEdit ? 1 : 0}&v=${state.previewRevision}${state.showOriginal ? '&original=1' : ''}${prefetch ? '&prefetch=1' : ''}`);
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
  if(state.mode==='compare')state.mode='review';
  cancelCulling();culling.metadata.clear();culling.jobs.clear();culling.scores.clear();culling.expanded.clear();culling.bursts=[];culling.byId.clear();
  state.session = session; state.selected = session.items[0]?.id ?? null;
  resetSelection();
  state.showOriginal = false; state.filter = 'all'; state.colorFilter = ''; $('color-filter').value = ''; state.query = ''; state.saveError = false; loupe.reset();
  $('search').value = ''; $('grid').scrollTop = 0;
  const folderName = session.folder.split(/[\\/]/).filter(Boolean).pop();
  $('folder-name').textContent = folderName; $('folder-name').title = session.folder;
  $('folder-detail').textContent = `${session.items.length} photos`;
  $('breadcrumb').textContent = session.folder;
  $('breadcrumb').title = session.folder;
  $('export').disabled = !session.items.length;
  gridNodes.clear(); filmNodes.clear(); filmSignature = ''; $('grid-content').replaceChildren();
  render(); renderDevices();
  setStatus('Saved');void analyzeCulling();
  if (session.warnings.length) toast(`${session.warnings.length} file or sidecar warning(s): ${session.warnings[0]}`);
  const missingHandoffs = session.items.filter(i => i.handoffMissing).length;
  if (missingHandoffs) toast(`${missingHandoffs} external edit(s) missing. Showing original photos; copy the hand-off folder alongside the photos.`);
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
    const row=document.createElement('div');row.append(button,deviceBackupRow(device));return row;
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
  for(const device of state.devices)if(!snapshot.devices.some(d=>d.id===device.id))cardStatuses.delete(device.root);
  for(const device of snapshot.devices)if(Object.hasOwn(device,'backup')){if(device.backup)cardStatuses.set(device.root,device.backup);else cardStatuses.delete(device.root);}
  state.devices = snapshot.devices; state.deviceError = snapshot.error;
  renderDevices();
  const cameras = state.devices.filter(d => d.camera);
  if (state.settingsReady && state.settings.autoOpenCards && !document.querySelector('dialog[open]') && !state.session && !state.busy && cameras.length === 1 && !state.autoOpened.has(cameras[0].id)) {
    state.autoOpened.add(cameras[0].id); void openDevice(cameras[0]);
  } else if (state.session && state.devices.some(d => !previous.has(d.id))) toast('Card connected');
  for (const id of state.autoOpened) if (!state.devices.some(d => d.id === id)) state.autoOpened.delete(id);
}
api.onDevices(receiveDevices);
api.onSidecarWarning(warning => { if (state.session?.id === warning.session) toast(warning.message); });
void api.devices().then(receiveDevices).catch(error => { state.deviceError = error.message; renderDevices(); });

function renderCounts() {
  const all = state.session?.items ?? [], items = all.filter(i => !i.trashed);
  const count = items.filter(reviewed).length;
  $('count-trash').textContent = all.length - items.length;
  $('count-all').textContent = items.length;
  $('count-unreviewed').textContent = items.length - count;
  for (const flag of ['pick', 'reject']) $(`count-${flag}`).textContent = items.filter(i => i.flag === flag).length;
  $('count-external').textContent = items.filter(i => i.externalEdit).length;
  $('count-rated').textContent = items.filter(i => i.rating > 0).length;
  $('progress-text').textContent = `${count} of ${items.length}`;
  $('progress-fill').style.width = `${items.length ? count / items.length * 100 : 0}%`;
  document.querySelectorAll('.filter').forEach(button => { const active = button.dataset.filter === state.filter; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
}

function render(reset = false) {
  renderEditorActions();
  $('image-export').disabled = !state.session?.items.length || state.deleting || state.copy.running;
  renderCounts();
  $('original-toggle').hidden = !state.session?.items.some(i=>i.externalEdit) || state.mode==='develop';
  $('original-toggle').textContent = state.showOriginal ? 'Show External edits (\\)' : 'Show originals (\\)';
  $('original-toggle').setAttribute('aria-pressed',String(state.showOriginal));
  const items = filtered();
  if (!items.some(i => i.id === state.selected)) state.selected = items[0]?.id ?? null;
  const visible = new Set(items.map(i => i.id)), hadMarked = state.marked.size > 0;
  state.marked = new Set([...state.marked].filter(id => visible.has(id)));
  if (hadMarked && state.selected) state.marked.add(state.selected);
  if (reset) resetSelection();
  if (!visible.has(state.anchor)) state.anchor = state.selected;
  survey?.sync(state.mode==='compare');
  $('compare-mode').setAttribute('aria-pressed',String(state.mode==='compare'));
  const loaded = !!state.session?.items.length;
  $('empty').hidden = loaded;
  $('no-matches').hidden = !loaded || !!items.length;
  $('review').hidden = !loaded || !items.length || state.mode !== 'review';
  $('grid').hidden = !loaded || !items.length || state.mode !== 'grid';
  $('grid-size-control').hidden = !loaded || state.mode !== 'grid';
  $('review-mode').setAttribute('aria-pressed', String(state.mode === 'review')); $('grid-mode').setAttribute('aria-pressed', String(state.mode === 'grid'));
  $('review-mode').classList.toggle('active', state.mode === 'review');
  $('grid-mode').classList.toggle('active', state.mode === 'grid');
  $('develop-mode').classList.toggle('active', state.mode === 'develop'); $('develop-mode').setAttribute('aria-pressed', String(state.mode === 'develop'));
  const titles = { all: 'Photos', unreviewed: 'Unreviewed', pick: 'Picks', reject: 'Rejects', rated: 'Rated', external: 'External edits', trash: 'Trash' };
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
  renderCulling();
  if (state.mode === 'grid') requestGrid();
}

function renderSelection() {
  const item = photo();
  developView.sync({ mode: state.mode, session: state.session, photo: item });
  $('image-details').hidden = !item; $('inspector-empty').hidden = !!item;
  if (!item) { state.generation++; loupe.clear(); if (state.fullscreen) void setFullscreen(false); return; }
  const items = filtered(), index = items.findIndex(i => i.id === item.id);
  // Keeps the photo on screen and those prepared ahead in the direction of travel; cancels obsolete work.
  if(state.mode!=='compare')void api.focus(state.session.id, [item.id, ...loupe.select(items, index)]).catch(() => {});
  $('photo-name').textContent = item.externalEdit && !state.showOriginal ? `Edited in ${editorName(item.editedBy)} · ${item.name}` : item.name;
  $('photo-size').textContent = `${fileSize(item.size)}${item.paired ? ' · RAW + JPEG pair' : ''}`;
  $('format-badge').textContent = item.raw ? item.paired ? 'RAW + JPEG' : 'RAW' : item.name.split('.').pop().toUpperCase();
  $('image-position').textContent = `${index + 1} / ${items.length}`;
  renderCulling();
  $('previous').disabled = index <= 0; $('next').disabled = index >= items.length - 1;
  $('detail-name').textContent = item.name;
  $('detail-result').querySelector('.sidebar-label').textContent = `Edited in ${editorName(item.editedBy)}`; $('detail-result-edit').textContent = `Edit in ${editorName(item.editedBy)} again`;
  $('detail-result').hidden = !item.externalEdit; $('detail-result-path').textContent = item.tiff || '';
  if(item.externalEdit && !item.tiff)void api.developGet(state.session.id,item.id).then(saved=>{if(photo()?.id===item.id)$('detail-result-path').textContent=saved.tiff || '';}).catch(()=>{});
  $('detail-kind').textContent = `${item.raw ? 'Camera RAW' : 'Image'} · ${fileSize(item.size)}${item.paired ? ' · paired JPEG' : ''}`;
  renderDecision(item);
  renderColorLabels(item);
  renderFilmstrip(items, index);
  if (state.mode === 'review') loupe.show(item);
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

api.onPreviewState(status => {
  if(status.state==='invalidated' && state.session?.items.some(i=>i.id===status.id)){refreshPreviews();return;}
  if (status.id !== state.selected || state.mode !== 'review' || $('review-image').dataset.complete) return;
  if (status.state === 'queued' || status.state === 'rendering') {
    $('image-loading').hidden = false;
    $('image-loading').textContent = status.state === 'queued' ? 'RAW render queued…' : 'Developing RAW sensor data…';
  }
});

function refreshPreviews() {
  state.previewRevision++; state.generation++;
  gridNodes.clear(); $('grid-content').replaceChildren();
  loupe.invalidate();
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
    const metadata = await api.metadata(sessionId,imageId,loupe.kind());
    if(state.session?.id===sessionId)culling.metadata.set(imageId,metadata);
    if (state.selected !== imageId || state.session.id !== sessionId || state.generation !== generation) return;
    const rows = [['Camera', metadata.camera], ['Lens', metadata.lens], ['Exposure', [metadata.shutter ? `${metadata.shutter} s` : '', metadata.aperture, metadata.iso ? `ISO ${metadata.iso}` : ''].filter(Boolean).join(' · ')],
      ['Captured', formatCaptureDate(metadata.captured)], ['Autofocus', metadata.focus?.source], ['Sharpness', Number.isFinite(culling.scores.get(imageId)) ? culling.scores.get(imageId).toFixed(1) + ' · preview detail' : api.canAnalyze ? 'Pending analysis' : 'Desktop app required'], ['Preview', metadata.width && metadata.height ? `${metadata.width} × ${metadata.height}` : ''], ['Source', metadata.source], ['Develop', item.externalEdit ? `Edited in ${editorName(item.editedBy)} · open Develop to view` : item.developed ? 'Developed hand-off' : item.adjusted ? 'RAW adjustments' : '']];
    $('metadata').replaceChildren(...rows.flatMap(([name, value]) => {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = name; dd.textContent = value || '—'; return [dt, dd];
    }));
    $('preview-source').textContent = metadata.source || item.source;
    applyFocus();
  } catch { if (state.selected === imageId) $('metadata').textContent = 'Metadata unavailable'; }
}

function renderFilmstrip(items, index) {
  items=stackItems(items);index=items.findIndex(i=>i.id===state.selected);
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
    button.querySelectorAll('.mini-flag, .mini-color, .develop-badges, .burst-badge, .sharpest-badge').forEach(node => node.remove()); addFlag(button, item); return button;
  });
  if (signature !== filmSignature) { $('filmstrip').replaceChildren(...nodes); filmSignature = signature; }
  const retained = new Set(nearby.map(item => item.id)); for (const id of filmNodes.keys()) if (!retained.has(id)) filmNodes.delete(id);

}

function addFlag(node, item) {
  addBurstBadges(node,item);
  const marks = [item.adjusted && 'Adjusted', item.developed && 'Hand-off', item.externalEdit && `Edited in ${editorName(item.editedBy)}`].filter(Boolean);
  if (marks.length) { const badge = document.createElement('span'); badge.className = 'develop-badges'; badge.textContent = marks.map(m => m === 'Adjusted' ? '±' : m === 'Hand-off' ? 'H' : 'E').join(' '); badge.title = marks.join(' · '); node.append(badge); }
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
  const viewport = $('grid'), container = $('grid-content'), items = stackItems(filtered());
  const { columns, width, rowHeight } = gridLayout();
  container.style.height = `${Math.ceil(items.length / columns) * rowHeight}px`;
  const first = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - 1) * columns;
  const last = Math.min(items.length, (Math.ceil((viewport.scrollTop + viewport.clientHeight) / rowHeight) + 1) * columns);
  const retained = new Set();
  for (let i = first; i < last; i++) {
    const item = items[i], signature = `${burstSignature(item)}:${item.id}:${item.flag}:${item.rating}:${item.color}:${item.adjusted}:${item.developed}:${item.externalEdit}:${item.editedBy}:${item.developRevision}:${state.previewRevision}`;
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
  const { columns, width, rowHeight } = gridLayout(), items = stackItems(filtered()), marked = new Set(drag.base);
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
    state.selected = current; state.marked = marked; state.anchor = current; render();
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
    const items = state.mode==='grid' ? stackItems(filtered()) : filtered(), anchor = items.findIndex(i => i.id === state.anchor), index = items.findIndex(i => i.id === id);
    const start = anchor < 0 ? index : anchor;
    state.marked = new Set(items.slice(Math.min(start, index), Math.max(start, index) + 1).map(i => i.id));
    state.selected = id;
  } else if (additive(event)) {
    if (state.marked.has(id)) { state.marked.delete(id); if (state.selected === id) state.selected = state.marked.values().next().value ?? id; }
    else { state.marked.add(id); state.selected = id; }
    state.anchor = id;
  } else { state.selected = id; resetSelection(); }
  // Zoom level and position carry over to the next photo, as in Lightroom.
  // Plain navigation stays on the cheap path; only selection-size changes need the full render.
  if (wasMulti || state.marked.size > 1 || deletePrompt) render(); else renderSelection();
  if (state.mode === 'grid') {
    const items = stackItems(filtered()), index = items.findIndex(i => i.id === id);
    const { columns, rowHeight } = gridLayout();
    const y = Math.floor(index / columns) * rowHeight;
    if (y < $('grid').scrollTop) $('grid').scrollTop = y;
    else if (y + rowHeight > $('grid').scrollTop + $('grid').clientHeight) $('grid').scrollTop = y + rowHeight - $('grid').clientHeight;
    requestGrid();
  }
}
function navigate(delta, extend = false) {
  const items = state.mode==='grid' ? stackItems(filtered()) : filtered(), index = items.findIndex(i => i.id === state.selected);
  const next = items[Math.max(0, Math.min(items.length - 1, index + delta))];
  if (next) select(next.id, { shiftKey: extend });
}
function setMode(mode) { if(mode==='compare' && state.mode!=='compare' && !survey.open(selection().map(i=>i.id),filtered()))return toast('Select at least two photos to compare.'); if (mode !== 'review' && state.fullscreen) void setFullscreen(false); loupe.cancelHand(); state.generation++; state.mode = mode; render(); }

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
  if('trashed' in patch)regroupBursts();
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
    regroupBursts();
    state.selected = items[0].id; state.anchor = state.selected; state.marked = new Set(items.map(i => i.id));
    render(); setStatus('Saved');
  } catch (e) { toast(e.message); }
}

api.onEdit(() => hideDeletePrompt());
api.onEdit(direction => { if (['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) document.execCommand(direction); else if (!document.querySelector('dialog[open]')) commands.execute(direction); });
api.onOpenFolder(() => hideDeletePrompt());
api.onOpenFolder(() => { if (!document.querySelector('dialog[open]')) commands.execute('open'); });
api.onSettings(() => hideDeletePrompt());
api.onSettings(() => { if (!document.querySelector('dialog[open]')) commands.execute('settings'); });
document.body.classList.toggle('platform-mac', api.platform === 'darwin');
if (api.platform === 'darwin') document.querySelectorAll('#help-dialog kbd').forEach(key => { key.textContent = key.textContent.replaceAll('Ctrl', '⌘').replaceAll('Alt', '⌥'); });
$('open-folder').onclick = openFolder; $('empty-open').onclick = openFolder;
$('review-mode').onclick = () => setMode('review'); $('grid-mode').onclick = () => setMode('grid'); $('develop-mode').onclick = () => setMode('develop');
$('search').oninput = event => { state.query = event.target.value.toLowerCase(); $('grid').scrollTop = 0; render(true); };
document.querySelectorAll('.filter').forEach(button => { button.onclick = () => {
  state.filter = button.dataset.filter; $('grid').scrollTop = 0; render(true);
}; });
$('reset-filter').onclick = () => { state.colorFilter = ''; $('color-filter').value = ''; state.filter = 'all'; state.query = ''; $('search').value = ''; render(true); };
$('previous').onclick = () => navigate(-1); $('next').onclick = () => navigate(1);
$('pick').onclick = () => decide({ flag: photo()?.flag === 'pick' ? 'none' : 'pick' });
$('reject').onclick = () => decide({ flag: photo()?.flag === 'reject' ? 'none' : 'reject' });
$('clear').onclick = () => decide({ flag: 'none' });
let dockTimer, fullscreenRequest = 0, fullscreenPending = 0, fullscreenQueue = Promise.resolve();
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
  requestAnimationFrame(() => loupe.layout());
}
async function setFullscreen(value = !state.fullscreen) {
  if (value && !photo()) return;
  if (value && state.mode !== 'review') setMode('review');
  const request = ++fullscreenRequest, previous = state.fullscreen;
  fullscreenPending++;
  applyFullscreen(value);
  // Native fullscreen transitions are asynchronous. Keep rapid toggles in order,
  // and ignore intermediate native events while a newer target is pending.
  const transition = fullscreenQueue.catch(() => {}).then(() => api.fullscreen(value));
  fullscreenQueue = transition;
  try { const result = await transition; if (request === fullscreenRequest) applyFullscreen(result.fullscreen); }
  catch (error) { if (request === fullscreenRequest) applyFullscreen(previous); toast(error.message); }
  finally { fullscreenPending--; }
}
$('fullscreen').innerHTML = fullscreenIcons.enter;
$('fullscreen').onclick = () => { $('fullscreen').blur(); void setFullscreen(); };
api.onFullscreen(status => { if (!fullscreenPending) applyFullscreen(status.fullscreen); });
api.onFullscreenToggle(() => hideDeletePrompt());
api.onFullscreenToggle(() => { if (!document.querySelector('dialog[open]')) void setFullscreen(); });
$('shortcuts').onclick = () => openHelp();
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
  for (const id of ['copy-verify','copy-metadata','copy-folder-mode','copy-folder-name']) $(id).disabled = state.copy.running;
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
  if (state.busy || state.copy.running || state.pendingSaves || state.deleting) return;
  state.copy.running = true; state.copy.copiedTo = null;
  $('export-results').hidden = true;
  $('copy-status').textContent = 'Checking picked originals…';
  $('open-folder').disabled = true; $('empty-open').disabled = true;
  renderCopyOptions(); renderDevices();
  try {
    const result = await api.copyPicks(state.session.id, state.copy.destination, { verify: $('copy-verify').checked, includeJpeg: $('copy-jpeg').checked, includeXmp: $('copy-xmp').checked, embedMetadata: $('copy-metadata').checked, naming: readNaming('copy'), folders: readFolders('copy') });
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
const commandActions = {
  settings: () => openSettings(), open: () => openFolder(), export: () => imageExport.open(),
  'fullscreen-system': () => setFullscreen(), 'fullscreen-key': () => setFullscreen(), fullscreen: () => setFullscreen(),
  'switch-view': () => setMode(state.mode === 'review' ? 'grid' : 'review'), edit: () => developView.openBatch(), original: () => toggleOriginal(),
  escape: () => { if (state.marked.size > 1) { resetSelection(); render(); } else if (state.fullscreen) return setFullscreen(false); else if (state.mode === 'review' && loupe.zoomed) loupe.fit(); },
  undo: () => history('undo'), redo: () => history('redo'), 'select-all': () => { state.marked = new Set(filtered().map(i => i.id)); render(); },
  delete: () => state.filter === 'trash' ? showDeletePrompt(deleteMode()) : moveToTrash(), 'delete-permanent': () => showDeletePrompt('permanent'), restore: () => restoreFromTrash(),
  sources: () => togglePane('sources'), details: () => togglePane('details'),
  'review-space': () => { if (photo()) setMode('review'); }, 'review-zoom': () => { if (photo()) { setMode('review'); loupe.zoomIn(); } },
  'view-grid': () => setMode('grid'), 'view-review': () => setMode('review'), 'view-develop': () => setMode('develop'), help: () => openHelp(),
  'develop-copy': () => developView.copy(), 'develop-paste': () => developView.paste(), clipping: () => developView.toggleClipping(), before: () => developView.toggleBefore(),
  palette: () => openPalette(), 'go-photo': () => openPalette('> '), backup: () => openBackup(), 'treat-card': () => treatCard(), about: () => openSettings('about'), welcome: () => showWelcome(), diagnostics: () => copyDiagnostics(), logs: () => api.openLogs(),
};
for (let n=0;n<=8;n++) commandActions['color-alt-'+n] = () => decide({ color: n ? String(n) : '' });
for (let n=0;n<=5;n++) commandActions['rating-'+n] = () => decide({ rating: n });
for (let n=6;n<=9;n++) commandActions['color-'+n] = () => decide({ color: String(n-5) });
for (const flag of ['pick','reject','none']) commandActions['flag-'+flag] = () => decide({ flag });
for (const direction of ['left','right','up','down']) for (const extend of [false,true]) commandActions[(extend?'extend-':'navigate-')+direction] = () => navigate((['left','up'].includes(direction)?-1:1) * (['up','down'].includes(direction) && state.mode==='grid' ? gridLayout().columns : 1), extend && (!['up','down'].includes(direction) || state.mode==='grid'));
for (const [id,action] of Object.entries({'zoom-in':'zoom-in','zoom-out':'zoom-out',fit:'fit','zoom-toggle':'toggle',pan:'space'})) commandActions[id] = event => loupe.handleKey(event, action);
let recentCommands = [], panKey = null;
const commands = PhotoCullCommands.create({ platform: api.platform, actions: Object.fromEntries(Object.entries(commandActions).map(([id,run]) => [id,event => {
  if(id==='pan'){if(!event.key)return loupe.handleKey(event,'toggle');panKey=event.code || event.key;}
  try { return Promise.resolve(run(event)).catch(error=>toast(error.message)); } catch(error) { toast(error.message); }
}])), context: () => state.mode, custom: () => state.settings.shortcuts || {},
  enabled: command => (!command.when || state.filter===command.when) && (!/^(flag-|rating-|color-|navigate-|extend-|delete|restore|select-all)/.test(command.id) || !!photo()) && (command.id!=='go-photo'||state.session?.items.some(item=>!item.trashed)) && (!['zoom-in','zoom-out','fit','zoom-toggle','pan','review-zoom'].includes(command.id) || !!photo()),
  onRun: command => { if(command.id!=='palette'){ recentCommands=[command.id,...recentCommands.filter(id=>id!==command.id)].slice(0,12); try{localStorage.setItem('photocull-recent-commands',JSON.stringify(recentCommands));}catch{} } } });
try { recentCommands=JSON.parse(localStorage.getItem('photocull-recent-commands')||'[]').filter(id=>commands.commands.some(c=>c.id===id)).slice(0,12); } catch {}
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
  if (document.querySelector('dialog[open]')) return;
  commands.dispatch(event, { typing: ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable,
    button: document.activeElement?.matches('button, summary') });
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
  regroupBursts();
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
document.addEventListener('keyup', event => {
  const active = document.activeElement;
  if (state.mode !== 'review' || document.querySelector('dialog[open]') || active?.matches('input, textarea, select') || active?.isContentEditable) { loupe.cancelHand(); return; }
  if (panKey && (event.code || event.key) === panKey) { panKey=null; if (loupe.handleKeyUp({ key: ' ' })) event.preventDefault(); }
});
window.addEventListener('blur', () => loupe.cancelHand());
function option(value, label) { const node = document.createElement('option'); node.value = value; node.textContent = label; return node; }
function syncSettings(value) {
  state.settings = value; state.settingsReady = true;
  loupe.setClickPercent(value.zoomPercent);regroupBursts();applyFocus();
  $('default-recipe').value = value.defaultRecipe || 'neutral';
  $('focus-preference').checked=!!value.focusOverlay;$('burst-gap').value=value.burstGap || 1;
  $('auto-advance').checked = value.autoAdvance; $('recursive').checked = value.recursive; $('write-sidecars').value = value.writeSidecars; $('raw-rendering').value = value.rawRendering;
  $('copy-verify').checked = value.copyVerify; $('copy-jpeg').checked = value.copyJpeg; $('copy-xmp').checked = value.copyXmp; $('copy-metadata').checked = value.copyMetadata; fillFolders('copy', value.folders);
  $('copy-preset').replaceChildren(...value.presets.map(p => option(p.id, p.name))); $('copy-preset').value = value.activePreset;
  const filter = state.colorFilter;
  $('color-filter').replaceChildren(option('', 'All colors'), ...value.colors.map(c => option(c.id, c.name))); $('color-filter').value = filter;
  buildNaming('copy', value.naming);
  if (state.session) { gridNodes.clear(); $('grid-content').replaceChildren(); render(); }
  receiveDevices({ devices: state.devices, error: state.deviceError });
}
$('color-filter').onchange = () => { state.colorFilter = $('color-filter').value; render(true); };
function setSettingsTab(name) {
  if (name === 'about') void loadAbout();
  document.querySelectorAll('[data-settings-tab]').forEach(button => { const active = button.dataset.settingsTab === name; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  document.querySelectorAll('[data-settings-page]').forEach(section => { section.hidden = section.dataset.settingsPage !== name; });
}
document.querySelectorAll('[data-settings-tab]').forEach(button => { button.onclick = () => setSettingsTab(button.dataset.settingsTab); });
function buildNaming(prefix, value, onPreview) {
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
    if (onPreview) { void onPreview(); }
    else if (prefix === 'copy') { void updateNamePreview(); }
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
  try { state.settings = await api.settings({ copyVerify: $('copy-verify').checked, copyJpeg: $('copy-jpeg').checked, copyXmp: $('copy-xmp').checked, copyMetadata: $('copy-metadata').checked, naming: readNaming('copy'), folders: readFolders('copy') }); }
  catch (error) { $('copy-name-preview').textContent = error.message; }
}
function fillSettings(value) {
  fillEditors(value);
  $('default-recipe').value = value.defaultRecipe || 'neutral';
  $('focus-preference').checked=!!value.focusOverlay;$('burst-gap').value=value.burstGap || 1;
  $('auto-advance').checked = value.autoAdvance; $('recursive').checked = value.recursive; $('auto-open-cards').checked = value.autoOpenCards; $('zoom-click-center').checked = value.zoomClickCenter;
  $('preview-cache-limit').value = String(value.previewCacheGB); void showCacheUsage();
  $('write-sidecars').value = value.writeSidecars; $('raw-rendering').value = value.rawRendering; $('default-jpeg').checked = value.copyJpeg; $('default-xmp').checked = value.copyXmp; $('default-metadata').checked = value.copyMetadata; fillFolders('settings', value.folders);
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
  fillWorkspaceSettings(value);
  buildNaming('settings', value.naming);
  $('metadata-results').hidden = true; $('export-xmp').disabled = !state.session?.items.some(i => i.edited); $('export-json').disabled = !state.session;
}
function readSettings() {
  const value = clone(settingsDraft);
  readEditors(value); value.defaultRecipe = $('default-recipe').value;
  value.focusOverlay=$('focus-preference').checked;value.burstGap=Number($('burst-gap').value);
  value.autoAdvance = $('auto-advance').checked; value.recursive = $('recursive').checked; value.autoOpenCards = $('auto-open-cards').checked; value.zoomClickCenter = $('zoom-click-center').checked;
  value.previewCacheGB = Number($('preview-cache-limit').value);
  value.writeSidecars = $('write-sidecars').value; value.rawRendering = $('raw-rendering').value; value.copyJpeg = $('default-jpeg').checked; value.copyXmp = $('default-xmp').checked; value.copyMetadata = $('default-metadata').checked; value.folders = readFolders('settings');
  value.activePreset = $('metadata-preset').value;
  for (const [id,key] of [['write-ratings','writeRatings'],['write-labels','writeLabels'],['reject-rating','rejectRating']]) value.metadata[key] = $(id).checked;
  for (const flag of ['pick','reject']) value.metadata[flag + 'Color'] = $(`${flag}-color`).value;
  for (const key of ['creator','copyright','title','caption']) value.metadata[key] = $(`meta-${key}`).value;
  value.metadata.keywords = $('meta-keywords').value.split(',').map(v => v.trim()).filter(Boolean);
  value.colors = [...$('color-settings').children].map(row => ({ id: row.dataset.id, ...Object.fromEntries([...row.querySelectorAll('input')].map(input => [input.dataset.field, input.value])) }));
  readWorkspaceSettings(value); value.naming = readNaming('settings'); return value;
}
async function openSettings(tab = 'general') {
  if (state.copy.running || backupRunning) return;
  try { const value = await api.settings(); state.settings = value; settingsDraft = clone(value); const recipes = await api.recipes(); $('default-recipe').replaceChildren(...recipes.recipes.map(r => option(r.id, r.name))); fillSettings(settingsDraft); setSettingsTab(tab); $('settings-status').textContent = value.warning || ''; $('settings-dialog').showModal(); }
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
let aboutLoaded = false;
async function loadAbout() {
  if (aboutLoaded) return;
  try {
    const info = await api.appInfo();
    $('about-name').textContent = `${info.name} ${info.version}`;
    $('about-copyright').textContent = info.copyright;
    $('about-notices').textContent = info.notices;
    aboutLoaded = true;
  } catch (e) { $('about-status').textContent = e.message; }
}
document.querySelectorAll('[data-project-link]').forEach(link => { link.onclick = event => {
  event.preventDefault(); void Promise.resolve(api.openProjectLink(link.href)).catch(e => { $('about-status').textContent = e.message; });
}; });
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
const imageExport = PhotoCullExport.init({ api, state, selection, buildNaming, readNaming, toast, updateItems: developView.host.updateItems });
void api.settings().then(syncSettings).catch(error => toast(error.message));

// Browser mode lets smoke tests open a folder without a native dialog.
if (api.platform === 'web') window.loadTestFolder = async (folder, recursive) => loadSession(await api.openPath(folder, recursive));
render();

$('handoff-folder-choose').onclick = async () => { try { const folder=await api.pickFolder('Choose a local hand-off folder'); if(folder){await api.developFolderCheck(folder); $('handoff-folder').value=folder;} } catch(e){toast(e.message);} };

function toggleOriginal() { state.showOriginal=!state.showOriginal; refreshPreviews(); }
$('original-toggle').onclick = toggleOriginal;

$('detail-result-reveal').onclick = () => { if(photo())void api.revealDevelop(state.session.id,photo().id).catch(e=>toast(e.message)); };
$('detail-result-edit').onclick = async () => { $('detail-result-edit').disabled=true;try{await developView.reedit();}catch(e){toast(e.message);}finally{$('detail-result-edit').disabled=false;} };

// External editor preferences and shared actions (all selection views).
function editorName(id) { return state.settings.editors?.find(e=>e.id===id)?.name || (id==='dehancer' ? 'Dehancer' : 'External editor'); }
function renderEditorActions() {
  const editor = state.settings.editors?.find(e=>e.id===state.settings.defaultEditor), busy = state.busy || state.copy.running || state.deleting || !!developView.batch || !!developView.editing;
  $('edit-external').textContent = editor ? `Edit in ${editor.name}…` : 'Edit in…';
  $('edit-external').disabled = busy || !state.session || !selection().some(i=>i.raw && !i.trashed);
  developView.batchButton.textContent = $('edit-external').textContent;developView.batchButton.disabled=$('edit-external').disabled;
  const menu = $('external-editor-menu'), signature = JSON.stringify(state.settings.editors?.map(e=>[e.id,e.name]));
  if(menu.dataset.editors!==signature){menu.dataset.editors=signature;menu.replaceChildren(option('','▾'),...(state.settings.editors || []).map(e=>option(e.id,`Edit in ${e.name}…`)));}
  menu.disabled = $('edit-external').disabled;
  $('handoff-cleanup').disabled = !state.session || busy;
  const usageKey = state.session ? `${state.session.id}:${state.session.items.map(i=>i.developRevision || 0).join(',')}` : '';
  if(usageKey!==handoffUsageKey){handoffUsageKey=usageKey;const generation=++handoffUsageGeneration;$('handoff-usage').textContent='';if(state.session)void api.handoffUsage(state.session.id).then(u=>{if(generation===handoffUsageGeneration)$('handoff-usage').textContent=`Hand-off files: ${u.count} · ${fileSize(u.bytes)}`;}).catch(e=>toast(e.message));}
}
$('edit-external').onclick=()=>{void developView.openBatch().catch(e=>toast(e.message));};
$('external-editor-menu').onchange=()=>{const id=$('external-editor-menu').value;$('external-editor-menu').value='';if(id)void developView.openBatch(id).catch(e=>toast(e.message));};
$('handoff-cleanup').onclick=async()=>{
  try {
    const session=state.session.id, usage=await api.handoffUsage(session);
    if(!usage.count)return toast(usage.failures.length ? usage.failures.map(f=>f.error).join(' · ') : 'No hand-off files to clean up.');
    if(await developView.ask(`Delete ${usage.count} hand-off file(s), ${fileSize(usage.bytes)}?\n${usage.entries.map(r=>r.path).join('\n')}`, [['delete','Delete hand-off files'],['cancel','Cancel']])!=='delete')return;
    if(usage.unexported && await developView.ask(`${usage.unexported} external edit(s) have not been exported. Deleting these hand-off files permanently loses those edits.`,[['delete','Delete unexported edits'],['cancel','Keep files']])!=='delete')return;
    developView.host.setBusy(true);
    const result=await api.handoffClean(session,usage.token,!!usage.unexported);
    developView.host.updateItems(session,result.items);handoffUsageKey='';render();
    toast(`${result.deleted.length} hand-off file(s) deleted${result.failures.length ? ' · '+result.failures.map(f=>f.error).join(' · ') : ''}`);
  } catch(e){toast(e.message);}
  finally { developView.host.setBusy(false); }
};
function readEditorRow(row) {
  const input=k=>row.querySelector(`[data-editor-field="${k}"]`), previous=settingsDraft.editors.find(e=>e.id===row.dataset.editorId);
  return {...previous,name:input('name').value,path:input('path').value.trim(),needsPath:input('path').value.trim()===previous.path?previous.needsPath:!input('path').value.trim(),args:JSON.parse(input('args').value),detect:input('detect').value,multiple:input('multiple').checked,
    handoff:{format:input('format').value,bitDepth:Number(input('bitDepth').value),compression:input('compression').value,colorSpace:input('colorSpace').value,jpegQuality:Number(input('jpegQuality').value)}};
}
function collectEditors() {
  const rows=[...$('external-editors').children];
  settingsDraft.editors=rows.map(readEditorRow);
  settingsDraft.defaultEditor=rows.find(r=>r.querySelector('[data-editor-field="default"]').checked)?.dataset.editorId || settingsDraft.editors[0]?.id;
}
function readEditors(value) {
  collectEditors();value.editors=clone(settingsDraft.editors);value.defaultEditor=settingsDraft.defaultEditor;
  value.handoffFolder=$('handoff-folder').value.trim();value.handoffSubfolder=$('handoff-subfolder').value.trim();value.handoffAlways=$('handoff-always').checked;value.deleteHandoffsAfterExport=$('handoff-delete-export').checked;
}
function fillEditors(value) {
  $('handoff-folder').value=value.handoffFolder || '';$('handoff-subfolder').value=value.handoffSubfolder || '_develop';$('handoff-always').checked=!!value.handoffAlways;$('handoff-delete-export').checked=!!value.deleteHandoffsAfterExport;
  drawEditors();
}
function drawEditors() {
  const host=$('external-editors');host.replaceChildren();
  for(const editor of settingsDraft.editors){
    const row=document.createElement('fieldset');row.className='editor-settings';row.dataset.editorId=editor.id;
    const legend=document.createElement('legend');legend.textContent=editor.name+(editor.needsPath?' · needs path':'');row.append(legend);
    function field(key,label,value,choices){const l=document.createElement('label');l.textContent=label;const el=document.createElement(choices?'select':'input');el.dataset.editorField=key;el.setAttribute('aria-label',`${editor.name} ${label}`);if(choices)el.append(...Object.entries(choices).map(([v,n])=>option(v,n)));el.value=value;l.append(el);row.append(l);return el;}
    function toggle(key,label,checked){const l=document.createElement('label');l.className='toggle-row';const el=document.createElement('input');el.type='checkbox';el.dataset.editorField=key;el.checked=checked;l.append(el,document.createTextNode(label));row.append(l);return el;}
    const def=toggle('default','Default editor',editor.id===settingsDraft.defaultEditor);def.type='radio';def.name='default-editor';
    field('name','Name',editor.name);const executable=field('path','Application',editor.path);executable.placeholder='Browse…';
    field('args','Arguments (JSON array)',JSON.stringify(editor.args));
    field('format','Format',editor.handoff.format,{tiff:'TIFF',png:'PNG',jpeg:'JPEG'}).onchange=e=>{if(e.target.value==='jpeg')row.querySelector('[data-editor-field="bitDepth"]').value='8';syncFormat();};
    field('bitDepth','Bit depth',editor.handoff.bitDepth,{8:'8-bit',16:'16-bit'});
    field('compression','TIFF compression',editor.handoff.compression,{none:'Uncompressed',lzw:'LZW',deflate:'Deflate'});
    field('colorSpace','Color space',editor.handoff.colorSpace,PhotoCullExport.SPACES);
    const quality=field('jpegQuality','JPEG quality',editor.handoff.jpegQuality);quality.type='number';quality.min=1;quality.max=100;
    field('detect','Detect saved changes',editor.detect,{exit:'After application exits',watch:'Watch file writes (keep editor open)'});
    toggle('multiple','Open all selected files in one invocation ({files})',editor.multiple);
    const syncFormat=()=>{const format=row.querySelector('[data-editor-field="format"]').value;row.querySelector('[data-editor-field="compression"]').disabled=format!=='tiff';quality.disabled=format!=='jpeg';row.querySelector('[data-editor-field="bitDepth"] option[value="16"]').disabled=format==='jpeg';};syncFormat();
    const actions=document.createElement('div');actions.className='develop-actions';
    function action(label,fn){const b=document.createElement('button');b.type='button';b.className='button quiet';b.textContent=label;b.onclick=()=>Promise.resolve().then(fn).catch(e=>$('settings-status').textContent=e.message);actions.append(b);}
    action('Browse…',async()=>{const file=await api.pickEditor();if(file)executable.value=file;});
    action('Test',async()=>{const result=await api.editorTest(readEditorRow(row));$('settings-status').textContent=result.message;});
    action('Duplicate',()=>{collectEditors();const copy=clone(settingsDraft.editors.find(e=>e.id===editor.id));copy.id=crypto.randomUUID();copy.name+=' copy';settingsDraft.editors.push(copy);drawEditors();});
    // Reset and remove preserve all edits in the other rows.
    action(editor.id==='dehancer'?'Reset preset':'Remove',async()=>{try{collectEditors();if(editor.id==='dehancer'){const preset=await api.editorPreset();settingsDraft.editors=settingsDraft.editors.map(e=>e.id==='dehancer'?preset:e);}else{settingsDraft.editors=settingsDraft.editors.filter(e=>e.id!==editor.id);if(settingsDraft.defaultEditor===editor.id)settingsDraft.defaultEditor='dehancer';}drawEditors();}catch(e){$('settings-status').textContent=e.message;}});
    row.append(actions);host.append(row);
  }
}
$('editor-add').onclick=async()=>{try{collectEditors();const editor=await api.editorPreset();editor.id=crypto.randomUUID();editor.name='New editor';editor.path='';settingsDraft.editors.push(editor);drawEditors();}catch(e){$('settings-status').textContent=e.message;}};

// Shared command, settings-sync, welcome and card-backup surfaces.
const workspaceNode = (tag, text, attrs={}) => { const el=document.createElement(tag);if(text)el.textContent=text;for(const [key,value] of Object.entries(attrs))el.setAttribute(key,value);return el; };
const workspaceButton = (text,run,id) => {const el=workspaceNode('button',text,{type:'button',class:'button quiet',...(id?{id}:{})});el.onclick=()=>Promise.resolve().then(run).catch(error=>toast(error.message));return el;};
function shortcutLabel(command,custom=state.settings.shortcuts||{}) {return PhotoCullCommands.shortcuts(command,custom).map(k=>k.replaceAll('Mod',api.platform==='darwin'?'⌘':'Ctrl').replaceAll('Meta','⌘').replaceAll('Space','Space')).join(' / ')||'Unassigned';}
function openHelp() {
  const host=$('help-dialog').querySelector('.shortcut-list');host.replaceChildren();
  for(const command of commands.commands){host.append(workspaceNode('span',command.title),workspaceNode('kbd',shortcutLabel(command)));}
  if(!$('help-dialog').open)$('help-dialog').showModal();
}
const helpActions=workspaceNode('div',null,{class:'copy-actions'});
for(const [text,id] of [['About PhotoCull','about'],['Command palette','palette'],['Welcome','welcome'],['Copy diagnostics','diagnostics'],['Open log folder','logs']])helpActions.append(workspaceButton(text,()=>{$('help-dialog').close();commands.execute(id);}));
$('help-dialog').prepend(helpActions);$('help-dialog').querySelector('h2').textContent='Help & shortcuts';
const palette=workspaceNode('dialog',null,{id:'command-palette','aria-label':'Command palette'});
palette.innerHTML='<label for="command-query">Command palette · type > to find a photo</label><input id="command-query" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="command-results" autocomplete="off" placeholder="Search commands or > photo name"><div id="command-results" role="listbox" aria-label="Commands"></div><p id="command-count" class="subtle small" role="status"></p>';
document.body.append(palette);
let paletteRows=[],paletteIndex=0,paletteFocus;
function openPalette(query='') {if(document.querySelector('dialog[open]'))return;paletteFocus=document.activeElement;palette.showModal();$('command-query').value=query;paletteIndex=0;drawPalette();$('command-query').focus();}
function drawPalette() {
  const query=$('command-query').value,findPhoto=query.startsWith('>');
  paletteRows=findPhoto?(state.session?.items||[]).filter(item=>!item.trashed&&PhotoCullCommands.fuzzy(query.slice(1),item.name)).slice(0,60).map(item=>({id:'photo-'+item.id,title:item.name,category:'Photo',run:()=>{state.filter='all';state.query='';state.colorFilter='';$('search').value='';$('color-filter').value='';state.selected=item.id;resetSelection();render(true);}})):
    commands.search(query,recentCommands).slice(0,60).map(command=>({...command,disabled:!command.context.includes(state.mode)||!command.enabled(),run:()=>commands.execute(command.id)}));
  paletteIndex=Math.min(paletteIndex,Math.max(0,paletteRows.length-1));
  $('command-results').replaceChildren(...paletteRows.map((row,index)=>{
    const el=workspaceNode('div',null,{id:'command-option-'+index,role:'option','aria-selected':String(index===paletteIndex),'aria-disabled':String(!!row.disabled),class:'command-option'});
    el.append(workspaceNode('span',`${row.title} · ${row.category}${!query&&recentCommands.includes(row.id)?' · recent':''}`),workspaceNode('kbd',row.shortcuts?shortcutLabel(row):''));
    el.onmousedown=e=>e.preventDefault();el.onclick=()=>runPalette(index);return el;
  }));
  if(paletteRows.length)$('command-query').setAttribute('aria-activedescendant','command-option-'+paletteIndex);else $('command-query').removeAttribute('aria-activedescendant');
  $('command-count').textContent=`${paletteRows.length} result(s) · ↑ ↓ select · Enter run · Esc close`;
  $('command-option-'+paletteIndex)?.scrollIntoView({block:'nearest'});
}
function runPalette(index) {const row=paletteRows[index];if(!row||row.disabled)return;palette.close();Promise.resolve().then(row.run).catch(e=>toast(e.message));}
$('command-query').oninput=()=>{paletteIndex=0;drawPalette();};
$('command-query').onkeydown=event=>{if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();paletteIndex=(paletteIndex+(event.key==='ArrowDown'?1:-1)+paletteRows.length)%Math.max(1,paletteRows.length);drawPalette();}else if(event.key==='Enter'){event.preventDefault();runPalette(paletteIndex);}else if(event.key==='Escape'){event.preventDefault();palette.close();}};
palette.addEventListener('close',()=>{if(paletteFocus?.isConnected)paletteFocus.focus();});
// Keyboard edits stay in the settings draft until Save, just like other preferences.
const keyboardTab=workspaceButton('Keyboard',()=>setSettingsTab('keyboard'));keyboardTab.dataset.settingsTab='keyboard';$('settings-dialog').querySelector('nav').append(keyboardTab);
const keyboardPage=workspaceNode('section',null,{'data-settings-page':'keyboard',hidden:''});
keyboardPage.innerHTML='<p class="subtle small">Select Record, then press a key combination. Escape cancels recording. Clear removes a binding. Save applies changes.</p><p id="keyboard-status" role="status" aria-live="polite"></p><div id="keyboard-commands"></div>';
keyboardPage.append(workspaceButton('Reset all shortcuts',()=>{settingsDraft.shortcuts={};drawKeyboard();},'keyboard-reset-all'));
$('settings-status').before(keyboardPage);
let recording=null;
function drawKeyboard() {
  recording=null;const host=$('keyboard-commands');host.replaceChildren();let category='';
  for(const command of [...commands.commands].sort((a,b)=>a.category.localeCompare(b.category)||a.title.localeCompare(b.title))){
    if(command.category!==category){category=command.category;host.append(workspaceNode('h3',category));}
    const row=workspaceNode('div',null,{class:'keyboard-row','data-command':command.id});
    row.append(workspaceNode('span',command.title+' ('+command.context.join(', ')+')'),workspaceNode('kbd',shortcutLabel(command,settingsDraft.shortcuts||{})),
      workspaceButton('Record',()=>{recording=command.id;$('keyboard-status').textContent=`Press a shortcut for ${command.title}…`;},'record-'+command.id),
      workspaceButton('Clear',()=>{settingsDraft.shortcuts||={};settingsDraft.shortcuts[command.id]=[];drawKeyboard();}),
      workspaceButton('Reset',()=>{const conflicts=PhotoCullCommands.conflicts(commands.commands,settingsDraft.shortcuts||{},command.id,command.shortcuts.default,{defaults:true});if(conflicts.length){$('keyboard-status').textContent='Conflicts with '+conflicts.map(c=>c.title).join(', ');return;}delete settingsDraft.shortcuts[command.id];drawKeyboard();}));host.append(row);
  }
}
document.addEventListener('keydown',event=>{
  if(!recording||!$('settings-dialog').open)return;
  event.preventDefault();event.stopImmediatePropagation();if(event.key==='Escape'){recording=null;$('keyboard-status').textContent='Recording canceled.';return;}
  const key=PhotoCullCommands.eventKey(event);if(!key)return;
  const conflicts=PhotoCullCommands.conflicts(commands.commands,settingsDraft.shortcuts||{},recording,[key]);
  if(conflicts.length){$('keyboard-status').textContent='Conflicts with '+conflicts.map(c=>c.title).join(', ')+'. Choose another shortcut.';return;}
  settingsDraft.shortcuts||={};settingsDraft.shortcuts[recording]=[key];drawKeyboard();$('keyboard-status').textContent='Shortcut recorded. Save to apply.';
},true);
$('settings-dialog').addEventListener('close',()=>{recording=null;});
// The existing naming page covers copy names/folder layouts. Export presets own export naming.
const cardSettings=workspaceNode('section');cardSettings.innerHTML='<h3>Camera cards & backup</h3><label>Camera folder layouts (one relative path per line)<textarea id="card-folders" rows="3" placeholder="DCIM&#10;PRIVATE/M4ROOT"></textarea></label><label>Folders treated as cards (one absolute path per line)<textarea id="manual-cards" rows="3"></textarea></label><label>Default backup folder template<input id="backup-template" placeholder="{date}-{card}"></label><p class="subtle small">Backup tokens: {date}, {card}, {year}, {month}, {day}. Copy naming is in File naming; finished-image naming is saved in export presets.</p>';
$('settings-dialog').querySelector('[data-settings-page="general"]').append(cardSettings);
const syncTab=workspaceButton('Import / export',()=>setSettingsTab('sync'));syncTab.dataset.settingsTab='sync';$('settings-dialog').querySelector('nav').append(syncTab);
const syncPage=workspaceNode('section',null,{'data-settings-page':'sync',hidden:''});syncPage.innerHTML='<h3>Move settings between computers</h3><p>Bundles include preferences, user recipes, metadata and export presets, external editors and shortcuts. Import replaces these settings after saving a full backup.</p><label class="toggle-row"><input id="bundle-exclude-paths" type="checkbox" checked> Exclude machine-specific paths on export</label><div class="copy-actions"><button id="bundle-export" class="button quiet">Export settings…</button><label class="button quiet">Choose settings JSON<input id="bundle-file" type="file" accept=".json,application/json"></label></div><label>Path mappings (JSON object, old prefix → new prefix)<textarea id="bundle-path-map" rows="3">{}</textarea></label><button id="bundle-preview" class="button quiet">Preview import</button><pre id="bundle-changes" role="status"></pre><button id="bundle-apply" class="button primary" disabled>Back up current settings & import</button>';
$('settings-status').before(syncPage);
let bundleInput=null,bundleToken=null;
const clearBundlePreview=()=>{bundleToken=null;$('bundle-apply').disabled=true;};
$('bundle-file').onchange=async()=>{clearBundlePreview();try{const file=$('bundle-file').files[0];if(!file||file.size>4*1024*1024)throw new Error('Choose a settings JSON smaller than 4 MB.');bundleInput=JSON.parse(await file.text());$('bundle-changes').textContent='File loaded. Preview to validate.';}catch(e){bundleInput=null;$('bundle-changes').textContent=e.message;}};
$('bundle-path-map').oninput=clearBundlePreview;
$('bundle-export').onclick=async()=>{try{const file=await api.bundleExport({excludePaths:$('bundle-exclude-paths').checked});$('bundle-changes').textContent=file?`Saved ${file}`:'Export canceled.';}catch(e){$('bundle-changes').textContent=e.message;}};
$('bundle-preview').onclick=async()=>{clearBundlePreview();try{const result=await api.bundlePreview(bundleInput,{pathMap:JSON.parse($('bundle-path-map').value)});bundleToken=result.token;$('bundle-changes').textContent=`Preferences changed: ${result.changes.join(', ')||'none'}\nUser recipes: ${result.recipes.before} → ${result.recipes.after}\nMetadata presets: ${result.presets.before} → ${result.presets.after}\n${result.warnings.join('\n')}\n\nPreference values (before / after):\n${JSON.stringify(result.details,null,2)}\nRecipe changes: ${JSON.stringify(result.recipeChanges)}\nPreset changes: ${JSON.stringify(result.presetChanges)}`;$('bundle-apply').disabled=false;}catch(e){$('bundle-changes').textContent=e.message;}};
$('bundle-apply').onclick=async()=>{if(!bundleToken)return;$('bundle-apply').disabled=true;try{const result=await api.bundleApply(bundleToken);syncSettings(result.settings);settingsDraft=clone(result.settings);const recipes=await api.recipes();$('default-recipe').replaceChildren(...recipes.recipes.map(r=>option(r.id,r.name)));fillSettings(settingsDraft);$('bundle-changes').textContent=`Imported. Previous settings backed up to ${result.backup}`;clearBundlePreview();}catch(e){$('bundle-changes').textContent=e.message;}};
function fillWorkspaceSettings(value) {drawKeyboard();$('card-folders').value=(value.cardFolders||['DCIM']).join('\n');$('manual-cards').value=(value.manualCards||[]).join('\n');$('backup-template').value=value.backupTemplate||'{date}-{card}';}
function readWorkspaceSettings(value) {value.cardFolders=$('card-folders').value.split('\n').map(s=>s.trim()).filter(Boolean);value.manualCards=$('manual-cards').value.split('\n').map(s=>s.trim()).filter(Boolean);value.backupTemplate=$('backup-template').value.trim();}
const welcome=workspaceNode('aside',null,{id:'welcome-panel','aria-label':'Welcome to PhotoCull',hidden:''});
welcome.innerHTML='<h2>Welcome to PhotoCull</h2><p>Open a photo folder or choose a connected camera card in the sidebar.</p><div id="welcome-keys" class="shortcut-list"></div><div id="welcome-actions" class="copy-actions"></div>';
document.body.append(welcome);
function showWelcome() {if($('help-dialog').open)$('help-dialog').close();welcome.hidden=false;$('welcome-keys').replaceChildren();for(const id of ['open','navigate-right','flag-pick','flag-reject','rating-5','zoom-toggle','view-grid','palette']){const c=commands.commands.find(c=>c.id===id);$('welcome-keys').append(workspaceNode('span',c.title),workspaceNode('kbd',shortcutLabel(c)));}}
async function dismissWelcome(){welcome.hidden=true;state.settings=await api.settings({welcomeDismissed:true});}
$('welcome-actions').append(workspaceButton('Open folder…',async()=>{await dismissWelcome();await openFolder();},'welcome-open'),workspaceButton('Choose camera card',async()=>{await dismissWelcome();$('devices-panel').scrollIntoView();$('device-list button')?.focus();},'welcome-card'),workspaceButton('Set up an external editor',async()=>{await dismissWelcome();await openSettings('editors');}),workspaceButton('Skip',dismissWelcome,'welcome-skip'));
void Promise.all([api.workspaceInfo(),api.settings()]).then(([info,settings])=>{if(info.welcome&&!settings.welcomeDismissed)showWelcome();}).catch(error=>toast(error.message));
async function copyDiagnostics() {
  const color=await api.displayColor().catch(()=>({mode:'unavailable'}));let gpu='unavailable';
  try{const gl=document.createElement('canvas').getContext('webgl'),ext=gl?.getExtension('WEBGL_debug_renderer_info');if(ext)gpu=gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);}catch{}
  const text=await api.diagnostics({webview:navigator.userAgent,display:{width:screen.width,height:screen.height,pixelRatio:devicePixelRatio,colorDepth:screen.colorDepth,p3:matchMedia('(color-gamut: p3)').matches,color},gpu});
  try{await navigator.clipboard.writeText(text);toast('Diagnostics copied.');}catch{const dialog=workspaceNode('dialog',null,{'aria-label':'Copy diagnostics'}),area=workspaceNode('textarea',text,{rows:'18',cols:'70','aria-label':'Diagnostics'});dialog.append(area,workspaceButton('Close',()=>{dialog.close();dialog.remove();}));document.body.append(dialog);dialog.showModal();area.focus();area.select();}
}
const backupDialog=workspaceNode('dialog',null,{id:'backup-dialog','aria-labelledby':'backup-title'});
backupDialog.innerHTML='<h2 id="backup-title">Back up card or folder</h2><p>Copies every regular file, including videos and sidecars. Each file is verified with SHA-256. Existing identical copies are verified and skipped. Source files are never formatted or deleted.</p><label>Source folder<input id="backup-source" readonly></label><button id="backup-source-choose" class="button quiet">Choose card / folder…</button><label>Destination<input id="backup-destination" readonly></label><button id="backup-destination-choose" class="button quiet">Choose destination…</button><label>Folder template<input id="backup-folder-template"></label><div class="copy-actions"><button id="backup-start" class="button primary">Back up & verify</button><button id="backup-check" class="button quiet">Check verified backup</button><button id="backup-cancel" class="button quiet" hidden>Cancel backup</button><button id="backup-close" class="button quiet">Close</button></div><progress id="backup-progress" max="1" value="0" hidden></progress><p id="backup-status" role="status" aria-live="polite"></p><pre id="backup-failures"></pre>';
document.body.append(backupDialog);let backupRunning=false;const cardStatuses=new Map();
function openBackup(source=state.session?.deviceRoot||state.session?.folder||'') {if(document.querySelector('dialog[open]'))return;$('backup-source').value=source;$('backup-folder-template').value=state.settings.backupTemplate||'{date}-{card}';$('backup-status').textContent='';$('backup-failures').textContent='';backupDialog.showModal();}
$('backup-source-choose').onclick=async()=>{const folder=await api.pickFolder('Choose a card or folder to back up');if(folder)$('backup-source').value=folder;};
$('backup-destination-choose').onclick=async()=>{const folder=await api.chooseCopyDestination();if(folder)$('backup-destination').value=folder;};
function backupStatusText(status) {return status.safe?`All ${status.total} files backed up and verified — safe to format`:`${status.verified||0} of ${status.total} files verified · ${status.missing.length} file(s) need backup or verification`;}
function showBackupProgress(progress) {$('backup-progress').hidden=false;$('backup-progress').max=progress.total||1;$('backup-progress').value=progress.completed;$('backup-status').textContent=progress.status?backupStatusText(progress.status):`${progress.state} · ${progress.completed}/${progress.total} · ${progress.verified} verified · ${progress.skipped} identical · ${progress.file}`;$('backup-failures').textContent=[...(progress.failures||[]),...(progress.status?.missing||[])].map(f=>`${f.name}: ${f.reason}`).join('\n');}
function setBackupBusy(value){backupRunning=value;state.busy=value;for(const id of ['backup-start','backup-check','backup-source-choose','backup-destination-choose','backup-folder-template','backup-close'])$(id).disabled=value;$('backup-cancel').hidden=!value;renderDevices();}
api.onBackupProgress(progress=>{if(backupRunning)showBackupProgress(progress);});
$('backup-start').onclick=async()=>{setBackupBusy(true);try{const source=$('backup-source').value,result=await api.backupStart(source,$('backup-destination').value,{template:$('backup-folder-template').value});showBackupProgress(result);if(result.status)cardStatuses.set(source,result.status);else cardStatuses.delete(source);}catch(e){$('backup-status').textContent=e.message;}finally{setBackupBusy(false);}};
$('backup-check').onclick=async()=>{setBackupBusy(true);$('backup-status').textContent='Checking every source and destination hash…';try{const source=$('backup-source').value,status=await api.backupStatus(source);cardStatuses.set(source,status);$('backup-status').textContent=backupStatusText(status);$('backup-failures').textContent=status.missing.map(f=>`${f.name}: ${f.reason}`).join('\n');}catch(e){$('backup-status').textContent=e.message;cardStatuses.set($('backup-source').value,{safe:false,total:0,verified:0,missing:[{name:'Card',reason:e.message}]});}finally{setBackupBusy(false);}};
$('backup-cancel').onclick=()=>api.backupCancel();$('backup-close').onclick=()=>backupDialog.close();backupDialog.addEventListener('cancel',e=>{if(backupRunning)e.preventDefault();});
async function treatCard(){if(!state.session)return toast('Open a folder first.');receiveDevices(await api.manualCard(state.session.folder));state.session.removable=true;toast('Folder is now treated as a camera card.');}
function deviceBackupRow(device){const row=workspaceNode('div',null,{class:'device-backup'}),status=cardStatuses.get(device.root) || device.backup;row.append(workspaceButton('Back up card…',()=>openBackup(device.root)));if(status){row.append(workspaceNode('p',backupStatusText(status),{class:status.safe?'backup-safe':'subtle small'}));if(status.missing.length){const detail=workspaceNode('details');detail.append(workspaceNode('summary','Files needing backup'),workspaceNode('pre',status.missing.map(f=>`${f.name}: ${f.reason}`).join('\n')));row.append(detail);}}return row;}
// Add discoverable entry points alongside the existing folder controls.
$('open-folder').after(workspaceButton('Back up…',()=>openBackup(),'backup-open'),workspaceButton('Treat folder as card',treatCard,'treat-card'));
const verifyLabel=workspaceNode('label',null,{class:'toggle-row'});verifyLabel.innerHTML='<input id="copy-verify" type="checkbox"> Verify copied files (SHA-256)';$('copy-naming').before(verifyLabel);

$('copy-verify').onchange=()=>saveCopyDefaults();

// Culling shortcut bindings: keep together for the shared shortcut registry.
const CULLING_SHORTCUTS = Object.freeze({ overlay:'a', zoomFocus:'shift+a', stacks:'s', compare:'c', wipe:'shift+\\' });
function handleCullingKey(event) {
  if(event.ctrlKey || event.metaKey || event.altKey)return state.mode==='compare' && survey.key(event);
  const key=event.key.toLowerCase();
  if(event.shiftKey && (event.code==='Backslash' || key==='\\' || key==='|') && state.mode==='develop'){event.preventDefault();if(!event.repeat)developView.toggleSplit();return true;}
  if(key===CULLING_SHORTCUTS.overlay) {event.preventDefault();if(!event.repeat){if(event.shiftKey)void zoomFocus();else void toggleFocus();}return true;}
  if(key===CULLING_SHORTCUTS.stacks) {event.preventDefault();if(!event.repeat)toggleBurst();return true;}
  if(key===CULLING_SHORTCUTS.compare) {event.preventDefault();if(!event.repeat)setMode(state.mode==='compare'?'review':'compare');return true;}
  if(state.mode==='compare' && event.key==='Escape'){event.preventDefault();setMode('review');return true;}
  return state.mode==='compare' && survey.key(event);
}
async function cullingMetadata(id,session=state.session?.id) {
  if(!session)return null;
  if(culling.metadata.has(id))return culling.metadata.get(id);
  if(culling.jobs.has(id))return culling.jobs.get(id);
  const job=api.metadata(session,id,'preview').then(metadata=>{if(state.session?.id===session){culling.metadata.set(id,metadata);if(state.selected===id)applyFocus();}return metadata;}).finally(()=>{if(culling.jobs.get(id)===job)culling.jobs.delete(id);});
  culling.jobs.set(id,job);return job;
}
function focusOf(id) {return culling.metadata.get(id)?.focus || null;}
function applyFocus() {
  const enabled=!!state.settings.focusOverlay;
  $('focus-toggle').setAttribute('aria-pressed',String(enabled));
  loupe.view.setFocus(focusOf(state.selected),enabled);
  developView.setFocus(focusOf(state.selected),enabled);survey?.refresh();
}
async function toggleFocus() {
  const previous=!!state.settings.focusOverlay;state.settings.focusOverlay=!previous;applyFocus();
  try{state.settings=await api.settings({focusOverlay:!previous});$('focus-preference').checked=!!state.settings.focusOverlay;applyFocus();if(state.selected && !focusOf(state.selected)){await cullingMetadata(state.selected);if(!focusOf(state.selected))toast('This photo has no recorded AF coordinates.');}}
  catch(error){state.settings.focusOverlay=previous;applyFocus();toast(error.message);}
}
async function zoomFocus() {
  if(!photo())return;
  const id=state.selected;await cullingMetadata(id);if(id!==state.selected)return;
  const focus=focusOf(id);if(!focus)return toast('This photo has no recorded AF coordinates.');
  if(state.mode==='compare')survey.zoomFocus(focus);
  else {if(state.mode!=='review')setMode('review');loupe.view.set({mode:'ratio',percent:100},{centerOn:focus,animate:true});}
}
function regroupBursts() {
  culling.bursts=PhotoCullCulling.groupBursts((state.session?.items || []).filter(item=>!item.trashed).map(item=>({id:item.id,...culling.metadata.get(item.id)})),state.settings.burstGap || 1);
  culling.byId.clear();for(const burst of culling.bursts)for(const id of burst.ids)culling.byId.set(id,burst);
}
function stackItems(items) {
  const allowed=new Set(items.map(i=>i.id)),seen=new Set();
  return items.filter(item=>{const b=culling.byId.get(item.id);if(!b || culling.expanded.has(b.id))return true;if(seen.has(b.id))return false;
    const representative=b.ids.includes(state.selected) && allowed.has(state.selected) ? state.selected : b.ids.find(id=>allowed.has(id));
    if(item.id!==representative)return false;seen.add(b.id);return true;});
}
function bestIn(burst) {return burst && PhotoCullCulling.sharpest(burst.ids,culling.scores);}
function burstSignature(item) {const b=culling.byId.get(item.id);return b ? `${b.id}:${b.ids.length}:${culling.expanded.has(b.id)}:${bestIn(b)}` : '';}
function addBurstBadges(node,item) {
  const b=culling.byId.get(item.id);if(!b)return;
  const badge=document.createElement('span');badge.className='burst-badge';badge.textContent=`${culling.expanded.has(b.id)?'▾':'▸'} ${b.ids.length}`;badge.title='Burst · S to expand or collapse';node.append(badge);
  if(bestIn(b)===item.id){const star=document.createElement('span');star.className='sharpest-badge';star.textContent='◆ Sharpest';star.title='Highest preview sharpness in this burst';node.append(star);}
}
function renderCulling() {
  const burst=culling.byId.get(state.selected),available=!!burst;
  $('burst-context').hidden=!available;$('burst-context').textContent=available?`${burst.ids.indexOf(state.selected)+1}/${burst.ids.length} in burst${bestIn(burst)===state.selected?' · sharpest':''}`:'';
  $('burst-stack').hidden=$('burst-keep').hidden=!available;
  $('burst-stack').textContent=available && culling.expanded.has(burst.id)?'Collapse burst':'Expand burst';
  $('burst-keep').disabled=!bestIn(burst) || state.busy || state.deleting || !!state.pendingSaves;
  applyFocus();
}
function toggleBurst() {
  const burst=culling.byId.get(state.selected);if(!burst)return toast('This photo is not part of a detected burst.');
  if(culling.expanded.has(burst.id))culling.expanded.delete(burst.id);else culling.expanded.add(burst.id);
  filmSignature='';render();
}
function cancelCulling() {culling.epoch++;culling.running=false;void api.cancelSharpness().catch(()=>{});}
async function analyzeCulling() {
  cancelCulling();culling.paused=false;culling.running=true;const epoch=culling.epoch,session=state.session?.id,items=[...(state.session?.items || [])];
  $('analysis-pause').hidden=!items.length;$('analysis-pause').textContent='Pause analysis';
  const current=()=>epoch===culling.epoch && session===state.session?.id && !culling.paused;
  const yieldUI=()=>new Promise(resolve=>setTimeout(resolve,35));let failures=0;
  try {
    for(const [index,item] of items.entries()) {
      if(!current())return;try{await cullingMetadata(item.id,session);}catch{failures++;}
      if(!current())return;
      if(index%8===0 || index===items.length-1){regroupBursts();filmSignature='';render();$('analysis-status').textContent=`Metadata ${index+1}/${items.length}`;}
      await yieldUI();
    }
    if(api.canAnalyze) {
      const burstIds=new Set(culling.byId.keys()),order=[...items.filter(i=>burstIds.has(i.id)),...items.filter(i=>!burstIds.has(i.id))];
      for(const item of order) {
        if(!current())return;if(culling.scores.has(item.id))continue;
        try{const score=await api.sharpness(session,item.id);if(!current())return;if(Number.isFinite(score))culling.scores.set(item.id,score);}catch{if(current())failures++;}
        if(!current())return;
        $('analysis-status').textContent=`Focus ${culling.scores.size}/${items.length}`;filmSignature='';render();await yieldUI();
      }
    }
    if(current()){$('analysis-status').textContent=failures?`${failures} unavailable`:api.canAnalyze?'Focus ready':'Desktop scores';$('analysis-pause').hidden=!failures;$('analysis-pause').textContent='Retry analysis';}
  }finally{if(epoch===culling.epoch)culling.running=false;}
}
function promptKeepSharpest() {
  const burst=culling.byId.get(state.selected),best=bestIn(burst);if(!best || state.busy || state.deleting || state.pendingSaves)return;
  burstPrompt={session:state.session.id,ids:[...burst.ids],best};
  const items=burst.ids.map(id=>state.session.items.find(i=>i.id===id)),changes=items.filter(i=>i.flag!==(i.id===best?'pick':'reject'));
  $('burst-summary').textContent=`Pick ${items.find(i=>i.id===best).name} and reject the other ${items.length-1} frame${items.length===2?'':'s'}. ${changes.length} flag${changes.length===1?'':'s'} will change.`;
  $('burst-changes').textContent=items.map(i=>`${i.name}: ${i.flag} → ${i.id===best?'pick':'reject'}`).join('\n');$('burst-dialog').showModal();
}
$('focus-toggle').onclick=()=>void toggleFocus();$('compare-mode').onclick=()=>setMode(state.mode==='compare'?'review':'compare');
$('burst-stack').onclick=toggleBurst;$('burst-keep').onclick=promptKeepSharpest;
$('analysis-pause').onclick=()=>{if(culling.running){cancelCulling();culling.paused=true;$('analysis-status').textContent='Analysis paused';$('analysis-pause').textContent='Resume analysis';}else void analyzeCulling();};
$('burst-cancel').onclick=()=>{$('burst-dialog').close();burstPrompt=null;};
$('burst-dialog').addEventListener('cancel',()=>{burstPrompt=null;});
$('burst-confirm').onclick=async()=>{
  const prompt=burstPrompt;if(!prompt || prompt.session!==state.session?.id)return;$('burst-confirm').disabled=true;
  try {const result=await api.keepSharpest(prompt.session,prompt.ids);if(state.session?.id===prompt.session){for(const patch of result.items)Object.assign(state.session.items.find(i=>i.id===patch.id),patch);state.selected=result.best;resetSelection();render();toast('Kept the sharpest frame · Undo restores the whole burst');}$('burst-dialog').close();burstPrompt=null;}
  catch(error){toast(error.message);}finally{$('burst-confirm').disabled=false;}
};
survey=PhotoCullSurvey.create({api,session:()=>state.session?.id,revision:()=>`${state.previewRevision}:${state.showOriginal}`,items:filtered,item:id=>state.session?.items.find(i=>i.id===id),url:imageUrl,metadata:cullingMetadata,focus:focusOf,overlay:()=>!!state.settings.focusOverlay,
  activate:id=>{if(state.selected!==id){state.selected=id;renderSelection();}},
  decide:async(id,patch)=>{if(state.busy || state.deleting)return;const session=state.session.id;try{const result=await api.decide(session,id,patch);if(state.session?.id===session){Object.assign(state.session.items.find(i=>i.id===id),result);render();}}catch(error){toast(error.message);}}
});
window.addEventListener('pagehide',cancelCulling);
