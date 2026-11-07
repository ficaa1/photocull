// Server mode only: a folder browser over the server's photo folders, the
// background Prepare indicator, and returning a reloaded page to its folder.
(() => {
  const api = window.photocull, server = api.server;
  document.documentElement.classList.add('server-mode');
  // iPhone Safari cannot make a page fullscreen.
  if (!document.fullscreenEnabled) document.documentElement.classList.add('no-fullscreen');
  const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children.filter(c => c !== null && c !== undefined)); return node; };
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const jobs = new Map();
  const toast = message => { const node = document.getElementById('toast'); node.textContent = message; node.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.hidden = true; }, 5500); };

  function jobLabel(job) {
    if (!job) return '';
    if (job.state === 'queued') return 'Queued';
    if (job.state === 'running') return job.thumbs < job.total ? `Thumbnails ${job.thumbs}/${job.total}` : `Focus ${job.ready}/${job.total}`;
    if (job.state === 'done') return job.failed ? `Ready · ${job.failed} failed` : 'Ready';
    return job.state === 'cancelled' ? 'Stopped' : 'Failed';
  }

  // Folder browser.
  const dialog = el('dialog', { id: 'folder-browser', className: 'folder-browser' });
  const title = el('h2'), crumbs = el('nav', { className: 'folder-crumbs', ariaLabel: 'Folder path' });
  const list = el('ul', { className: 'folder-list' }), summary = el('span', { className: 'folder-summary' });
  const cancel = el('button', { type: 'button', className: 'button quiet', textContent: 'Cancel' });
  const prepare = el('button', { type: 'button', className: 'button quiet', textContent: 'Prepare in background', title: 'Make previews and focus scores now, without opening the folder' });
  const choose = el('button', { type: 'button', className: 'button primary' });
  // Include subfolders belongs to this browser and to the folder being opened, so it lives here.
  const RECURSIVE_KEY = 'photocull-recursive';
  const recursive = el('input', { type: 'checkbox', checked: localStorage.getItem(RECURSIVE_KEY) === '1',
    onchange: () => { try { localStorage.setItem(RECURSIVE_KEY, recursive.checked ? '1' : '0'); } catch {} } });
  const recursiveRow = el('label', { className: 'folder-recursive' }, recursive, ' Include subfolders');
  dialog.append(el('header', {}, title, el('button', { type: 'button', className: 'folder-close', ariaLabel: 'Close', textContent: '×', onclick: () => dialog.close('') })),
    crumbs, list, el('footer', {}, summary, recursiveRow, el('div', { className: 'folder-actions' }, cancel, prepare, choose)));
  document.body.append(dialog);
  let current = null, mode = 'open', resolvePick = null;
  cancel.onclick = () => dialog.close('');
  dialog.addEventListener('close', () => { const done = resolvePick; resolvePick = null; done?.(dialog.returnValue || null); });

  // Every folder row and the footer carry a badge slot, updated in place as jobs progress.
  const jobFor = folder => [...jobs.values()].filter(j => j.folder === folder).at(-1);
  const badge = folder => { const node = el('span', { className: 'folder-badge', hidden: true }); node.dataset.folder = folder; return node; };
  function paintBadges() {
    for (const node of dialog.querySelectorAll('[data-folder]')) {
      const job = jobFor(node.dataset.folder);
      node.hidden = !job; node.className = `folder-badge ${job?.state || ''}`; node.textContent = jobLabel(job);
    }
  }
  async function show(folder) {
    list.replaceChildren(el('li', { className: 'folder-empty', textContent: 'Loading…' }));
    let view;
    try { view = await server.browse(folder); } catch (error) { list.replaceChildren(el('li', { className: 'folder-empty', textContent: error.message })); return; }
    current = view;
    crumbs.replaceChildren(el('button', { type: 'button', textContent: 'Library', onclick: () => show(null) }),
      ...view.crumbs.flatMap(c => [el('span', { textContent: '›', ariaHidden: 'true' }), el('button', { type: 'button', textContent: c.name, onclick: () => show(c.path) })]));
    const rows = view.folders.map(f => el('li', {}, el('button', { type: 'button', className: 'folder-row', onclick: () => show(f.path) },
      el('span', { className: 'folder-name', textContent: f.name }),
      el('span', { className: 'folder-meta' }, badge(f.path), f.photos ? el('span', { textContent: plural(f.photos, 'photo') }) : f.subfolders ? el('span', { textContent: plural(f.subfolders, 'folder') }) : null),
      el('span', { className: 'folder-chevron', textContent: '›', ariaHidden: 'true' }))));
    list.replaceChildren(...(rows.length ? rows : [el('li', { className: 'folder-empty', textContent: 'No subfolders' })]));
    list.scrollTop = 0;
    summary.textContent = view.path ? (view.photos ? `${plural(view.photos, 'photo')} here` : 'No photos directly in this folder') : 'Choose a folder';
    summary.replaceChildren(summary.textContent, view.path ? badge(view.path) : '');
    choose.disabled = prepare.disabled = !view.path;
    paintBadges();
  }
  choose.onclick = () => { if (current?.path) dialog.close(current.path); };
  prepare.onclick = async () => {
    if (!current?.path) return;
    prepare.disabled = true;
    try {
      await server.prepareFolder(current.path, recursive.checked);
      toast(`Preparing ${current.name} in the background.`);
    } catch (error) { toast(error.message); }
    prepare.disabled = false;
  };
  let lastFolder = null;
  window.PhotoCullServer = {
    get recursive() { return recursive.checked; },
    pickFolder(heading) {
      mode = /copy/i.test(heading) ? 'copy' : 'open';
      title.textContent = mode === 'copy' ? 'Copy picks to' : 'Open a folder';
      choose.textContent = mode === 'copy' ? 'Copy here' : 'Open';
      prepare.hidden = recursiveRow.hidden = mode === 'copy';
      dialog.returnValue = '';
      resolvePick?.(null);
      const picked = new Promise(resolve => { resolvePick = resolve; });
      dialog.showModal();
      void show(lastFolder && mode === 'open' ? parentOf(lastFolder) : server.info.roots.length === 1 ? server.info.roots[0].path : null);
      return picked.then(folder => { if (folder && mode === 'open') lastFolder = folder; return folder; });
    },
  };
  const parentOf = folder => {
    const root = server.info.roots.find(r => folder === r.path || folder.startsWith(r.path + '/'));
    return !root || folder === root.path ? root?.path ?? null : folder.slice(0, folder.lastIndexOf('/'));
  };

  // Prepare indicator: shows in the status bar while any folder is being prepared, where it
  // covers nothing (a floating pill hid the Compare and thumbnail-size controls on phones).
  const pill = el('button', { type: 'button', className: 'prepare-pill', hidden: true, title: 'Background preparation · open the folder browser',
    onclick: () => document.getElementById('open-folder')?.click() });
  document.getElementById('save-status').after(pill);
  let hideTimer;
  function renderPill(changed) {
    const active = [...jobs.values()].filter(j => j.state === 'running' || j.state === 'queued');
    clearTimeout(hideTimer);
    if (active.length) {
      const job = active.find(j => j.state === 'running') || active[0], name = job.folder.split('/').filter(Boolean).pop();
      pill.textContent = `${name}: ${jobLabel(job)}${active.length > 1 ? ` · ${active.length - 1} waiting` : ''}`;
      pill.hidden = false;
    } else if (changed && changed.state === 'done') {
      pill.textContent = `${changed.folder.split('/').filter(Boolean).pop()}: ready to cull${changed.failed ? ` · ${changed.failed} failed` : ''}`;
      pill.hidden = false; hideTimer = setTimeout(() => { pill.hidden = true; }, 6000);
    } else pill.hidden = true;
    paintBadges();
  }
  server.onPrepare(job => { jobs.set(job.session, job); renderPill(job); });
  void server.prepareStatus().then(list => { for (const job of list) jobs.set(job.session, job); renderPill(); }).catch(() => {});

  // app.js calls this once it can show a session.
  window.PhotoCullServer.attach = async (load, current) => {
    try {
      const last = await server.lastSession();
      if (!last || current()) return;
      lastFolder = last.folder;
      load(await api.openPath(last.folder, last.recursive));
    } catch { /* The folder may be gone; the empty state offers Open. */ }
  };
})();
