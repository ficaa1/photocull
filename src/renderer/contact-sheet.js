window.PhotoCullContactSheet = { init({ $, api, session, selection, imageUrl, labelColor, metadata }) {
  const dialog = $('contact-sheet-dialog'), preview = $('sheet-preview'), status = $('sheet-status');
  const fields = $('sheet-fields'), progress = $('sheet-progress'), cancel = $('sheet-cancel');
  const close = dialog.querySelector('.close-dialog'), warnings = $('sheet-warnings');
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
    warnings.hidden = true; preview.replaceChildren(); count.textContent = ''; save.disabled = true;
    let g;
    try { g = PhotoCullSheetLayout.layout(o); } catch (e) { status.textContent = e.message; return; }
    const pages = Math.ceil(photos.length / g.capacity);
    preview.style.aspectRatio = g.width + '/' + g.height;
    preview.dataset.theme = o.theme;
    preview.style.setProperty('--sheet-font', (g.font / g.width * 100).toFixed(3) + 'cqw');
    preview.style.width = 'min(100%, ' + Math.round(340 * g.width / g.height) + 'px)';
    function place(node, x, y, w, h) {
      Object.assign(node.style, { left: x / g.width * 100 + '%', top: y / g.height * 100 + '%',
        width: w / g.width * 100 + '%', height: h / g.height * 100 + '%' });
      preview.append(node);
    }
    function appendCaptions(container, item) {
      function line(text) {
        const label = document.createElement('small'); label.textContent = text;
        container.append(label);
        return label;
      }
      if (o.captions.filename) line(item.name);
      if (o.captions.rating) {
        const label = line(PhotoCullSheetLayout.ratingText(item)), color = labelColor(item);
        if (color) {
          const dot = document.createElement('b'); dot.textContent = '● '; dot.style.color = color.hex;
          dot.title = color.name; label.prepend(dot);
        }
      }
      if (o.captions.exif) {
        const label = line('');
        void metadata(item.id).then(m => { if (m && label.isConnected) label.textContent = PhotoCullSheetLayout.exifText(m); })
          .catch(() => { label.textContent = 'EXIF unavailable'; });
      }
    }
    const header = document.createElement('div'), title = document.createElement('span'), counter = document.createElement('span');
    header.className = 'sheet-preview-header';
    title.textContent = o.headerTitle; counter.textContent = pages ? 'Page 1 of ' + pages : '';
    header.append(title, counter); place(header, g.margin, g.margin, g.width - 2 * g.margin, g.header);
    const imgShare = (g.imageHeight / g.cellHeight * 100).toFixed(2) + '%';
    for (const [index, item] of photos.slice(0, g.capacity).entries()) {
      const { x, y } = PhotoCullSheetLayout.cell(g, index);
      const tile = document.createElement('div');
      tile.className = 'sheet-tile';
      const image = new Image(); image.alt = ''; image.src = imageUrl(item);
      image.style.height = imgShare;
      tile.append(image);
      const captionBox = document.createElement('div');
      captionBox.className = 'sheet-tile-captions';
      appendCaptions(captionBox, item);
      tile.append(captionBox);
      place(tile, x, y, g.cellWidth, g.cellHeight);
    }
    let sample = $('sheet-caption-sample');
    if (!sample) {
      sample = document.createElement('div');
      sample.id = 'sheet-caption-sample';
      preview.insertAdjacentElement('afterend', sample);
    }
    sample.replaceChildren();
    const hasCaptions = o.captions.filename || o.captions.rating || o.captions.exif;
    sample.hidden = !photos.length || !hasCaptions;
    if (!sample.hidden) appendCaptions(sample, photos[0]);
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
    warnings.hidden = true; progress.hidden = false; progress.removeAttribute('value'); status.textContent = 'Choose where to save the contact sheet.';
    try {
      const o = options();
      const result = await api.saveContactSheet(session().id, o.scope === 'selection' ? selection().map(i => i.id) : [], o);
      status.textContent = result ? `Saved ${result.photos} ${result.photos === 1 ? 'photo' : 'photos'} on ${result.pages} ${result.pages === 1 ? 'page' : 'pages'}.` : '';
      if (result?.warnings.length) {
        warnings.querySelector('summary').textContent = 'Warnings (' + result.warnings.length + ')';
        const list = warnings.querySelector('ul'); list.replaceChildren();
        for (const w of result.warnings) {
          const row = document.createElement('li'); row.textContent = w.filename + ' — ' + w.message; list.append(row);
        }
        warnings.open = false; warnings.hidden = false;
      }
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
