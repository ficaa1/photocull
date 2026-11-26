window.PhotoCullContactSheet = { init({ $, api, session, selection, imageUrl }) {
  const dialog = $('contact-sheet-dialog'), preview = $('sheet-preview'), status = $('sheet-status');
  const fields = $('sheet-fields'), progress = $('sheet-progress'), cancel = $('sheet-cancel');
  const close = dialog.querySelector('.close-dialog');
  let running = false, folder = null;
  function options() {
    const value = key => $('sheet-' + key).value;
    const result = { captions: {} };
    for (const key of ['scope', 'format', 'pageSize', 'orientation', 'theme', 'headerTitle']) result[key] = value(key);
    for (const key of ['columns', 'rows', 'marginMm', 'gapMm', 'dpi', 'jpegQuality']) result[key] = Number(value(key));
    for (const key of ['filename', 'rating', 'exif']) result.captions[key] = $('sheet-' + key).checked;
    return result;
  }
  function draw() {
    const o = options(), photos = (o.scope === 'selection' ? selection() : session().items)
      .filter(i => !i.trashed && (o.scope !== 'picks' || i.flag === 'pick'));
    const count = $('sheet-count'), save = $('sheet-save');
    preview.replaceChildren(); count.textContent = ''; save.disabled = true;
    let g;
    try { g = PhotoCullSheetLayout.layout(o); } catch (e) { status.textContent = e.message; return; }
    const pages = Math.ceil(photos.length / g.capacity);
    preview.style.aspectRatio = g.width + '/' + g.height;
    preview.dataset.theme = o.theme;
    preview.style.width = 'min(100%, ' + (290 * g.width / g.height) + 'px)';
    function place(node, x, y, w, h) {
      Object.assign(node.style, { left: x / g.width * 100 + '%', top: y / g.height * 100 + '%',
        width: w / g.width * 100 + '%', height: h / g.height * 100 + '%' });
      preview.append(node);
    }
    const header = document.createElement('div'), title = document.createElement('span'), counter = document.createElement('span');
    title.textContent = o.headerTitle; counter.textContent = pages ? 'Page 1 of ' + pages : '';
    header.append(title, counter); place(header, g.margin, g.margin, g.width - 2 * g.margin, g.header);
    for (const [index, item] of photos.slice(0, g.capacity).entries()) {
      const { x, y } = PhotoCullSheetLayout.cell(g, index);
      const image = new Image(); image.alt = ''; image.src = imageUrl(item);
      place(image, x, y, g.cellWidth, g.imageHeight);
      if (o.captions.filename) {
        const label = document.createElement('small'); label.textContent = item.name;
        place(label, x, y + g.imageHeight, g.cellWidth, g.line);
      }
    }
    count.textContent = photos.length + (photos.length === 1 ? ' photo' : ' photos') + ' → ' + pages + (pages === 1 ? ' page' : ' pages');
    save.disabled = !photos.length || !api.desktop || running;
    status.textContent = api.desktop ? '' : 'Save contact sheets in the PhotoCull desktop app.';
  }
  $('sheet-pageSize').oninput = () => {
    if ($('sheet-pageSize').value === 'landscape16x9') $('sheet-orientation').value = 'landscape';
  };
  fields.oninput = () => { folder = null; $('sheet-reveal').hidden = true; draw(); };
  function open() {
    if (!session() || document.querySelector('dialog[open]')) return;
    $('sheet-scope').value = selection().length > 1 ? 'selection' : 'all';
    folder = null; $('sheet-reveal').hidden = true;
    draw(); dialog.showModal();
  }
  $('sheet-save').onclick = async () => {
    if (running) return;
    running = true; fields.disabled = close.disabled = cancel.disabled = $('sheet-save').disabled = true;
    folder = null; $('sheet-reveal').hidden = true;
    progress.hidden = false; progress.removeAttribute('value'); status.textContent = 'Choose where to save the contact sheet.';
    try {
      const o = options();
      const result = await api.saveContactSheet(session().id, o.scope === 'selection' ? selection().map(i => i.id) : [], o);
      status.textContent = result ? `Saved ${result.photos} ${result.photos === 1 ? 'photo' : 'photos'} on ${result.pages} ${result.pages === 1 ? 'page' : 'pages'}.` : '';
      if (result) { folder = result.folder; $('sheet-reveal').hidden = false; }
    } catch (error) { status.textContent = error.message || String(error); }
    finally {
      running = false; fields.disabled = close.disabled = cancel.disabled = $('sheet-save').disabled = false;
      progress.hidden = true; cancel.textContent = 'Close';
    }
  };
  api.onContactSheetProgress(event => {
    if (!running) return;
    if (!progress.hasAttribute('value')) { cancel.disabled = false; cancel.textContent = 'Cancel'; }
    progress.max = event.total; progress.value = event.done;
    if (!cancel.disabled) status.textContent = `Page ${event.page} of ${event.pages} · ${event.done} / ${event.total} photos`;
  });
  cancel.onclick = async () => {
    if (!running) return dialog.close();
    cancel.disabled = true; status.textContent = 'Canceling export…';
    try { await api.cancelContactSheet(); } catch (e) { cancel.disabled = false; status.textContent = e.message || String(e); }
  };
  dialog.oncancel = event => { if (running) { event.preventDefault(); if (!cancel.disabled) cancel.click(); } };
  $('sheet-reveal').onclick = () => api.revealDestination(folder).catch(e => { status.textContent = e.message || String(e); });
  dialog.onclose = () => { preview.replaceChildren(); cancel.textContent = 'Cancel'; };
  return { open };
} };
