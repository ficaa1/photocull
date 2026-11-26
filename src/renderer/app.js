const api = window.photocull;
const $ = id => document.getElementById(id);
const state = { deleting: false, session: null, selected: null, marked: new Set(), anchor: null, filter: 'all', query: '', metadataFilters: {}, mode: 'review', studio: false, fullscreen: false,
  generation: 0, previewRevision: 0, showOriginal: false, proposals: [], proposalsLoading: false, proposalsBusy: false, proposalWarning: '', pendingSaves: 0, saveError: false, busy: false, settings: { autoAdvance: true, recursive: false, autoOpenCards: true, colors: [], naming: { template: '{filename}', text: '', start: 1 } }, settingsReady: false, colorFilter: '', devices: [], deviceError: '', autoOpened: new Set(), copy: { running: false, destination: null, copiedTo: null } };
let toastTimer, metadataTimer, framePending = false, handoffUsageKey = '', handoffUsageGeneration = 0;
const gridNodes = new Map(), filmNodes = new Map();
const culling = { metadata:new Map(), jobs:new Map(), scores:new Map(), bursts:[], byId:new Map(), expanded:new Set(), epoch:0, paused:false, running:false };
let metadataIndex;
let survey, burstPrompt=null, tether=null;
const menus = [];
// Automatic card opening waits until first-run Welcome has been shown and answered.
let welcomeSettled = false, autoOpenSuppressed = false;
// The left pane is Sources, or the tether dock in the Tether workspace; each keeps its own shown state.
let layoutPrefs = { sources: true, dock: true, details: true, gridSize: 205 };
try { const saved = JSON.parse(localStorage.getItem('photocull-layout') || '{}'); layoutPrefs = { sources: saved.sources !== false, dock: saved.dock !== false, details: saved.details !== false, gridSize: Math.min(320, Math.max(160, Number(saved.gridSize) || 205)) }; } catch {}
const leftPane = () => state.studio ? 'dock' : 'sources';
// Tether is Review's photo stage inside the studio workspace.
const photoStage = () => state.mode === 'review' || state.mode === 'tether';
const stageMode = () => state.studio ? 'tether' : 'review';
const glyph = paths => `<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const fullscreenIcons = { enter: glyph('<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>'), exit: glyph('<path d="M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5"/>') };
function storeLayout() { try { localStorage.setItem('photocull-layout', JSON.stringify(layoutPrefs)); } catch {} }
function applyPaneLayout() {
  const narrow = matchMedia('(max-width: 900px)').matches;
  const sources = narrow ? document.body.classList.contains('mobile-sources') : layoutPrefs[leftPane()];
  const details = narrow ? document.body.classList.contains('mobile-details') : layoutPrefs.details;
  document.body.classList.toggle('sources-hidden', !narrow && !sources); document.body.classList.toggle('details-hidden', !narrow && !details);
  const left = state.studio ? 'tether tools' : 'sources';
  $('toggle-sidebar').setAttribute('aria-controls', state.studio ? 'tether-dock' : 'sources'); $('toggle-sidebar').title = state.studio ? 'Tether tools (B)' : 'Sources (B)';
  $('toggle-sidebar').setAttribute('aria-expanded', String(sources)); $('toggle-sidebar').setAttribute('aria-label', `${sources ? 'Hide' : 'Show'} ${left}`);
  $('toggle-inspector').setAttribute('aria-expanded', String(details)); $('toggle-inspector').setAttribute('aria-label', details ? 'Hide details' : 'Show details');
  requestGrid(); loupe.layout();
}
function togglePane(pane) {
  if (matchMedia('(max-width: 900px)').matches) document.body.classList.toggle(pane === 'sources' ? 'mobile-sources' : 'mobile-details');
  else { const key = pane === 'sources' ? leftPane() : pane; layoutPrefs[key] = !layoutPrefs[key]; storeLayout(); }
  applyPaneLayout();
}
$('toggle-sidebar').onclick = () => togglePane('sources'); $('toggle-inspector').onclick = () => togglePane('details');
$('grid-size').value = layoutPrefs.gridSize; $('grid-size').oninput = () => { layoutPrefs.gridSize = Number($('grid-size').value); storeLayout(); requestGrid(); };
// A Tether test shot is an unsaved frame that the loupe shows like a photo; the backend knows nothing about it.
const testShot = () => state.mode === 'tether' ? state.testShot : null;
const testCullMessage = 'Exit or keep Test Shot before culling session photos.';
function testBlocksCulling() { return state.mode === 'tether' && tether?.test.active && tether.test.hasShot; }
function guardStageCull() {
  if (!testBlocksCulling()) return false;
  toast(testCullMessage); return true;
}
// The single-photo view: zoom, pan, navigator and which preview size to load (loupe.js).
const loupe = PhotoCullLoupe.create({ api: Object.create(api, { previewStatus: { value: (session, id, ...rest) => state.testShot?.item.id === id ? Promise.resolve({}) : api.previewStatus(session, id, ...rest) } }),
  elements: { viewport: $('image-viewport'), image: $('review-image'), loading: $('image-loading'), error: $('image-error'), retry: $('retry-preview'),
    previewSource: $('preview-source'), previewStatus: $('preview-status'), cameraBadge: $('camera-preview'), zoomFit: $('zoom'), zoomFill: $('zoom-fill'),
    zoomPercent: $('zoom-percent'), zoomLevel: $('zoom-level'), navigator: $('navigator'), navigatorImage: $('navigator-image'), navigatorView: $('navigator-view'),
    navigatorPanel: $('navigator-panel'), navigatorDock: $('navigator-dock'), navigatorOverlay: $('navigator-overlay'), navigatorZoom: $('navigator-zoom'), inspector: $('inspector') },
  imageUrl: (item, kind, extra = '') => item.testShot ? item.url : api.imageUrl(state.session.id, item.id, kind, `&d=${item.developRevision || 0}&edit=${item.externalEdit ? 1 : 0}&v=${state.previewRevision}${state.showOriginal ? '&original=1' : ''}${item.contentRev ? `&cr=${item.contentRev}` : ''}${extra}`),
  context: () => ({ session: state.session, items: state.session ? filtered() : [], mode: photoStage() ? 'review' : state.mode, revision: state.previewRevision, original: state.showOriginal, fullscreen: state.fullscreen }),
  settings: () => state.settings,
  onLoaded: item => { if (!item.testShot) void loadMetadata(item); },
  onClickZoomChange: async percent => { try { state.settings = await api.settings({ zoomPercent: percent }); } catch (error) { toast(error.message); } },
  onSwipe: swipe => photoSwipe(swipe) });
// Touch swipes on a photo at Fit: left and right change photos, up picks, down rejects.
// Up and down show what releasing will do; sideways the photo itself moves.
const SWIPES = { left: () => navigate(1), right: () => navigate(-1), up: () => decide({ flag: 'pick' }), down: () => decide({ flag: 'reject' }) };
function photoSwipe({ direction, armed, done }) {
  const hint = $('swipe-hint'), vertical = direction === 'up' || direction === 'down';
  hint.hidden = done || !vertical;
  if (!hint.hidden) {
    hint.textContent = direction === 'up' ? '⚑ Pick' : '× Reject';
    hint.className = `swipe-hint ${direction === 'up' ? 'pick' : 'reject'}${armed ? ' armed' : ''}`;
  }
  if (done && armed && photoStage() && photo()) SWIPES[direction]?.();
}
matchMedia('(max-width: 900px)').addEventListener('change', applyPaneLayout);
applyPaneLayout();
function workspaceBusy() {
  return state.busy || state.copy.running || state.deleting || !!developView.batch || !!developView.editing;
}
function setBusy(value) { state.busy = value; render(); }

// Develop owns its controls and render queue; app hooks keep selection and badges shared.
const developView = PhotoCullDevelop.init({ api, selection, toast, status: setStatus, settings: () => state.settings, editorName, openEditors: () => openSettings('editors'), setBusy,
  updateItems(session, items) {
    if (state.session?.id !== session) return;
    let changed=false;
    for(const patch of items){const item=state.session.items.find(i=>i.id===patch.id);if(item){changed ||= 'externalEdit' in patch && (item.externalEdit!==patch.externalEdit || item.developRevision!==patch.developRevision);Object.assign(item,patch);}}
    if(changed)refreshPreviews();else render();
  },
  viewResult(session,id) { if(state.session?.id!==session)return; state.selected=id; resetSelection(); setMode('develop'); developView.key=''; render(); },
  async saveSettings(patch) { state.settings = await api.settings(patch); return state.settings; },
  onDraftChange: draft => tether?.draftChanged(draft),
});

// The open Del / Shift+Del confirmation, if any: { ids, mode, session, view }.
let deletePrompt = null;
function toast(message) {
  const notice = $('toast'), settings = $('settings-dialog');
  const surface = settings.open ? settings : document.body;
  if (notice.parentNode !== surface) surface.append(notice);
  notice.textContent = message; notice.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500);
}
function initUpdater({ api, $, toast, getTether, confirmInstall, isBusy, setBusy }) {
  const banner = $('update-banner'), bannerText = $('update-banner-text'), dismiss = $('update-banner-dismiss');
  const checkButton = $('settings-check-updates'), installButton = $('settings-install-update');
  const status = $('settings-update-status'), progress = $('settings-update-progress');
  const dismissed = new Set();
  let available = null, checking = null, manual = false, installing = false;

  function controls() {
    banner.hidden = !available || dismissed.has(available.version);
    installButton.hidden = !available;
    installButton.disabled = $('update-banner-install').disabled = !!checking || installing;
    checkButton.disabled = manual || installing;
    dismiss.disabled = installing;
  }
  function showAvailable(result) {
    available = result;
    const message = `PhotoCull ${result.version} is available`;
    const notes = result.body?.trim().replace(/\s+/g, ' ') || '';
    status.textContent = notes ? `${message} · ${notes.length > 240 ? notes.slice(0, 239) + '…' : notes}` : message;
    bannerText.textContent = `Update ${result.version}`;
    return message;
  }
  function notify(message) {
    status.textContent = message;
    toast(message);
  }
  function check(userRequested) {
    if (installing) return;
    if (userRequested && !manual) {
      manual = true;
      status.textContent = 'Checking for updates…';
      if (status.offsetParent === null) toast(status.textContent);
    }
    if (!checking) {
      checking = Promise.resolve().then(() => api.checkForUpdates()).then(result => {
        if (result.status === 'available') {
          const message = showAvailable(result);
          if (manual) { dismissed.delete(result.version); toast(message); }
        } else if (result.status === 'up-to-date') {
          available = null;
          if (manual) {
            status.textContent = `PhotoCull ${result.currentVersion} is up to date`;
            if (status.offsetParent === null) toast(status.textContent);
          } else status.textContent = '';
        } else if (manual) {
          throw new Error(result.message || (result.status === 'unsupported' ? 'Updates are only available in the desktop app.' : 'Please try again later.'));
        }
      }).catch(error => {
        if (manual) {
          status.textContent = `Couldn’t check for updates. ${error?.message || error}`;
          if (status.offsetParent === null) toast(status.textContent);
        }
      }).finally(() => { checking = null; manual = false; controls(); });
    }
    controls();
    return checking;
  }
  function showProgress(event) {
    if (!installing) return;
    if (event.phase === 'error') {
      status.textContent = event.message;
      progress.hidden = true;
      return;
    }
    let percent = null, message;
    if (event.phase === 'installing') message = 'Installing…';
    else if (event.phase === 'downloading') {
      if (Number.isFinite(event.percent)) percent = event.percent;
      else if (event.total > 0 && Number.isFinite(event.downloaded)) percent = event.downloaded * 100 / event.total;
      if (percent !== null) percent = Math.min(100, Math.max(0, Math.round(percent)));
      message = percent === null ? 'Downloading…' : `Downloading ${percent}%…`;
    } else return;
    if (percent === null) progress.removeAttribute('value'); else progress.value = percent;
    progress.hidden = false;
    status.textContent = bannerText.textContent = message;
  }
  async function install() {
    if (!available || checking || installing) return;
    if (isBusy()) return notify('Finish the active operation before installing an update.');
    installing = true;
    try {
      setBusy(true);
      controls();
      const tether = getTether();
      if (tether?.shoot) {
        if (await tether.hasPendingWork()) return notify('Wait for pending tethered captures to finish before installing an update.');
        if (!confirmInstall(`Stop the active tethered session and restart PhotoCull to install update ${available.version}?`)) return;
        const stopped = await tether.stopSession({ requireIdle: true });
        if (!stopped) return;
        if (Array.isArray(stopped.pending) ? stopped.pending.length > 0 : stopped.pending > 0) {
          return notify('The tethered session stopped with unrecovered captures. Recover them before installing the update.');
        }
        if (tether.shoot) return notify('A tethered session is still active. Update canceled.');
      }
      dismissed.delete(available.version);
      controls();
      showProgress({ phase: 'downloading' });
      const result = await api.installUpdate(available.version);
      if (result?.status === 'up-to-date') {
        available = null;
        notify(`PhotoCull ${result.currentVersion} is up to date`);
      } else if (result?.status === 'changed') {
        dismissed.delete(result.version);
        showAvailable(result);
        toast(`PhotoCull ${result.version} is now available — click Install to confirm.`);
      } else if (typeof result === 'string' && result) throw new Error(result);
      else showAvailable(available);
    } catch (error) {
      bannerText.textContent = `Update ${available.version}`;
      notify(error?.message || String(error || 'Couldn’t install the update. Please try again.'));
    } finally {
      installing = false;
      progress.hidden = true;
      controls();
      setBusy(false);
    }
  }
  $('settings-updates').hidden = false;
  checkButton.onclick = () => check(true);
  installButton.onclick = $('update-banner-install').onclick = install;
  dismiss.onclick = () => { dismissed.add(available.version); controls(); };
  api.onUpdateProgress(showProgress);
  api.onCheckUpdates(() => check(true));
  return { check };
}
const updater = api.desktop && initUpdater({ api, $, toast, getTether: () => tether, confirmInstall: message => confirm(message),
  isBusy: workspaceBusy, setBusy });
function photo() { return state.session?.items.find(i => i.id === state.selected); }
function selection() { return state.marked.size > 1 ? filtered().filter(i => state.marked.has(i.id)) : photo() ? [photo()] : []; }
function resetSelection() { state.marked = new Set(state.selected ? [state.selected] : []); state.anchor = state.selected; }
function viewKey() { return JSON.stringify([state.filter, state.query, state.colorFilter, state.metadataFilters]); }
function sameIds(ids, items = selection()) { const marked = new Set(ids); return ids.length === items.length && items.every(item => marked.has(item.id)); }
function additive(event) {
  if (api.platform === 'darwin') return event.metaKey;
  return api.platform === 'web' ? event.ctrlKey || event.metaKey : event.ctrlKey; // web: tests run on macOS, where Ctrl+click is a right-click
}
function reviewed(item) { return item.flag !== 'none' || item.rating > 0 || !!item.color; }
const indexedRows = new WeakMap();
function metadataRow(item) {
  const index = culling.metadata.get(item.id)?.index;
  const preset = state.settings.metadata;
  const cached = indexedRows.get(item);
  if (cached && cached.index === index && cached.preset === preset && cached.overrides === item.metadataOverrides &&
    cached.sidecar === item.sidecarMetadata && cached.capture === item.captureMetadata) return cached.row;
  const row = { name: item.name, metadataPending: !index, ...index, ...PhotoCullMetadata.descriptive(item, index?.embedded, preset) };
  indexedRows.set(item, { index, preset, overrides: item.metadataOverrides, sidecar: item.sidecarMetadata, capture: item.captureMetadata, row });
  return row;
}
let compiledQuery, compiledFilters, matchMetadata;
function matchesMetadata(item) {
  if (compiledQuery !== state.query || compiledFilters !== state.metadataFilters) {
    compiledQuery = state.query; compiledFilters = state.metadataFilters;
    matchMetadata = state.query || Object.keys(compiledFilters).length ? PhotoCullMetadata.compile(state.query, compiledFilters) : null;
  }
  return !matchMetadata || matchMetadata(metadataRow(item));
}
function filtered() {
  return (state.session?.items ?? []).filter(item => {
    // Trashed photos only appear in the Trash view.
    const match = state.filter === 'trash' ? item.trashed : !item.trashed && (state.filter === 'all' || state.filter === 'unreviewed' && !reviewed(item) ||
      state.filter === 'external' && item.externalEdit || state.filter === 'rated' && item.rating > 0 || item.flag === state.filter);
    return match && (!state.colorFilter || colorOf(item) === state.colorFilter) && matchesMetadata(item);
  });
}
function imageUrl(item, kind = 'thumb', prefetch = false) {
  return api.imageUrl(state.session.id, item.id, kind, `&d=${item.developRevision || 0}&edit=${item.externalEdit ? 1 : 0}&v=${state.previewRevision}${state.showOriginal ? '&original=1' : ''}${item.contentRev ? `&cr=${item.contentRev}` : ''}${prefetch ? '&prefetch=1' : ''}`);
}
const xmpEligible = item => item.edited || item.adjusted || item.developed || item.externalEdit || item.recipe || item.developRevision > 0 || !!item.captureMetadata || Object.hasOwn(item, 'metadataOverrides');
function fileSize(bytes) { return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
function setStatus(text, error = false) {
  $('save-status').textContent = text;
  $('save-status').style.color = error ? '#e99787' : '';
}

// The backend keeps a tethered shoot's folder open, so another folder or card needs the shoot stopped first.
async function leaveTether() {
  if (!tether?.active()) return true;
  if (!confirm('Stop the tethered session and open another folder?')) return false;
  return tether.stopSession();
}
async function openFolder() {
  if (state.busy || state.copy.running || state.deleting || !await leaveTether()) return;
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
  if(state.mode==='compare')state.mode=stageMode();
  cancelCulling();culling.metadata.clear();culling.jobs.clear();culling.scores.clear();culling.expanded.clear();culling.bursts=[];culling.byId.clear();
  state.session = session; state.selected = session.items[0]?.id ?? null;
  state.proposals = []; state.proposalsBusy = false; state.proposalsLoading = !api.server; state.proposalWarning = ''; proposalSignature = '';
  resetSelection();
  state.showOriginal = false; clearFilters(); closeMetadataFilters(); state.saveError = false; loupe.reset();
  $('grid').scrollTop = 0;
  const folderName = session.folder.split(/[\\/]/).filter(Boolean).pop();
  $('folder-name').textContent = folderName; $('folder-name').title = session.folder;
  $('folder-detail').textContent = `${session.items.length} photos`;
  $('breadcrumb').textContent = session.folder;
  $('breadcrumb').title = session.folder;
  $('export').disabled = !session.items.length;
  gridNodes.clear(); filmNodes.clear(); $('grid-content').replaceChildren();
  survey?.unpin(); render(); renderDevices(); tether?.sessionLoaded(session);
  setStatus('Saved');void analyzeCulling();
  if (session.warnings.length) toast(`${session.warnings.length} file or sidecar warning(s): ${session.warnings[0]}`);
  const missingHandoffs = session.items.filter(i => i.handoffMissing).length;
  if (missingHandoffs) toast(`${missingHandoffs} external edit(s) missing. Showing original photos; copy the hand-off folder alongside the photos.`);
  if (!session.items.length) toast('No supported images found. Try including subfolders.');
  void api.externalEditProposals(session.id).then(result => {
    if (state.session?.id !== session.id) return;
    state.proposals = result.proposals; state.proposalWarning = result.warnings.join(' ');
  }).catch(error => { if (state.session?.id === session.id) state.proposalWarning = error.message; })
    .finally(() => { if (state.session?.id === session.id) { state.proposalsLoading = false; render(); } });
}

function renderDevices() {
  const removed = state.session?.deviceId && !state.devices.some(d => d.id === state.session.deviceId);
  $('devices-panel').hidden = !state.devices.length && !state.deviceError && !removed;
  $('device-list').replaceChildren(...state.devices.map(device => {
    const button = document.createElement('button'); button.className = 'device-button';
    const name = document.createElement('span'), where = document.createElement('span');
    name.className = 'device-name'; name.textContent = device.label; where.className = 'device-path'; where.textContent = device.root;
    button.append(name, where); button.setAttribute('aria-label', `Open ${device.label} · ${device.root}`);
    button.title = device.photoRoot;
    button.disabled = state.busy || state.copy.running || state.deleting;
    button.onclick = () => openDevice(device);
    const row=document.createElement('div');row.append(button,deviceBackupRow(device));return row;
  }));
  $('device-status').textContent = removed ? 'Card disconnected' : state.deviceError || '';
}
async function openDevice(device) {
  if (state.busy || state.copy.running || state.deleting || !await leaveTether()) return;
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
  if (welcomeSettled && !autoOpenSuppressed && state.settingsReady && state.settings.autoOpenCards && !tether?.active() && !document.querySelector('dialog[open]') && !state.session && !state.busy && cameras.length === 1 && !state.autoOpened.has(cameras[0].id)) {
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
  const proposed = pendingProposals().length;
  $('count-external').textContent = `${items.filter(i => i.externalEdit).length}${proposed ? ` (${proposed})` : ''}`;
  $('count-external').title = proposed ? `${proposed} proposed matches awaiting review` : '';
  $('count-rated').textContent = items.filter(i => i.rating > 0).length;
  $('progress-text').textContent = `${count} of ${items.length}`;
  $('progress-fill').style.width = `${items.length ? count / items.length * 100 : 0}%`;
  document.querySelectorAll('.filter').forEach(button => { const active = button.dataset.filter === state.filter; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
}

function render(reset = false) {
  renderMetadataFilters();
  renderEditorActions();
  $('export').disabled = state.busy || state.deleting || !state.session?.items.length;
  $('image-export').disabled = state.busy || !state.session?.items.length || state.deleting || state.copy.running;
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
  const loaded = !!state.session?.items.length, test = !!testShot();
  $('empty').hidden = loaded || test;
  const hasProposals = state.filter === 'external' && (pendingProposals(true).length || state.proposalsLoading || state.proposalWarning);
  $('no-matches').hidden = !loaded || !!items.length || !!hasProposals || test;
  $('review').hidden = !test && (!loaded || !items.length || !photoStage());
  $('grid').hidden = !loaded || !items.length && !hasProposals || state.mode !== 'grid';
  $('grid-size-control').hidden = !loaded || state.mode !== 'grid';
  $('review-mode').setAttribute('aria-pressed', String(state.mode === 'review')); $('grid-mode').setAttribute('aria-pressed', String(state.mode === 'grid'));
  $('review-mode').classList.toggle('active', state.mode === 'review');
  $('grid-mode').classList.toggle('active', state.mode === 'grid');
  $('develop-mode').classList.toggle('active', state.mode === 'develop'); $('develop-mode').setAttribute('aria-pressed', String(state.mode === 'develop'));
  $('tether-mode').classList.toggle('active', state.studio); $('tether-mode').setAttribute('aria-pressed', String(state.studio));
  document.body.classList.toggle('tether-active', state.studio);
  const titles = { all: 'Photos', unreviewed: 'Unreviewed', pick: 'Picks', reject: 'Rejects', rated: 'Rated', external: 'External edits', trash: 'Trash' };
  $('view-title').textContent = loaded ? titles[state.filter] : 'Photos';
  $('view-count').textContent = loaded ? `${items.length}${state.marked.size > 1 ? ` · ${state.marked.size} selected` : ''}` : '';
  const rejects = scopeItems('reject').length, trashed = scopeItems('trash').length, locked = testBlocksCulling() || state.busy || state.copy.running || state.deleting;
  $('delete-rejects').hidden = !loaded || state.filter !== 'reject' || !rejects;
  $('delete-rejects').disabled = locked;
  $('delete-rejects').querySelector('span').textContent = `Delete ${rejects} reject${rejects === 1 ? '' : 's'}`;
  $('trash-restore').hidden = !loaded || state.filter !== 'trash' || !trashed;
  $('empty-trash').hidden = !loaded || state.filter !== 'trash' || !trashed;
  $('trash-restore').disabled = $('empty-trash').disabled = locked;
  if (deletePrompt && (state.session?.id !== deletePrompt.session || viewKey() !== deletePrompt.view || !sameIds(deletePrompt.ids))) hideDeletePrompt();
  renderSelection();
  renderCulling();
  renderProposals();
  if (state.mode === 'grid') requestGrid();
}

function pendingProposals(scoped = false) {
  return state.proposals.filter(p => {
    const item = state.session?.items.find(i => i.id === p.itemId);
    return item && !item.trashed && !item.tiff && (!scoped || (!state.colorFilter || colorOf(item) === state.colorFilter) && matchesMetadata(item));
  });
}
let proposalSignature = '';
function renderProposals() {
  const section = $('external-proposals'), proposals = pendingProposals(true);
  section.hidden = state.filter !== 'external' || !proposals.length && !state.proposalsLoading && !state.proposalWarning;
  if (section.hidden) return;
  $('proposal-count').textContent = proposals.length ? `(${proposals.length})` : '';
  $('proposal-status').textContent = state.proposalsLoading ? 'Checking saved edits and hand-off folders…' : state.proposalWarning || 'Review these edits before linking them to your originals.';
  const locked = state.proposalsBusy || state.busy || state.copy.running || state.deleting;
  const conflict = new Set(proposals.map(p => p.itemId)).size !== proposals.length;
  $('proposal-accept-all').disabled = locked || !proposals.length || conflict;
  $('proposal-accept-all').title = conflict ? 'Choose one edit for each photo before accepting the remaining matches.' : '';
  $('proposal-reject-all').disabled = locked || !proposals.length;
  const signature = JSON.stringify([state.session?.id, proposals, locked]);
  if (signature === proposalSignature) return;
  proposalSignature = signature;
  $('proposal-list').replaceChildren(...proposals.map(p => {
    const card = document.createElement('article'); card.className = 'proposal-card'; card.dataset.proposal = p.id; card.setAttribute('aria-label', `Proposed edit for ${p.name}`);
    const images = document.createElement('div'); images.className = 'proposal-images';
    for (const [label, extra] of [['Original', '&original=1'], ['External edit', `&proposal=${p.id}`]]) {
      const figure = document.createElement('figure'), image = document.createElement('img'), caption = document.createElement('figcaption');
      image.alt = `${label}: ${p.name}`; image.loading = 'lazy'; image.src = api.imageUrl(state.session.id, p.itemId, 'thumb', extra); caption.textContent = label; figure.append(image, caption); images.append(figure);
    }
    const name = document.createElement('strong'); name.textContent = p.name;
    const file = document.createElement('p'); file.className = 'subtle small proposal-path'; file.textContent = p.file; file.title = p.file;
    const actions = document.createElement('div'); actions.className = 'proposal-actions';
    for (const [label, accept] of [['Accept', true], ['Reject', false]]) {
      const button = document.createElement('button'); button.className = 'button quiet'; button.textContent = label; button.disabled = locked; button.onclick = () => decideProposals([p.id], accept); actions.append(button);
    }
    card.append(images, name, file, actions); return card;
  }));
}
async function decideProposals(ids, accept) {
  if (!ids.length || state.proposalsBusy || state.busy || state.copy.running || state.deleting) return;
  const session = state.session.id; state.proposalsBusy = true; render();
  try {
    const result = await api.externalEditDecide(session, ids, accept);
    if (state.session?.id !== session) return;
    state.proposals = result.proposals;
    for (const patch of result.items) Object.assign(state.session.items.find(i => i.id === patch.id), patch);
    if (accept) { state.previewRevision++; handoffUsageKey = ''; }
  } catch (error) { toast(error.message); }
  finally { if (state.session?.id === session) { state.proposalsBusy = false; render(); } }
}
$('external-proposals').addEventListener('pointerdown', event => event.stopPropagation());
$('proposal-accept-all').onclick = () => decideProposals(pendingProposals(true).map(p => p.id), true);
$('proposal-reject-all').onclick = () => decideProposals(pendingProposals(true).map(p => p.id), false);

function renderSelection() {
  renderIptc();
  const item = photo();
  developView.sync({ mode: state.mode, session: state.session, photo: item });
  tether?.selectionChanged();
  $('image-details').hidden = !item; $('inspector-empty').hidden = !!item;
  if (!item) {
    for (const button of document.querySelectorAll('.decision-bar button, #color-labels button')) button.disabled = true;
    state.generation++; if (testShot()) showTestShot(); else loupe.clear(); if (state.fullscreen) void setFullscreen(false); return;
  }
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
  const locked = !!testBlocksCulling();
  for (const button of document.querySelectorAll('.decision-bar button, #color-labels button')) button.disabled = locked;
  if (locked) { $('detail-decision').textContent = testCullMessage; $('flag-overlay').hidden = true; }
  renderFilmstrip(items, index);
  clearTimeout(metadataTimer);
  if (testShot()) return showTestShot();
  if (photoStage()) loupe.show(item);
  metadataTimer = setTimeout(() => loadMetadata(item), 180);
}

// The frame takes the stage and Details; the filmstrip and selection stay on the session photo underneath.
function showTestShot() {
  const shot = testShot(), meta = shot.meta || {};
  loupe.store(shot.item.id, { kind: 'full', url: shot.url, width: shot.width, height: shot.height, info: { type: 'test' } });
  loupe.show(shot.item);
  $('photo-name').textContent = 'Test shot · not saved'; $('preview-source').textContent = 'Test shot · not saved';
  $('image-details').hidden = false; $('inspector-empty').hidden = true; $('detail-name').textContent = 'Test shot · not saved';
  $('metadata').dataset.image = shot.item.id;
  $('metadata').replaceChildren(...[['Exposure', [meta.shutter ? `${meta.shutter} s` : '', meta.aperture, meta.iso ? `ISO ${meta.iso}` : ''].filter(Boolean).join(' · ')], ['Focal length', meta.focalLength], ['Flash', meta.flash], ['Preview', `${shot.width} × ${shot.height}`]]
    .flatMap(([name, value]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = value || '—'; return [dt, dd]; }));
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
  if (status.id !== state.selected || !photoStage() || $('review-image').dataset.complete) return;
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

// Flash compensation is listed only when it was dialed in.
function flashText(meta) {
  const comp = String(meta.flashComp ?? '').trim(), dialed = !!comp && Number.parseFloat(comp) !== 0;
  return [meta.flash, dialed ? (/ev/i.test(comp) ? comp : `${comp} EV`) : ''].filter(Boolean).join(' · ');
}

async function loadMetadata(item) {
  const sessionId = state.session.id, imageId = item.id, generation = state.generation;
  if ($('metadata').dataset.image !== imageId) {
    $('metadata').dataset.image = imageId;
    $('metadata').textContent = 'Loading…';
  }
  try {
    const metadata = await api.metadata(sessionId,imageId,loupe.kind());
    if (state.session?.id === sessionId) {
      const newlyIndexed = metadata.index && !culling.metadata.get(imageId)?.index;
      culling.metadata.set(imageId, metadata);
      if (newlyIndexed && (state.query || Object.keys(state.metadataFilters).length || !filterPanel.hidden)) render();
      if (state.selected === imageId) renderIptc();
    }
    if (state.selected !== imageId || state.session.id !== sessionId || state.generation !== generation) return;
    const rows = [['Camera', metadata.camera], ['Lens', metadata.lens], ['Exposure', [metadata.shutter ? `${metadata.shutter} s` : '', metadata.aperture, metadata.iso ? `ISO ${metadata.iso}` : ''].filter(Boolean).join(' · ')],
      ['Captured', formatCaptureDate(metadata.captured)], ...(metadata.flash ? [['Flash', flashText(metadata)]] : []), ['Autofocus', metadata.focus?.source], ['Sharpness', Number.isFinite(culling.scores.get(imageId)) ? culling.scores.get(imageId).toFixed(1) + ' · preview detail' : api.canAnalyze ? 'Pending analysis' : 'Desktop app required'], ['Preview', metadata.width && metadata.height ? `${metadata.width} × ${metadata.height}` : ''], ['Source', metadata.source], ['Develop', item.externalEdit ? `Edited in ${editorName(item.editedBy)} · open Develop to view` : item.developed ? 'Developed hand-off' : item.adjusted ? 'RAW adjustments' : '']];
    const shot = item.captureMetadata && metadataRow(item);
    if (shot) rows.push(...[['Creator', shot.creator], ['Copyright', shot.copyright], ['Caption', shot.caption], ['Keywords', shot.keywords?.join(', ')]].filter(([, value]) => value));
    $('metadata').replaceChildren(...rows.flatMap(([name, value]) => {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = name; dd.textContent = value || '—'; return [dt, dd];
    }));
    if (!loupe.showsDeveloped(imageId)) $('preview-source').textContent = metadata.source || item.source;
    applyFocus();
  } catch { if (state.selected === imageId) $('metadata').textContent = 'Metadata unavailable'; }
}

function renderFilmstrip(items, index) {
  items=stackItems(items);index=items.findIndex(i=>i.id===state.selected);
  const start = Math.max(0, index - 3), nearby = items.slice(start, Math.min(items.length, index + 5));
  if (photoStage()) void api.visible(state.session.id, nearby.map(i => i.id)).catch(() => {});
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
    button.querySelectorAll('.badge-row').forEach(node => node.remove()); addFlag(button, item); button.setAttribute('aria-description', thumbStatus(item) || 'Unreviewed'); return button;
  });
  // Only when the cards differ: re-inserting a card drops its hover state, so a card under the
  // pointer or a finger blinked on every analysis tick.
  const strip = $('filmstrip');
  if (nodes.length !== strip.children.length || nodes.some((node, i) => strip.children[i] !== node)) strip.replaceChildren(...nodes);
  const retained = new Set(nearby.map(item => item.id)); for (const id of filmNodes.keys()) if (!retained.has(id)) filmNodes.delete(id);

}

function badgeRow(node, place) {
  let row = node.querySelector(`:scope > .badge-row.${place}`);
  if (!row) { row = document.createElement('span'); row.className = `badge-row ${place}`; node.append(row); }
  return row;
}
function thumbStatus(item) {
  const burst = culling.byId.get(item.id), color = state.settings.colors.find(c => c.id === colorOf(item));
  return [item.flag === 'pick' ? 'Pick' : item.flag === 'reject' ? 'Rejected' : '', item.rating ? `${item.rating} star${item.rating === 1 ? '' : 's'}` : '', color?.name,
    burst ? `burst of ${burst.ids.length}` : '', burst && bestIn(burst) === item.id ? 'sharpest' : '', item.adjusted && 'Adjusted', item.developed && 'Hand-off', item.externalEdit && `Edited in ${editorName(item.editedBy)}`, tether?.misfireOf(item) && 'Possible flash misfire'].filter(Boolean).join(', ');
}
const SVG = 'http://www.w3.org/2000/svg';
function addFlag(node, item) {
  const misfire = tether?.misfireOf(item);
  if (misfire) {
    const badge = document.createElement('span'), icon = document.createElementNS(SVG, 'svg'), bolt = document.createElementNS(SVG, 'path');
    badge.className = 'mini-misfire'; badge.title = `Possible flash misfire${misfire.detail ? ` · ${misfire.detail}` : ''}`;
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); bolt.setAttribute('d', 'M13 2 4.5 13.5H11L10 22l8.5-11.5H12Z');
    icon.append(bolt); badge.append(icon, Object.assign(document.createElement('span'), { className: 'badge-label', textContent: 'Misfire?' }));
    badgeRow(node, 'top').append(badge);
  }
  addBurstBadges(node,item);
  const marks = [item.adjusted && 'Adjusted', item.developed && 'Hand-off', item.externalEdit && `Edited in ${editorName(item.editedBy)}`].filter(Boolean);
  if (marks.length) { const badge = document.createElement('span'); badge.className = 'develop-badges'; badge.textContent = marks.map(m => m === 'Adjusted' ? '±' : m === 'Hand-off' ? 'H' : 'E').join(' '); badge.title = marks.join(' · '); badgeRow(node, 'bottom').append(badge); }
  const color = state.settings.colors.find(c => c.id === colorOf(item));
  if (color) { const dot = document.createElement('span'); dot.className = 'mini-color'; dot.style.setProperty('--label-color', color.hex); dot.title = color.name; badgeRow(node, 'top').append(dot); }
  if (item.flag !== 'none' || item.rating) {
    const flag = document.createElement('span'); flag.className = `mini-flag${item.flag === 'reject' ? ' rejected' : ''}`;
    if (item.flag !== 'none') flag.append(Object.assign(document.createElement('span'), { className: 'mini-mark', textContent: item.flag === 'pick' ? '⚑' : '×' }));
    if (item.rating) flag.append(Object.assign(document.createElement('span'), { className: 'mini-stars', textContent: '★'.repeat(item.rating) }));
    badgeRow(node, 'bottom').append(flag);
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
    const item = items[i], signature = `${burstSignature(item)}:${item.id}:${item.flag}:${item.rating}:${item.color}:${item.adjusted}:${item.developed}:${item.externalEdit}:${item.editedBy}:${item.developRevision}:${item.contentRev || 0}:${state.previewRevision}:${!!tether?.misfireOf(item)}`;
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
      node.onclick = event => { select(item.id, event); if (gridPointer === 'touch' && !event.shiftKey && !additive(event)) setMode('review'); }; node.ondblclick = () => setMode('review');
      node.setAttribute('aria-label', item.name); node.setAttribute('aria-description', thumbStatus(item) || 'Unreviewed'); container.append(node); gridNodes.set(item.id, node);
    }
    node.classList.toggle('selected', state.marked.has(item.id)); node.classList.toggle('current', item.id === state.selected);
    node.style.left = `${(i % columns) * width}px`; node.style.top = `${Math.floor(i / columns) * rowHeight}px`;
    node.style.width = `${width - 10}px`; node.style.height = `${rowHeight - 12}px`;
  }
  void api.visible(state.session.id, [...retained].slice(0, 128)).catch(() => {});
  for (const [id, node] of gridNodes) { if (!retained.has(id)) { node.remove(); gridNodes.delete(id); } }
}

let marquee = null, suppressGridClick = false, gridPointer = 'mouse';
$('grid').addEventListener('pointerdown', event => { gridPointer = event.pointerType; }, true);
$('grid').addEventListener('dragstart', event => event.preventDefault());
$('grid').addEventListener('click', event => {
  if (suppressGridClick) { event.preventDefault(); event.stopPropagation(); suppressGridClick = false; }
}, true);
$('grid').addEventListener('pointerdown', event => {
  if (event.button !== 0 || !event.isPrimary || state.deleting) return;
  // A finger or pen drag scrolls the grid; only the mouse draws a selection box.
  if (event.pointerType !== 'mouse') return;
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
  tether?.navigated();
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
  if(state.mode==='compare'){survey.swap(delta<0?-1:1);return;}
  const items = state.mode==='grid' ? stackItems(filtered()) : filtered(), index = items.findIndex(i => i.id === state.selected);
  const next = items[Math.max(0, Math.min(items.length - 1, index + delta))];
  if (next) select(next.id, { shiftKey: extend });
}
// Grid, Review and Develop leave the Tether workspace; Compare inside it (a pinned reference) keeps it.
function setMode(mode) {
  if(state.mode==='compare' && mode!=='compare')survey.unpin();
  if(mode==='compare' && state.mode!=='compare' && !survey.open(selection().map(i=>i.id),filtered()))return toast('Select at least two photos to compare.');
  if (!['review','tether'].includes(mode) && state.fullscreen) void setFullscreen(false);
  loupe.cancelHand(); state.generation++;
  const studio = mode === 'compare' ? state.studio : mode === 'tether', changed = studio !== state.studio;
  state.mode = mode; state.studio = studio;
  render();
  if (changed) { applyPaneLayout(); tether?.modeChanged(); }
}

function nextSurvivor(items, ids) {
  let last = -1;
  for (let i = 0; i < items.length; i++) if (ids.has(items[i].id)) last = i;
  return items.slice(last + 1).find(i => !ids.has(i.id)) ?? items.slice(0, last).reverse().find(i => !ids.has(i.id));
}
async function decide(patch) {
  if (guardStageCull()) return;
  const targets = state.mode==='compare' ? (photo()?[photo()]:[]) : selection();
  if (!targets.length) return;
  const sessionId = state.session.id;
  const items = filtered(), ids = new Set(targets.map(i => i.id)), nextId = nextSurvivor(items, ids)?.id;
  for (const item of targets) Object.assign(item, patch, { edited: true });
  if('trashed' in patch)regroupBursts();
  if ('trashed' in patch || state.mode!=='compare' && targets.length === 1 && patch.flag && state.settings.autoAdvance && nextId) {
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
    const session = state.session;
    const result = await api.history(session.id, direction);
    if (state.session !== session) return;
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
$('review-mode').onclick = () => setMode('review'); $('grid-mode').onclick = () => setMode('grid'); $('develop-mode').onclick = () => setMode('develop'); $('tether-mode').onclick = () => setMode('tether');
const filterPanel = $('metadata-filters');
function clearFilters() {
  state.filter = 'all'; state.query = ''; state.colorFilter = ''; state.metadataFilters = {};
  $('search').value = ''; $('color-filter').value = '';
  for (const control of filterPanel.querySelectorAll('[name]')) control.value = '';
}
function closeMetadataFilters() {
  filterPanel.hidden = true;
  $('metadata-filter-toggle').setAttribute('aria-expanded', 'false');
  renderIndexStatus();
}
function renderIndexStatus() {
  const status = $('metadata-index-status');
  const run = metadataIndex;
  const active = !filterPanel.hidden || state.query || Object.keys(state.metadataFilters).length;
  status.hidden = !active || !run || run.session !== state.session || run.done && !run.failures;
  if (!status.hidden) status.textContent = run.done ? `Metadata unavailable for ${run.failures} photos` : `Indexing metadata (${run.processed}/${run.total})…`;
}
function renderMetadataFilters() {
  renderIndexStatus();
  const count = Object.keys(state.metadataFilters).length + Number(!!state.colorFilter);
  $('filter-count').hidden = !count; $('filter-count').textContent = count;
  if (filterPanel.hidden) return;
  const facets = { camera: new Set(), lens: new Set(), date: new Set(), keyword: new Set() };
  for (const item of state.session?.items || []) {
    const row = metadataRow(item);
    for (const key of ['camera', 'lens', 'date']) if (row[key]) facets[key].add(row[key]);
    for (const word of row.keywords) facets.keyword.add(word);
  }
  for (const [key, values] of Object.entries(facets)) {
    const select = filterPanel.querySelector(`[name="${key}"]`), current = state.metadataFilters[key] || '';
    if (current) values.add(current);
    const choices = [...values].sort((a, b) => a.localeCompare(b));
    if (select.length !== choices.length + 1 || choices.some((value, i) => select.options[i + 1].value !== value)) {
      select.replaceChildren(option('', 'Any'), ...choices.map(value => option(value, value)));
    }
    select.value = current;
  }
}
$('metadata-filter-toggle').onclick = () => {
  if (!filterPanel.hidden) return closeMetadataFilters();
  filterPanel.hidden = false; $('metadata-filter-toggle').setAttribute('aria-expanded', 'true');
  renderMetadataFilters(); filterPanel.querySelector('[name=camera]').focus();
};
$('close-metadata-filters').onclick = () => { closeMetadataFilters(); $('metadata-filter-toggle').focus(); };
filterPanel.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); $('close-metadata-filters').click(); }
  event.stopPropagation();
});
document.addEventListener('pointerdown', event => {
  if (!filterPanel.hidden && !filterPanel.contains(event.target) && !$('metadata-filter-toggle').contains(event.target)) closeMetadataFilters();
});
filterPanel.addEventListener('input', event => {
  const { name, value } = event.target;
  if (!name) return;
  const filters = { ...state.metadataFilters };
  if (value) filters[name] = value; else delete filters[name];
  state.metadataFilters = filters; $('grid').scrollTop = 0; render(true);
});
$('clear-metadata-filters').onclick = () => { clearFilters(); render(true); };

const iptc = $('iptc-form'), dirtyFields = new Set();
let editorSelection = '', chipSignature = '', savingIptc = false;
function renderIptc() {
  const editor = $('iptc-editor');
  editor.hidden = !!testShot() || testBlocksCulling() || !photo();
  if (editor.hidden || !editor.open) { editorSelection = ''; return; }
  const targets = selection(), key = [state.session.id, ...targets.map(item => item.id)].join('/');
  if (key !== editorSelection) {
    dirtyFields.clear(); $('iptc-keyword').value = ''; editorSelection = key;
  }
  const rows = targets.map(metadataRow);
  for (const field of PhotoCullMetadata.textFields) {
    if (dirtyFields.has(field)) continue;
    const control = iptc.elements[field], value = rows[0]?.[field] || '', mixed = rows.some(row => row[field] !== value);
    control.placeholder = mixed ? '(Mixed)' : '';
    if (control.value !== (mixed ? '' : value)) control.value = mixed ? '' : value;
  }
  const words = new Map();
  for (const row of rows) for (const word of row.keywords) words.set(word, (words.get(word) || 0) + 1);
  const chips = [...words].map(([word, count]) => [word, count < rows.length]);
  const signature = JSON.stringify(chips);
  if (chipSignature !== signature) {
    chipSignature = signature;
    $('iptc-tags').replaceChildren(...chips.map(([word, mixed]) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'keyword-chip';
      button.textContent = word + (mixed ? ' (Mixed)' : '') + ' ×';
      button.setAttribute('aria-label', 'Remove keyword ' + word);
      button.onclick = () => saveIptc({ removeKeyword: word });
      return button;
    }));
  }
  iptc.querySelector('fieldset').disabled = savingIptc || !rows.length;
  $('iptc-save').disabled = !dirtyFields.size;
}
async function saveIptc(patch) {
  if (savingIptc || !Object.keys(patch).length || guardStageCull()) return;
  const session = state.session, key = editorSelection, focus = document.activeElement;
  savingIptc = true; state.pendingSaves++; setStatus('Saving…'); renderIptc();
  try {
    const result = await api.editMetadata(session.id, selection().map(item => item.id), patch);
    if (state.session !== session) return;
    const updates = new Map(result.items.map(item => [item.id, item]));
    for (const item of session.items) if (updates.has(item.id)) Object.assign(item, updates.get(item.id));
    if (editorSelection === key) {
      for (const field of Object.keys(patch)) dirtyFields.delete(field);
      if (patch.addKeyword) $('iptc-keyword').value = '';
    }
    render();
  } catch (error) { state.saveError = true; toast(error.message); }
  finally {
    savingIptc = false; state.pendingSaves--; renderIptc();
    if (focus === $('iptc-keyword') && editorSelection === key && document.activeElement === document.body) focus.focus();
    if (!state.pendingSaves) setStatus(state.saveError ? 'Save failed' : 'Saved', state.saveError);
  }
}
$('iptc-editor').ontoggle = () => renderIptc();
iptc.oninput = event => {
  if (PhotoCullMetadata.textFields.includes(event.target.name)) { dirtyFields.add(event.target.name); $('iptc-save').disabled = false; }
};
iptc.addEventListener('keydown', event => {
  const control = event.target;
  if (!control.matches('input, textarea')) return;
  event.stopPropagation();
  if (control.placeholder === '(Mixed)' && !control.value && ['Backspace', 'Delete'].includes(event.key)) {
    dirtyFields.add(control.name); $('iptc-save').disabled = false;
  }
});
$('search').onkeydown = event => event.stopPropagation();
iptc.onsubmit = event => { event.preventDefault(); void saveIptc(Object.fromEntries([...dirtyFields].map(field => [field, iptc.elements[field].value]))); };
$('iptc-add').onclick = () => { const word = $('iptc-keyword').value.trim(); if (word) void saveIptc({ addKeyword: word }); };
$('iptc-keyword').onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); $('iptc-add').click(); } };
$('search').oninput = event => { state.query = event.target.value; $('grid').scrollTop = 0; render(true); };
document.querySelectorAll('.filter').forEach(button => { button.onclick = () => {
  state.filter = button.dataset.filter; if (state.filter === 'external') setMode('grid'); $('grid').scrollTop = 0; render(true);
}; });
$('reset-filter').onclick = () => { clearFilters(); render(true); };
$('previous').onclick = () => navigate(-1); $('next').onclick = () => navigate(1);
$('pick').onclick = () => decide({ flag: photo()?.flag === 'pick' ? 'none' : 'pick' });
$('reject').onclick = () => decide({ flag: photo()?.flag === 'reject' ? 'none' : 'reject' });
$('clear').onclick = () => decide({ flag: 'none' });
// The burst chip on the photo offers Expand and Keep sharpest, whose toolbar buttons phones hide.
const burstMenu={stack:menuItem('Expand burst',()=>commands.execute('burst-stack')),keep:menuItem('Keep sharpest…',()=>commands.execute('burst-keep'))};
$('burst-menu').append(burstMenu.stack,burstMenu.keep);bindMenu($('burst-context'),$('burst-menu'));
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
  if (value && photo() && !photoStage()) setMode('review');
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
  if (value && !photoStage()) setMode('review');
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
  if (state.busy) return;
  $('export-results').hidden = true;
  $('export-xmp').disabled = !state.session.items.some(xmpEligible);
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
  $('export-xmp').disabled = state.copy.running || !state.session?.items.some(xmpEligible);
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
  if (workspaceBusy()) return;
  setBusy(true);
  $('export-xmp').disabled = true;
  try {
    const result = await api.exportXmp(state.session.id, readSettings());
    $('metadata-results').hidden = false;
    $('metadata-results').textContent = `${result.written} written · ${result.failures.length} failed\n` + result.failures.map(f => `${f.name}: ${f.reason}`).join('\n');
    toast(`${result.written} XMP sidecars written${result.failures.length ? `; ${result.failures.length} failed` : ''}`);
  } catch (e) { toast(e.message); }
  finally { $('export-xmp').disabled = false; setBusy(false); }
};
$('export-json').onclick = async () => {
  if (workspaceBusy()) return;
  setBusy(true);
  try { const file = await api.exportManifest(state.session.id); if (file) toast('Decisions manifest saved.'); }
  catch (e) { toast(e.message); }
  finally { setBusy(false); }
};
$('grid').onscroll = requestGrid;
new ResizeObserver(requestGrid).observe($('grid'));
const commandActions = {
  'check-updates': () => updater.check(true),
  'focus-overlay': event => {if(!event.repeat)return toggleFocus();}, 'focus-zoom': () => zoomFocus(), 'burst-stack': event => {if(!event.repeat)toggleBurst();}, 'burst-keep': () => promptKeepSharpest(),
  'view-compare': () => setMode(state.mode==='compare'?stageMode():'compare'), 'develop-split': () => developView.toggleSplit(),
  settings: () => openSettings(), open: () => openFolder(), export: () => imageExport.open(), 'copy-picks': () => $('export').click(), 'configure-editors': () => openSettings('editors'),
  ...Object.fromEntries(PhotoCullCommands.table.filter(c=>c.button).map(c=>[c.id,()=>$(c.button).click()])),
  'fullscreen-system': () => setFullscreen(), 'fullscreen-key': () => setFullscreen(), fullscreen: () => setFullscreen(),
  'switch-view': () => setMode(photoStage() ? 'grid' : 'review'), edit: () => $('edit-external').click(), original: () => toggleOriginal(),
  escape: () => { if(state.mode==='compare'){setMode(stageMode());return;}if (state.marked.size > 1) { resetSelection(); render(); } else if (state.fullscreen) return setFullscreen(false); else if (photoStage() && loupe.zoomed) loupe.fit(); },
  undo: () => history('undo'), redo: () => history('redo'), 'select-all': () => { state.marked = new Set(filtered().map(i => i.id)); render(); },
  delete: () => state.filter === 'trash' ? showDeletePrompt(deleteMode()) : moveToTrash(), 'delete-permanent': () => showDeletePrompt('permanent'), restore: () => restoreFromTrash(),
  sources: () => togglePane('sources'), details: () => togglePane('details'),
  'review-space': () => { if (photo()) setMode('review'); }, 'review-zoom': () => { if (photo()) { setMode('review'); loupe.zoomIn(); } },
  'view-grid': () => setMode('grid'), 'view-review': () => setMode('review'), 'view-develop': () => setMode('develop'), 'view-tether': () => setMode('tether'), help: () => openHelp(),
  'wb-pick': () => state.mode === 'develop' ? developView.toggleWhiteBalancePick() : tether?.toggleWhiteBalancePick(),
  'develop-copy': () => developView.copy(), 'develop-paste': () => developView.paste(), clipping: () => developView.toggleClipping(), before: () => developView.toggleBefore(),
  ...Object.fromEntries(PhotoCullCommands.table.filter(c=>c.id.startsWith('tether-')).map(c=>[c.id,event=>tether?.command(c.id,event)])),
  palette: () => openPalette(), 'go-photo': () => openPalette('> '), backup: () => openBackup(), 'treat-card': () => treatCard(), about: () => openSettings('about'), welcome: () => showWelcome(), diagnostics: () => copyDiagnostics(), logs: () => api.openLogs(),
};
for (let n=0;n<=8;n++) commandActions['color-alt-'+n] = () => decide({ color: n ? String(n) : '' });
for (let n=0;n<=5;n++) commandActions['rating-'+n] = () => decide({ rating: n });
for (let n=6;n<=9;n++) commandActions['color-'+n] = () => decide({ color: String(n-5) });
for (const flag of ['pick','reject','none']) commandActions['flag-'+flag] = () => decide({ flag });
for (const direction of ['left','right','up','down']) for (const extend of [false,true]) commandActions[(extend?'extend-':'navigate-')+direction] = () => navigate((['left','up'].includes(direction)?-1:1) * (['up','down'].includes(direction) && state.mode==='grid' ? gridLayout().columns : 1), extend && (!['up','down'].includes(direction) || state.mode==='grid'));
for (const [id,action] of Object.entries({'zoom-in':'zoom-in','zoom-out':'zoom-out',fit:'fit','zoom-toggle':'toggle',pan:'space'})) commandActions[id] = event => state.mode==='compare' ? survey.zoomAction(action) : loupe.handleKey(event, action);
let recentCommands = [], panKey = null;
// The server offers culling only: no Develop, external editors, export, camera cards or local files.
const DESKTOP_COMMANDS = new Set(['export', 'edit', 'configure-editors', 'view-develop', 'backup', 'treat-card', 'diagnostics', 'logs']);
function offered(command) {
  if (command.desktopOnly) return api.desktop;
  return !api.server || !DESKTOP_COMMANDS.has(command.id) && !command.desktop && command.context.some(mode => mode !== 'develop');
}
// Live View owns the keyboard while expanded; plain Review gains the tether-only keys while a shoot runs.
function commandContext() { return tether?.stageExpanded() ? 'stage' : state.mode === 'review' && tether?.reviewTools() ? ['review', 'tether-review'] : state.mode; }
const commands = PhotoCullCommands.create({ platform: api.platform, actions: Object.fromEntries(Object.entries(commandActions).map(([id,run]) => [id,event => {
  if(id==='pan'){if(!event.key)return loupe.handleKey(event,'toggle');panKey=event.code || event.key;}
  try { return Promise.resolve(run(event)).catch(error=>toast(error.message)); } catch(error) { toast(error.message); }
}])), context: commandContext, custom: () => state.settings.shortcuts || {},
  enabled: command => offered(command) && (!command.id.startsWith('tether-') || !!tether?.enabled(command.id)) && (!command.when || state.filter===command.when) && (!['burst-stack','burst-keep'].includes(command.id) || !!culling.byId.get(state.selected)) && (command.id!=='burst-keep' || !!bestIn(culling.byId.get(state.selected))) && (!/^(flag-|rating-|color-|navigate-|extend-|delete|restore|select-all)/.test(command.id) || !!photo()) && (command.id!=='go-photo'||state.session?.items.some(item=>!item.trashed)) && (command.id!=='copy-picks'||!$('export').disabled) && (command.id!=='treat-card'||canTreatCard()) && (!command.button||!$(command.button).matches(':disabled')) && (!['zoom-in','zoom-out','fit','zoom-toggle','pan','review-zoom'].includes(command.id) || !!photo()) && (command.id!=='wb-pick' || (state.mode==='develop' ? developView.canPickWhiteBalance() : !!tether?.canPickWhiteBalance())),
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
  if (document.querySelector('dialog[open]') || document.activeElement?.closest('[role=menu]')) return;
  commands.dispatch(event, { typing: ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable,
    button: document.activeElement?.matches('button, summary') });
});

// Deletion. Camera cards have no trash, so photos there are always deleted
// permanently; elsewhere the user's last choice is remembered in settings.
// PhotoCull's own Trash view is "Trash"; the operating system's is named here.
const systemTrash = api.trashName || (api.platform === 'win32' ? 'Recycle Bin' : 'system Trash');
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
  $('review-image').dataset.itemId = ''; $('review-image').dataset.stamp = '';
  $('folder-detail').textContent = `${state.session.items.length} photos`;
  $('export').disabled = !state.session.items.length;
}
// Tethered captures arrive as library deltas; a remap moves a provisional JPEG id onto its RAW pair.
const nameOrder = new Intl.Collator(undefined, { numeric: true });
function applyTetherDelta(delta) {
  if (state.session?.id !== delta.session) return;
  const remap = new Map((delta.remap || []).map(r => [r.from, r.to])), removed = new Set(delta.removedIds || []);
  const move = id => remap.get(id) ?? id, upserted = new Set((delta.upserts || []).map(i => i.id));
  for (const id of [...removed, ...remap.keys()]) if (!upserted.has(id)) { gridNodes.get(id)?.remove(); gridNodes.delete(id); filmNodes.delete(id); }
  const before = filtered(), gone = new Set([...removed].filter(id => !upserted.has(id) && !remap.has(id)));
  if (gone.has(state.selected)) { state.selected = nextSurvivor(before, gone)?.id ?? null; resetSelection(); }
  state.selected = move(state.selected); state.anchor = move(state.anchor); state.marked = new Set([...state.marked].map(move).filter(id => !gone.has(id)));
  for (const map of [culling.metadata, culling.scores]) for (const [from, to] of remap) if (map.has(from)) { if (!map.has(to)) map.set(to, map.get(from)); map.delete(from); }
  survey.remap(remap);
  let refresh = false;
  const items = state.session.items.filter(i => !removed.has(i.id) && !remap.has(i.id) || upserted.has(i.id)), byId = new Map(items.map(i => [i.id, i]));
  for (const patch of delta.upserts || []) {
    const item = byId.get(patch.id);
    if (!item) { items.push({ ...patch }); continue; }
    if ((item.contentRev || 0) !== (patch.contentRev || 0)) { refresh = true; gridNodes.get(item.id)?.remove(); gridNodes.delete(item.id); filmNodes.delete(item.id); }
    Object.assign(item, patch);
  }
  state.session.items = items.sort((a, b) => nameOrder.compare(a.name, b.name));
  regroupBursts();
  $('folder-detail').textContent = `${items.length} photos`; $('export').disabled = !items.length || state.deleting;
  if (refresh) loupe.invalidate();
  render();
  for (const patch of delta.upserts || []) void cullingMetadata(patch.id, delta.session).then(() => { if (state.session?.id === delta.session) { regroupBursts(); render(); } }).catch(() => {});
}
function replaceTetherLibrary(session) {
  if (state.session?.id !== session.id) return;
  const ids = new Set(session.items.map(i => i.id));
  for (const id of [...gridNodes.keys()]) if (!ids.has(id)) { gridNodes.get(id).remove(); gridNodes.delete(id); filmNodes.delete(id); }
  state.session.items = session.items; state.session.warnings = session.warnings ?? state.session.warnings;
  if (!ids.has(state.selected)) { state.selected = filtered()[0]?.id ?? null; resetSelection(); }
  regroupBursts(); $('folder-detail').textContent = `${session.items.length} photos`; $('export').disabled = !session.items.length;
  loupe.invalidate(); render();
}
async function moveToTrash() {
  if (guardStageCull()) return;
  const item = photo(), count = selection().length;
  if (!item || item.trashed || state.deleting) return;
  await decide({ trashed: true });
  toast(`Moved ${count > 1 ? plural(count, 'photo') : item.name} to Trash · ${api.platform === 'darwin' ? '⌘' : 'Ctrl+'}Z to undo`);
}
async function restoreFromTrash() {
  if (guardStageCull()) return;
  const item = photo(), count = selection().length;
  if (!item?.trashed || state.deleting) return;
  await decide({ trashed: false });
  toast(`Restored ${count > 1 ? plural(count, 'photo') : item.name}`);
}
$('trash-restore').onclick = () => void restoreFromTrash();
function showDeletePrompt(mode) {
  if (guardStageCull()) return;
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
  if (guardStageCull()) return;
  const visible = new Set(filtered().map(i => i.id));
  if (state.session?.id !== session || viewKey() !== view || !sameIds(ids) || !ids.every(id => visible.has(id)) || document.querySelector('dialog[open]')) return;
  await deletePhotos(ids, mode);
}
document.addEventListener('pointerdown', event => { if (deletePrompt && !$('delete-prompt').contains(event.target)) hideDeletePrompt(); }, true);
$('delete-prompt-confirm').onclick = () => void confirmDeletePrompt();
$('delete-prompt-cancel').onclick = () => hideDeletePrompt();
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
  if (guardStageCull()) return;
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
  if (!photoStage() || document.querySelector('dialog[open]') || active?.matches('input, textarea, select') || active?.isContentEditable) { loupe.cancelHand(); return; }
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
  tether?.settingsChanged();
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
  $('settings-auto-updates').checked = value.autoCheckUpdates !== false;
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
  $('metadata-results').hidden = true; $('export-xmp').disabled = !state.session?.items.some(xmpEligible); $('export-json').disabled = !state.session;
}
function readSettings() {
  const value = clone(settingsDraft);
  if (api.desktop) value.autoCheckUpdates = $('settings-auto-updates').checked;
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
// Save sends only what the dialog changed, so a dialog left open on one device cannot undo
// a change made meanwhile on another (the server shares one settings file).
let settingsBase = null;
function settingsPatch(before, after) {
  const patch = {}, same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const [key, value] of Object.entries(after)) {
    if (['presets', 'folder', 'warning'].includes(key) || same(before[key], value)) continue;
    patch[key] = key === 'metadata' ? Object.fromEntries(Object.entries(value).filter(([field, v]) => !same(before.metadata?.[field], v))) : value;
  }
  return patch;
}
async function openSettings(tab = 'general') {
  if (state.copy.running || backupRunning) return;
  try { const value = await api.settings(); state.settings = value; settingsDraft = clone(value); settingsBase = clone(value); const recipes = await api.recipes(); $('default-recipe').replaceChildren(...recipes.recipes.map(r => option(r.id, r.name))); fillSettings(settingsDraft); setSettingsTab(tab); $('settings-status').textContent = value.warning || ''; $('settings-dialog').showModal(); }
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
  try { const oldPolicy = state.settings.rawRendering; syncSettings(await api.settings(settingsPatch(settingsBase, readSettings()))); if (oldPolicy !== state.settings.rawRendering) refreshPreviews(); $('settings-dialog').close(); }
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
void api.settings().then(value => {
  syncSettings(value);
  if (updater) setTimeout(() => {
    if (state.settings.autoCheckUpdates !== false) void updater.check(false);
  }, 4000);
}).catch(error => toast(error.message));

// Browser mode lets smoke tests open a folder without a native dialog.
if (api.platform === 'web') window.loadTestFolder = async (folder, recursive) => loadSession(await api.openPath(folder, recursive));
if (api.server) void window.PhotoCullServer.attach(loadSession, () => state.session);
render();

$('handoff-folder-choose').onclick = async () => { try { const folder=await api.pickFolder('Choose a local hand-off folder'); if(folder){await api.developFolderCheck(folder); $('handoff-folder').value=folder;} } catch(e){toast(e.message);} };

function toggleOriginal() { state.showOriginal=!state.showOriginal; refreshPreviews(); }
$('original-toggle').onclick = toggleOriginal;

$('detail-result-reveal').onclick = () => { if(photo())void api.revealDevelop(state.session.id,photo().id).catch(e=>toast(e.message)); };
$('detail-result-edit').onclick = async () => { $('detail-result-edit').disabled=true;try{await developView.reedit();}catch(e){toast(e.message);}finally{$('detail-result-edit').disabled=false;} };

// External editor preferences and shared actions (all selection views).
function editorName(id) { return state.settings.editors?.find(e=>e.id===id)?.name || (id==='dehancer' ? 'Dehancer' : 'External editor'); }
function renderEditorActions() {
  const editor = state.settings.editors?.find(e=>e.id===state.settings.defaultEditor), busy = workspaceBusy();
  $('edit-external').textContent = editor ? `Edit in ${editor.name}…` : 'Edit in…';
  $('edit-external').disabled = busy || !state.session || !selection().some(i=>i.raw && !i.trashed);
  developView.batchButton.textContent = $('edit-external').textContent;developView.batchButton.disabled=$('edit-external').disabled;
  const menu = $('external-editor-list'), signature = JSON.stringify(state.settings.editors?.map(e=>[e.id,e.name]));
  if(menu.dataset.editors!==signature){menu.dataset.editors=signature;menu.replaceChildren(...(state.settings.editors || []).map(e=>{const item=menuItem(`Edit in ${e.name}…`,()=>developView.openBatch(e.id));item.dataset.editor=e.id;return item;}),menuSeparator(),menuItem('Configure editors…',()=>openSettings('editors'),'configure-editors'));}
  for(const item of menu.querySelectorAll('[data-editor]'))item.disabled=$('edit-external').disabled;
  if($('treat-card'))$('treat-card').disabled=!canTreatCard();
  $('handoff-cleanup').disabled = !state.session || busy;
  const usageKey = state.session ? `${state.session.id}:${state.session.items.map(i=>i.developRevision || 0).join(',')}` : '';
  if(usageKey!==handoffUsageKey){handoffUsageKey=usageKey;const generation=++handoffUsageGeneration;$('handoff-usage').textContent='';if(state.session)void api.handoffUsage(state.session.id).then(u=>{if(generation===handoffUsageGeneration)$('handoff-usage').textContent=`Hand-off files: ${u.count} · ${fileSize(u.bytes)}`;}).catch(e=>toast(e.message));}
}
$('edit-external').onclick=()=>{void developView.openBatch().catch(e=>toast(e.message));};
// Menu buttons. A menu owns every key while it has focus, so letters never reach photo shortcuts.
function menuItem(text,run,id) {const el=document.createElement('button');el.type='button';el.className='menu-item';el.setAttribute('role','menuitem');el.tabIndex=-1;el.textContent=text;if(id)el.id=id;el.onclick=()=>Promise.resolve().then(run).catch(e=>toast(e.message));return el;}
function menuSeparator() {const el=document.createElement('div');el.className='menu-separator';el.setAttribute('role','separator');return el;}
function closeMenus(except) {for(const m of menus)if(m!==except&&!m.menu.hidden){m.menu.hidden=true;m.button.setAttribute('aria-expanded','false');}}
function bindMenu(button,menu) {
  const entry={button,menu};menus.push(entry);
  const items=()=>[...menu.querySelectorAll('[role=menuitem]:not(:disabled)')];
  const open=index=>{if(button.disabled)return;closeMenus(entry);menu.hidden=false;button.setAttribute('aria-expanded','true');const list=items();(list[(index+list.length)%list.length]||menu).focus();};
  const close=()=>{menu.hidden=true;button.setAttribute('aria-expanded','false');button.focus();};
  menu.tabIndex=-1;
  button.onclick=()=>menu.hidden?open(0):close();
  button.addEventListener('keydown',e=>{if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();e.stopPropagation();open(e.key==='ArrowUp'?-1:0);}});
  // Runs before the item's own handler, so a dialog it opens returns focus to the trigger.
  menu.addEventListener('click',e=>{const item=e.target.closest('[role=menuitem]');if(item&&!item.disabled)close();},true);
  menu.addEventListener('keydown',e=>{
    e.stopPropagation();
    const list=items(),index=list.indexOf(document.activeElement);
    if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();list[e.key==='Home'?0:e.key==='End'?list.length-1:(index+(e.key==='ArrowDown'?1:-1)+list.length)%list.length]?.focus();}
    else if(e.key==='Escape'){e.preventDefault();close();}
    else if(e.key==='Tab')closeMenus();
    else if(e.key.length===1&&e.key!==' '&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();const key=e.key.toLowerCase(),order=[...list.slice(index+1),...list.slice(0,index+1)];order.find(item=>item.textContent.trim().toLowerCase().startsWith(key))?.focus();}
    else if(e.key!=='Enter'&&e.key!==' ')e.preventDefault();
  });
}
document.addEventListener('pointerdown',e=>{for(const m of menus)if(!m.menu.hidden&&!m.menu.contains(e.target)&&!m.button.contains(e.target))closeMenus();});
bindMenu($('external-editor-menu'),$('external-editor-list'));
bindMenu($('develop-recipe-menu-button'),$('develop-recipe-menu'));
$('handoff-cleanup').onclick=async()=>{
  if (workspaceBusy()) return;
  setBusy(true);
  try {
    const session=state.session.id, usage=await api.handoffUsage(session);
    if(!usage.count)return toast(usage.failures.length ? usage.failures.map(f=>f.error).join(' · ') : 'No hand-off files to clean up.');
    if(await developView.ask(`Delete ${usage.count} hand-off file(s), ${fileSize(usage.bytes)}?\n${usage.entries.map(r=>r.path).join('\n')}`, [['delete','Delete hand-off files'],['cancel','Cancel']])!=='delete')return;
    if(usage.unexported && await developView.ask(`${usage.unexported} external edit(s) have not been exported. Deleting these hand-off files permanently loses those edits.`,[['delete','Delete unexported edits'],['cancel','Keep files']])!=='delete')return;
    const result=await api.handoffClean(session,usage.token,!!usage.unexported);
    developView.host.updateItems(session,result.items);handoffUsageKey='';render();
    toast(`${result.deleted.length} hand-off file(s) deleted${result.failures.length ? ' · '+result.failures.map(f=>f.error).join(' · ') : ''}`);
  } catch(e){toast(e.message);}
  finally { setBusy(false); }
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
  for(const command of commands.commands.filter(offered)){host.append(workspaceNode('span',command.title),workspaceNode('kbd',shortcutLabel(command)));}
  if(!$('help-dialog').open)$('help-dialog').showModal();
}
const helpActions=workspaceNode('div',null,{class:'copy-actions'});
for(const [text,id] of [['About PhotoCull','about'],['Command palette','palette'],['Welcome','welcome'],['Copy diagnostics','diagnostics'],['Open log folder','logs']].filter(([,id])=>offered({id,context:['review']})))helpActions.append(workspaceButton(text,()=>{$('help-dialog').close();commands.execute(id);}));
$('help-dialog').prepend(helpActions);$('help-dialog').querySelector('h2').textContent='Help & shortcuts';
const palette=workspaceNode('dialog',null,{id:'command-palette','aria-label':'Command palette'});
palette.innerHTML='<button type="button" id="command-close" class="close-dialog" aria-label="Close">×</button><label for="command-query">Command palette · type > to find a photo</label><input id="command-query" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="command-results" autocomplete="off" placeholder="Search commands or > photo name"><div id="command-results" role="listbox" aria-label="Commands"></div><p id="command-count" class="subtle small" role="status"></p>';
document.body.append(palette);$('command-close').onclick=()=>palette.close();
let paletteRows=[],paletteIndex=0,paletteFocus;
function openPalette(query='') {if(document.querySelector('dialog[open]'))return;paletteFocus=document.activeElement;palette.showModal();$('command-query').value=query;paletteIndex=0;drawPalette();$('command-query').focus();}
function drawPalette() {
  const query=$('command-query').value,findPhoto=query.startsWith('>');
  paletteRows=findPhoto?(state.session?.items||[]).filter(item=>!item.trashed&&PhotoCullCommands.fuzzy(query.slice(1),item.name)).slice(0,60).map(item=>({id:'photo-'+item.id,title:item.name,category:'Photo',run:()=>{clearFilters();state.selected=item.id;resetSelection();render(true);}})):
    [...commands.search(query,recentCommands).filter(offered).map(command=>({...command,disabled:!PhotoCullCommands.active(command,commandContext())||!command.enabled(),run:()=>commands.execute(command.id)})),
     ...(api.server?[]:state.settings.editors||[]).map(e=>({id:'edit-with-'+e.id,title:`Edit in ${e.name}…`,category:'Files',disabled:$('edit-external').disabled,run:()=>developView.openBatch(e.id)})).filter(row=>PhotoCullCommands.fuzzy(query,row.title+' '+row.category)>0)].slice(0,60);
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
  for(const command of commands.commands.filter(offered).sort((a,b)=>a.category.localeCompare(b.category)||a.title.localeCompare(b.title))){
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
const cardSettings=workspaceNode('section',null,{class:'desktop-only'});cardSettings.innerHTML='<h3>Camera cards & backup</h3><label>Camera folder layouts (one relative path per line)<textarea id="card-folders" rows="3" placeholder="DCIM&#10;PRIVATE/M4ROOT"></textarea></label><label>Folders treated as cards (one absolute path per line)<textarea id="manual-cards" rows="3"></textarea></label><label>Default backup folder template<input id="backup-template" placeholder="{date}-{card}"></label><p class="subtle small">Backup tokens: {date}, {card}, {year}, {month}, {day}. Copy naming is in File naming; finished-image naming is saved in export presets.</p>';
$('settings-dialog').querySelector('[data-settings-page="general"]').append(cardSettings);
const syncTab=workspaceButton('Import / export',()=>setSettingsTab('sync'));syncTab.dataset.settingsTab='sync';syncTab.classList.add('desktop-only');$('settings-dialog').querySelector('nav').append(syncTab);
const syncPage=workspaceNode('section',null,{'data-settings-page':'sync',hidden:''});syncPage.innerHTML='<h3>Move settings between computers</h3><p>Bundles include preferences, user recipes, metadata and export presets, external editors and shortcuts. Import replaces these settings after saving a full backup.</p><label class="toggle-row"><input id="bundle-exclude-paths" type="checkbox" checked> Exclude machine-specific paths on export</label><div class="copy-actions"><button id="bundle-export" class="button quiet">Export settings…</button><label class="button quiet">Choose settings JSON<input id="bundle-file" type="file" accept=".json,application/json"></label></div><label>Path mappings (JSON object, old prefix → new prefix)<textarea id="bundle-path-map" rows="3">{}</textarea></label><button id="bundle-preview" class="button quiet">Preview import</button><pre id="bundle-changes" role="status"></pre><button id="bundle-apply" class="button primary" disabled>Back up current settings & import</button>';
$('settings-status').before(syncPage);
let bundleInput=null,bundleToken=null;
const clearBundlePreview=()=>{bundleToken=null;$('bundle-apply').disabled=true;};
$('bundle-file').onchange=async()=>{clearBundlePreview();try{const file=$('bundle-file').files[0];if(!file||file.size>4*1024*1024)throw new Error('Choose a settings JSON smaller than 4 MB.');bundleInput=JSON.parse(await file.text());$('bundle-changes').textContent='File loaded. Preview to validate.';}catch(e){bundleInput=null;$('bundle-changes').textContent=e.message;}};
$('bundle-path-map').oninput=clearBundlePreview;
$('bundle-export').onclick=async()=>{try{const file=await api.bundleExport({excludePaths:$('bundle-exclude-paths').checked});$('bundle-changes').textContent=file?`Saved ${file}`:'Export canceled.';}catch(e){$('bundle-changes').textContent=e.message;}};
$('bundle-preview').onclick=async()=>{clearBundlePreview();try{const result=await api.bundlePreview(bundleInput,{pathMap:JSON.parse($('bundle-path-map').value)});bundleToken=result.token;$('bundle-changes').textContent=`Preferences changed: ${result.changes.join(', ')||'none'}\nUser recipes: ${result.recipes.before} → ${result.recipes.after}\nMetadata presets: ${result.presets.before} → ${result.presets.after}\n${result.warnings.join('\n')}\n\nPreference values (before / after):\n${JSON.stringify(result.details,null,2)}\nRecipe changes: ${JSON.stringify(result.recipeChanges)}\nPreset changes: ${JSON.stringify(result.presetChanges)}`;$('bundle-apply').disabled=false;}catch(e){$('bundle-changes').textContent=e.message;}};
$('bundle-apply').onclick=async()=>{if(!bundleToken)return;$('bundle-apply').disabled=true;try{const result=await api.bundleApply(bundleToken);syncSettings(result.settings);settingsDraft=clone(result.settings);settingsBase=clone(result.settings);const recipes=await api.recipes();$('default-recipe').replaceChildren(...recipes.recipes.map(r=>option(r.id,r.name)));fillSettings(settingsDraft);$('bundle-changes').textContent=`Imported. Previous settings backed up to ${result.backup}`;clearBundlePreview();}catch(e){$('bundle-changes').textContent=e.message;}};
// Defaults for the next tethered session; a running shoot keeps its own copy in its ledger.
const tetherTab=workspaceButton('Tether',()=>setSettingsTab('tether'));tetherTab.dataset.settingsTab='tether';$('settings-dialog').querySelector('nav').append(tetherTab);
const tetherPage=workspaceNode('section',null,{'data-settings-page':'tether',hidden:''});
tetherPage.innerHTML='<h3>Tethered capture</h3><p id="settings-tether-note" class="subtle small">These defaults apply to the next tethered session. The Tether workspace edits the running shoot.</p>'
  +'<div class="field-row"><label for="settings-tether-layout">Capture folder</label><select id="settings-tether-layout"><option value="single">Single folder</option><option value="session">Session layout (Capture, Selects, Output)</option></select></div>'
  +'<div class="field-row"><label for="settings-tether-naming">File name</label><input id="settings-tether-naming" maxlength="180" spellcheck="false" aria-describedby="settings-tether-naming-sample"></div><p id="settings-tether-naming-sample" class="subtle small tabular"></p>'
  +'<div class="field-row"><label for="settings-tether-counter-start">Counter starts at</label><input id="settings-tether-counter-start" type="number" min="0" max="999999999" step="1" class="tabular"></div>'
  +'<div class="field-row"><label for="settings-tether-counter-step">Counter step</label><input id="settings-tether-counter-step" type="number" min="-1000" max="1000" step="1" class="tabular"></div>'
  +'<div class="field-row"><label for="settings-tether-adjustments">Next capture adjustments</label><select id="settings-tether-adjustments"><option value="last">Copy from last capture</option><option value="primary">Copy from Primary</option><option value="default">Default recipe</option><option value="recipe">Recipe</option></select></div>'
  +'<div class="field-row"><label for="settings-tether-follow">Show new captures</label><select id="settings-tether-follow"><option value="whenReady">When Ready</option><option value="immediately">Immediately</option><option value="off">Off</option></select></div>'
  +'<label class="toggle-row"><input id="settings-tether-autopause" type="checkbox"> Pause following while zoomed in or comparing</label>'
  +'<label class="toggle-row"><input id="settings-tether-chime" type="checkbox"> Play a sound when a capture arrives</label>'
  +'<label class="toggle-row"><input id="settings-tether-reconnect" type="checkbox"> Reconnect automatically when the camera returns</label>'
  +'<label class="toggle-row"><input id="settings-tether-backfill" type="checkbox"> Auto-pull missed frames from the camera card on reconnect</label>';
$('settings-status').before(tetherPage);
$('settings-tether-naming').oninput=()=>{const value=$('settings-tether-naming').value,check=PhotoCullNaming.validateCaptureTemplate(value);$('settings-tether-naming').setAttribute('aria-invalid',String(!check.valid));
  $('settings-tether-naming-sample').textContent=check.valid?'Sample '+PhotoCullNaming.renderCaptureName(value,{jobName:state.session?.folder.split(/[\\/]/).filter(Boolean).pop()||'Capture',counter:Number($('settings-tether-counter-start').value)||1,extensions:['.ARW','.JPG']},{preview:true}).filenames.join(' + '):check.error;};
function fillTetherSettings(value) {
  const t=value.tether||{},usable=t.version===1;
  for(const input of tetherPage.querySelectorAll('input, select'))input.disabled=!usable;
  $('settings-tether-note').textContent=usable?'These defaults apply to the next tethered session. The Tether workspace edits the running shoot.':'These tether settings were saved by a newer PhotoCull and are left unchanged.';
  if(!usable)return;
  $('settings-tether-layout').value=t.layout;$('settings-tether-naming').value=t.namingTemplate;$('settings-tether-counter-start').value=t.counterStart;$('settings-tether-counter-step').value=t.counterStep;
  $('settings-tether-adjustments').value=t.adjustments.mode;$('settings-tether-follow').value=t.follow.mode;$('settings-tether-autopause').checked=t.follow.pauseOnInspect;$('settings-tether-chime').checked=t.chime;$('settings-tether-reconnect').checked=t.autoReconnect;$('settings-tether-backfill').checked=t.autoBackfill!==false;
  $('settings-tether-naming').oninput();
}
function readTetherSettings(value) {
  if(value.tether?.version!==1)return;
  const t=value.tether;t.layout=$('settings-tether-layout').value;t.namingTemplate=$('settings-tether-naming').value;
  t.counterStart=Math.round(Number($('settings-tether-counter-start').value));t.counterStep=Math.round(Number($('settings-tether-counter-step').value));
  t.adjustments={...t.adjustments,mode:$('settings-tether-adjustments').value};t.follow={...t.follow,mode:$('settings-tether-follow').value,pauseOnInspect:$('settings-tether-autopause').checked};
  t.chime=$('settings-tether-chime').checked;t.autoReconnect=$('settings-tether-reconnect').checked;t.autoBackfill=$('settings-tether-backfill').checked;
}
function fillWorkspaceSettings(value) {drawKeyboard();fillTetherSettings(value);$('card-folders').value=(value.cardFolders||['DCIM']).join('\n');$('manual-cards').value=(value.manualCards||[]).join('\n');$('backup-template').value=value.backupTemplate||'{date}-{card}';}
function readWorkspaceSettings(value) {readTetherSettings(value);value.cardFolders=$('card-folders').value.split('\n').map(s=>s.trim()).filter(Boolean);value.manualCards=$('manual-cards').value.split('\n').map(s=>s.trim()).filter(Boolean);value.backupTemplate=$('backup-template').value.trim();}
const welcome=workspaceNode('dialog',null,{id:'welcome-panel','aria-labelledby':'welcome-title',hidden:''});
welcome.innerHTML='<h2 id="welcome-title">Welcome to PhotoCull</h2><p>Open a photo folder or choose a connected camera card in the sidebar.</p><div id="welcome-keys" class="shortcut-list"></div><div id="welcome-actions" class="copy-actions"></div>';
document.body.append(welcome);
function showWelcome() {for(const open of document.querySelectorAll('dialog[open]'))if(open!==welcome)open.close();welcome.hidden=false;if(!welcome.open)welcome.showModal();$('welcome-keys').replaceChildren();for(const id of ['open','navigate-right','flag-pick','flag-reject','rating-5','zoom-toggle','view-grid','palette']){const c=commands.commands.find(c=>c.id===id);$('welcome-keys').append(workspaceNode('span',c.title),workspaceNode('kbd',shortcutLabel(c)));}}
function settleWelcome(autoOpen) {
  welcomeSettled=true;
  // Covers cards discovered after this choice as well: the user picked another path for this launch.
  if(!autoOpen)autoOpenSuppressed=true;
  receiveDevices({devices:state.devices,error:state.deviceError});
}
async function dismissWelcome(autoOpen=true){welcome.hidden=true;if(welcome.open)welcome.close();state.settings=await api.settings({welcomeDismissed:true});settleWelcome(autoOpen);}
// Shows the Sources pane in both the docked and the narrow overlay layout.
function revealSources() {
  if(matchMedia('(max-width: 900px)').matches)document.body.classList.add('mobile-sources');
  else if(!layoutPrefs.sources){layoutPrefs.sources=true;storeLayout();}
  applyPaneLayout();
}
async function chooseCard() {
  const cameras=state.devices.filter(d=>d.camera);
  revealSources();
  if(cameras.length===1)return openDevice(cameras[0]);
  if(!cameras.length)toast('No camera card found. Insert a card, or use Open folder… for a copied card.');
  if(!state.devices.length)return;
  $('devices-panel').scrollIntoView({block:'nearest'});$('device-list').querySelector('button')?.focus();
}
welcome.addEventListener('cancel',e=>{e.preventDefault();void dismissWelcome(true).catch(error=>toast(error.message));});
$('welcome-actions').append(workspaceButton('Skip',()=>dismissWelcome(true),'welcome-skip'),workspaceButton('Choose camera card',async()=>{await dismissWelcome(false);await chooseCard();},'welcome-card'),workspaceButton('Set up an external editor',async()=>{await dismissWelcome(false);await openSettings('editors');},'welcome-editor'),workspaceButton('Open folder…',async()=>{await dismissWelcome(false);await openFolder();},'welcome-open'));
$('welcome-open').className='button primary';$('welcome-open').autofocus=true;
$('welcome-card').classList.add('desktop-only');$('welcome-editor').classList.add('desktop-only');
if(api.server)welcome.querySelector('p').textContent='Open a photo folder to start culling.';
void Promise.all([api.workspaceInfo(),api.settings()]).then(([info,settings])=>{if(info.welcome&&!settings.welcomeDismissed&&!api.server)showWelcome();else settleWelcome(true);}).catch(error=>{settleWelcome(true);toast(error.message);});
async function copyDiagnostics() {
  const color=await api.displayColor().catch(()=>({mode:'unavailable'}));let gpu='unavailable';
  try{const gl=document.createElement('canvas').getContext('webgl'),ext=gl?.getExtension('WEBGL_debug_renderer_info');if(ext)gpu=gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);}catch{}
  const text=await api.diagnostics({webview:navigator.userAgent,display:{width:screen.width,height:screen.height,pixelRatio:devicePixelRatio,colorDepth:screen.colorDepth,p3:matchMedia('(color-gamut: p3)').matches,color},gpu});
  try{await navigator.clipboard.writeText(text);toast('Diagnostics copied.');}catch{const dialog=workspaceNode('dialog',null,{'aria-label':'Copy diagnostics'}),area=workspaceNode('textarea',text,{rows:'18',cols:'70','aria-label':'Diagnostics'});dialog.append(area,workspaceButton('Close',()=>{dialog.close();dialog.remove();}));document.body.append(dialog);dialog.showModal();area.focus();area.select();}
}
const backupDialog=workspaceNode('dialog',null,{id:'backup-dialog','aria-labelledby':'backup-title'});
backupDialog.innerHTML='<div class="dialog-header"><h2 id="backup-title">Back up card or folder</h2></div><p class="dialog-lead">Copies every regular file, including videos and sidecars. Each file is verified with SHA-256. Existing identical copies are verified and skipped. Source files are never formatted or deleted.</p><div class="field-row"><label for="backup-source">Source folder</label><input id="backup-source" readonly><button id="backup-source-choose" class="button">Choose…</button></div><div class="field-row"><label for="backup-destination">Destination</label><input id="backup-destination" readonly placeholder="Choose a backup drive or folder"><button id="backup-destination-choose" class="button">Choose…</button></div><div class="field-row"><label for="backup-folder-template">Folder template</label><input id="backup-folder-template"></div><div class="copy-actions dialog-actions"><button id="backup-check" class="button quiet">Check verified backup</button><button id="backup-cancel" class="button quiet" hidden>Cancel backup</button><button id="backup-close" class="button">Close</button><button id="backup-start" class="button primary">Back up & verify</button></div><progress id="backup-progress" max="1" value="0" hidden></progress><p id="backup-status" role="status" aria-live="polite"></p><pre id="backup-failures"></pre>';
document.body.append(backupDialog);let backupRunning=false;const cardStatuses=new Map();
function openBackup(source=state.session?.deviceRoot||state.session?.folder||'') {if(state.busy || document.querySelector('dialog[open]'))return;$('backup-source').value=source;$('backup-folder-template').value=state.settings.backupTemplate||'{date}-{card}';$('backup-status').textContent='';$('backup-failures').textContent='';backupDialog.showModal();}
$('backup-source-choose').onclick=async()=>{const folder=await api.pickFolder('Choose a card or folder to back up');if(folder)$('backup-source').value=folder;};
$('backup-destination-choose').onclick=async()=>{const folder=await api.chooseCopyDestination();if(folder)$('backup-destination').value=folder;};
function backupStatusText(status) {return status.safe?`All ${status.total} files backed up and verified — safe to format`:`${status.verified||0} of ${status.total} files verified · ${status.missing.length} file(s) need backup or verification`;}
function showBackupProgress(progress) {$('backup-progress').hidden=false;$('backup-progress').max=progress.total||1;$('backup-progress').value=progress.completed;$('backup-status').textContent=progress.status?backupStatusText(progress.status):`${progress.state} · ${progress.completed}/${progress.total} · ${progress.verified} verified · ${progress.skipped} identical · ${progress.file}`;$('backup-failures').textContent=[...(progress.failures||[]),...(progress.status?.missing||[])].map(f=>`${f.name}: ${f.reason}`).join('\n');}
function setBackupBusy(value){backupRunning=value;state.busy=value;for(const id of ['backup-start','backup-check','backup-source-choose','backup-destination-choose','backup-folder-template','backup-close'])$(id).disabled=value;$('backup-cancel').hidden=!value;renderDevices();}
api.onBackupProgress(progress=>{if(backupRunning)showBackupProgress(progress);});
$('backup-start').onclick=async()=>{setBackupBusy(true);try{const source=$('backup-source').value,result=await api.backupStart(source,$('backup-destination').value,{template:$('backup-folder-template').value});showBackupProgress(result);if(result.status)cardStatuses.set(source,result.status);else cardStatuses.delete(source);}catch(e){$('backup-status').textContent=e.message;}finally{setBackupBusy(false);}};
$('backup-check').onclick=async()=>{setBackupBusy(true);$('backup-status').textContent='Checking every source and destination hash…';try{const source=$('backup-source').value,status=await api.backupStatus(source);cardStatuses.set(source,status);$('backup-status').textContent=backupStatusText(status);$('backup-failures').textContent=status.missing.map(f=>`${f.name}: ${f.reason}`).join('\n');}catch(e){$('backup-status').textContent=e.message;cardStatuses.set($('backup-source').value,{safe:false,total:0,verified:0,missing:[{name:'Card',reason:e.message}]});}finally{setBackupBusy(false);}};
$('backup-cancel').onclick=()=>api.backupCancel();$('backup-close').onclick=()=>backupDialog.close();backupDialog.addEventListener('cancel',e=>{if(backupRunning)e.preventDefault();});
function canTreatCard() {return !!state.session&&!state.session.removable;}
async function treatCard(){if(!state.session)return toast('Open a folder first.');if(!canTreatCard())return toast('This session is already a camera card.');receiveDevices(await api.manualCard(state.session.folder));state.session.removable=true;renderEditorActions();toast('Folder is now treated as a camera card.');}
function deviceBackupRow(device){const row=workspaceNode('div',null,{class:'device-backup'}),status=cardStatuses.get(device.root) || device.backup;row.append(workspaceButton('Back up card…',()=>openBackup(device.root)));if(status){row.append(workspaceNode('p',backupStatusText(status),{class:status.safe?'backup-safe':'backup-pending'}));if(status.missing.length){const detail=workspaceNode('details');detail.append(workspaceNode('summary','Files needing backup'),workspaceNode('pre',status.missing.map(f=>`${f.name}: ${f.reason}`).join('\n')));row.append(detail);}}return row;}
// Add discoverable entry points alongside the existing folder controls.
$('source-menu').append(menuItem('Open folder…',openFolder),menuSeparator(),menuItem('Back up card or folder…',()=>openBackup(),'backup-open'),menuItem('Treat folder as card',treatCard,'treat-card'));
bindMenu($('source-menu-button'),$('source-menu'));
const verifyLabel=workspaceNode('label',null,{class:'toggle-row'});verifyLabel.innerHTML='<input id="copy-verify" type="checkbox"> Verify copied files (SHA-256)';$('copy-naming').before(verifyLabel);

$('copy-verify').onchange=()=>saveCopyDefaults();

async function cullingMetadata(id,session=state.session?.id) {
  if(!session)return null;
  if(culling.metadata.has(id))return culling.metadata.get(id);
  if(culling.jobs.has(id))return culling.jobs.get(id);
  const job=api.metadata(session,id,'preview').then(metadata=>{if(state.session?.id===session && culling.jobs.get(id)===job){culling.metadata.set(id,metadata);if(state.selected===id)applyFocus();}return metadata;}).finally(()=>{if(culling.jobs.get(id)===job)culling.jobs.delete(id);});
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
  else {if(!photoStage())setMode('review');loupe.view.set({mode:'ratio',percent:100},{centerOn:focus,animate:true});}
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
  const badge=document.createElement('span');badge.className='burst-badge';badge.textContent=`${culling.expanded.has(b.id)?'▾':'▸'} ${b.ids.length}`;badge.title='Burst · tap or S to expand or collapse';badge.setAttribute('role','button');badge.setAttribute('aria-label',`${culling.expanded.has(b.id)?'Collapse':'Expand'} burst of ${b.ids.length}`);
  badge.onclick=event=>{event.stopPropagation();toggleBurst(b);};
  if(bestIn(b)===item.id){const star=document.createElement('span');star.className='sharpest-badge';star.append('◆',Object.assign(document.createElement('span'),{className:'badge-label',textContent:' Sharpest'}));star.title='Highest preview sharpness in this burst';badgeRow(node,'top').append(star);}
  badgeRow(node,'top').append(badge);
}
function renderCulling() {
  const burst=culling.byId.get(state.selected),available=!!burst;
  $('burst-context').hidden=!available;$('burst-context').textContent=available?`${burst.ids.indexOf(state.selected)+1}/${burst.ids.length} in burst${bestIn(burst)===state.selected?' · sharpest':''}`:'';
  $('burst-stack').hidden=$('burst-keep').hidden=!available;
  $('burst-stack').textContent=available && culling.expanded.has(burst.id)?'Collapse burst':'Expand burst';
  $('burst-keep').disabled=testBlocksCulling() || !bestIn(burst) || state.busy || state.deleting || !!state.pendingSaves;
  burstMenu.stack.textContent=$('burst-stack').textContent;burstMenu.keep.disabled=$('burst-keep').disabled;
  applyFocus();
}
function toggleBurst(burst=culling.byId.get(state.selected)) {
  if(!burst)return toast('This photo is not part of a detected burst.');
  if(culling.expanded.has(burst.id))culling.expanded.delete(burst.id);else culling.expanded.add(burst.id);
  render();
}
function setPauseLabel(text) {$('analysis-pause').textContent=text;$('analysis-pause').dataset.action=text.split(' ')[0].toLowerCase();}
function setAnalysis(text,phase) {$('analysis-status').textContent=text;$('analysis-status').dataset.phase=phase;$('analysis-status').closest('.analysis').title=text;}
function cancelCulling() {culling.epoch++;culling.running=false;void api.cancelSharpness().catch(()=>{});}
function indexSessionMetadata(session, items) {
  if (metadataIndex?.session === session && (!metadataIndex.done || !metadataIndex.failures)) return metadataIndex.job;
  const run = { session, total: items.length, processed: 0, failures: 0, done: false };
  metadataIndex = run;
  run.job = (async () => {
    for (const item of items) {
      if (state.session !== session || metadataIndex !== run) break;
      try { await cullingMetadata(item.id, session.id); } catch { run.failures++; }
      if (state.session !== session || metadataIndex !== run) break;
      run.processed++;
      if (run.processed % 8 === 0 || run.processed === 1 || run.processed === run.total) {
        regroupBursts(); render();
        if (culling.running) setAnalysis(`Metadata ${run.processed}/${run.total}`, 'running');
      }
      await new Promise(resolve => setTimeout(resolve, 35));
    }
    run.done = true;
    if (metadataIndex === run) renderIndexStatus();
    return run.failures;
  })();
  return run.job;
}
async function analyzeCulling() {
  cancelCulling();culling.paused=false;culling.running=true;const epoch=culling.epoch,session=state.session?.id,items=[...(state.session?.items || [])];
  $('analysis-pause').hidden=!items.length || !!api.server;setPauseLabel('Pause analysis');
  const current=()=>epoch===culling.epoch && session===state.session?.id && !culling.paused;
  const yieldUI=()=>new Promise(resolve=>setTimeout(resolve,35));
  try {
    let failures = await indexSessionMetadata(state.session, items);
    if (!current()) return;
    if(api.canAnalyze) {
      const burstIds=new Set(culling.byId.keys()),order=[...items.filter(i=>burstIds.has(i.id)),...items.filter(i=>!burstIds.has(i.id))];
      for(const item of order) {
        if(!current())return;if(culling.scores.has(item.id))continue;
        try{const score=await api.sharpness(session,item.id);if(!current())return;if(Number.isFinite(score))culling.scores.set(item.id,score);}catch{if(current())failures++;}
        if(!current())return;
        setAnalysis(`Focus ${culling.scores.size}/${items.length}`,'running');render();await yieldUI();
      }
    }
    if(current()){setAnalysis(failures?`${failures} unavailable`:api.canAnalyze?'Focus ready':'Desktop scores',failures?'warn':'done');$('analysis-pause').hidden=!failures;setPauseLabel('Retry analysis');}
  }finally{if(epoch===culling.epoch)culling.running=false;}
}
function promptKeepSharpest() {
  if (guardStageCull()) return;
  const burst=culling.byId.get(state.selected),best=bestIn(burst);if(!best || state.busy || state.deleting || state.pendingSaves)return;
  burstPrompt={session:state.session.id,ids:[...burst.ids],best};
  const items=burst.ids.map(id=>state.session.items.find(i=>i.id===id)),changes=items.filter(i=>i.flag!==(i.id===best?'pick':'reject'));
  $('burst-summary').textContent=`Pick ${items.find(i=>i.id===best).name} and reject the other ${items.length-1} frame${items.length===2?'':'s'}. ${changes.length} flag${changes.length===1?'':'s'} will change.`;
  $('burst-changes').textContent=items.map(i=>`${i.name}: ${i.flag} → ${i.id===best?'pick':'reject'}`).join('\n');$('burst-dialog').showModal();
}
$('focus-toggle').onclick=()=>commands.execute('focus-overlay');$('compare-mode').onclick=()=>commands.execute('view-compare');
$('burst-stack').onclick=()=>commands.execute('burst-stack');$('burst-keep').onclick=()=>commands.execute('burst-keep');
$('analysis-pause').onclick=()=>{if(culling.running){cancelCulling();culling.paused=true;setAnalysis('Analysis paused','paused');setPauseLabel('Resume analysis');}else void analyzeCulling();};
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
const narrowLayout=()=>matchMedia('(max-width: 900px)').matches;
const inspectorShown=()=>narrowLayout()?document.body.classList.contains('mobile-details'):layoutPrefs.details;
tether=PhotoCullTether.create({api,toast,
  settings:()=>state.settings,saveSettings:async patch=>{state.settings=await api.settings(patch);return state.settings;},
  session:()=>state.session,mode:()=>state.mode,photo,item:id=>state.session?.items.find(i=>i.id===id),original:()=>state.showOriginal,imageUrl:(item,kind)=>imageUrl(item,kind),
  loadSession,applyDelta:applyTetherDelta,replaceLibrary:replaceTetherLibrary,survey:()=>survey,flushDevelop:()=>developView.flush(),
  visible:id=>filtered().some(i=>i.id===id),
  showAll:()=>{clearFilters();render();},
  show:(id,{review=false}={})=>{if(review && !['review','compare','tether'].includes(state.mode))setMode(stageMode());select(id);},
  activate:id=>{if(state.selected!==id){state.selected=id;resetSelection();renderSelection();}},
  inspecting:()=>photoStage() && loupe.zoomed || state.mode==='compare' && !survey.pinned(),
  blocked:()=>!!deletePrompt || !!document.querySelector('dialog[open]') || state.busy || state.deleting,
  pin:id=>{if(!survey.pinReference(id))return false;if(state.fullscreen)void setFullscreen(false);loupe.cancelHand();state.generation++;state.mode='compare';render();return true;},
  unpin:()=>{survey.unpin();if(state.mode==='compare'){state.mode=stageMode();render();}tether.render();},
  studio:()=>state.studio,enterStudio:()=>{if(!state.studio)setMode('tether');},
  revealDock:()=>{if(narrowLayout()?!document.body.classList.contains('mobile-sources'):!layoutPrefs.dock)togglePane('sources');},inspectorVisible:inspectorShown,
  reviewView:loupe.view,reviewViewport:$('image-viewport'),stageChanged:()=>{loupe.cancelHand();render();},
  updateItems:(session,items)=>developView.host.updateItems(session,items),thumbnailsChanged:()=>render(),
  showTestShot:frame=>{
    const old=state.testShot;
    if(frame && deletePrompt)hideDeletePrompt();
    if(frame && old?.url===frame.url){old.meta=frame.meta;render();return;}
    if(old){loupe.reps.delete(old.item.id);loupe.dims.delete(old.item.id);}
    state.testShot=frame?{...frame,item:{id:`tether-test-${frame.seq}`,name:'Test shot',raw:false,testShot:true,url:frame.url}}:null;
    if(old && loupe.item?.id===old.item.id)$('review-image').dataset.stamp='';
    loupe.cancelHand();render();},
  displayedReview:()=>loupe.item?.id===photo()?.id && loupe.shown ? { image:loupe.el.image, rep:loupe.shown } : null,
  showDeveloped:(id,frame)=>{const item=photo();return photoStage() && item?.id===id && loupe.develop(item,frame);},
  undevelop:id=>{if(loupe.undevelop(id) && photoStage() && photo()?.id===id)loupe.show(photo());},
  developedStamp:id=>loupe.developedStamp(id)});
Object.assign(survey.host,{
  unpinned:message=>{toast(message);queueMicrotask(()=>{if(state.mode==='compare' && !survey.pinned()){state.mode=stageMode();render();}tether.render();});},
  unpin:()=>{survey.unpin();if(state.mode==='compare'){state.mode=stageMode();render();}tether.render();},
  replaceReference:()=>{const id=state.selected;if(id && id!==survey.pinned()?.reference && survey.pinReference(id)){render();tether.render();}},
  candidateChosen:()=>tether.navigated(),
});
window.addEventListener('pagehide',cancelCulling);
