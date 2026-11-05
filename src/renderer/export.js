// Finished-image export. The pure option mapping is shared with Node's validation/tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PhotoCullExport = api;
})(typeof window === 'object' ? window : globalThis, function () {
  const FORMATS = {
    jpeg: { label: 'JPEG', extension: 'jpg', depths: [8], quality: true },
    jxl: { label: 'JPEG XL', extension: 'jxl', depths: [8, 16], quality: true },
    tiff: { label: 'TIFF', extension: 'tif', depths: [16, 8, 32] },
    png: { label: 'PNG', extension: 'png', depths: [8, 16] },
    avif: { label: 'AVIF · slow', extension: 'avif', depths: [8, 10], quality: true },
    webp: { label: 'WebP', extension: 'webp', depths: [8], quality: true },
  };
  const SPACES = { srgb: 'sRGB', displayP3: 'Display P3', adobeRgb: 'Adobe RGB', proPhoto: 'ProPhoto RGB', rec2020: 'Rec. 2020' };
  const MODES = { none: 'No resizing', longEdge: 'Long edge', shortEdge: 'Short edge', width: 'Width', height: 'Height', widthHeight: 'Width & height', dimensions: 'Dimensions', megapixels: 'Megapixels', percent: 'Percent' };
  const PRESETS = [
    { id: 'web-jpeg', builtin: true, name: 'Web 2048 px JPEG', options: { format: 'jpeg', quality: 85, colorSpace: 'srgb', sharpen: 'screen', resize: { mode: 'longEdge', value: 2048, height: 2048, dontEnlarge: true } } },
    { id: 'full-jpeg', builtin: true, name: 'Full-size JPEG', options: { format: 'jpeg', quality: 92, colorSpace: 'srgb' } },
    { id: 'jpeg-xl', builtin: true, name: 'JPEG XL', options: { format: 'jxl', quality: 90, colorSpace: 'srgb' } },
    { id: 'archive-tiff', builtin: true, name: '16-bit TIFF archive', options: { format: 'tiff', bitDepth: 16, colorSpace: 'srgb', tiffCompression: 'none' } },
  ];
  function choice(value, allowed, fallback, label) {
    value = value ?? fallback;
    if (!allowed.includes(value)) throw new Error(`Invalid ${label}.`);
    return value;
  }
  function number(value, fallback, min, max, label, integer = true) {
    const n = Number(value ?? fallback);
    if (!Number.isFinite(n) || n < min || n > max || integer && !Number.isInteger(n)) throw new Error(`${label} must be ${min}–${max}.`);
    return n;
  }
  function options(input = {}) {
    const format = choice(input.format, Object.keys(FORMATS), 'jpeg', 'format'), spec = FORMATS[format];
    const result = { format, quality: spec.quality ? number(input.quality, 90, 1, 100, 'Quality') : 90,
      bitDepth: number(input.bitDepth, spec.depths[0], 8, 32, 'Bit depth'),
      colorSpace: choice(input.colorSpace, Object.keys(SPACES), 'srgb', 'color space'),
      ppi: number(input.ppi, 240, 1, 65535, 'Resolution'),
      resize: null, sharpen: choice(input.sharpen, ['none', 'screen', 'matte', 'glossy'], 'none', 'sharpening'),
      sharpenAmount: choice(input.sharpenAmount, ['low', 'standard', 'high'], 'standard', 'sharpen amount'),
      metadata: choice(input.metadata, ['all', 'allExceptCamera', 'copyright', 'none'], 'all', 'metadata policy'),
      removeLocation: input.removeLocation === true, limitKb: null,
      webpLossless: format === 'webp' && input.webpLossless === true,
      avifSpeed: choice(input.avifSpeed, ['faster', 'balanced', 'smaller'], 'faster', 'AVIF speed'),
      jxlLossless: format === 'jxl' && input.jxlLossless === true,
      jxlEffort: format === 'jxl' ? choice(input.jxlEffort, ['fast', 'normal'], 'normal', 'JPEG XL effort') : 'normal',
      jxlProgressive: format === 'jxl' && input.jxlProgressive === true,
      tiffCompression: format === 'tiff' ? ({ none: 'None', deflate: 'Deflate' })[choice(input.tiffCompression?.toLowerCase(), ['none', 'deflate'], 'none', 'TIFF compression')] : 'None' };
    if (!spec.depths.includes(result.bitDepth)) throw new Error(`Invalid bit depth for ${spec.label}.`);
    if (format === 'avif') result.colorSpace = 'srgb';
    // The lossy JXL encoder cannot declare Adobe RGB/ProPhoto; match Lightcraft's effective_space.
    if (format === 'jxl' && !result.jxlLossless && ['adobeRgb', 'proPhoto'].includes(result.colorSpace)) result.colorSpace = 'rec2020';
    if (format === 'jpeg' && input.limitKb != null && input.limitKb !== '') result.limitKb = number(input.limitKb, null, 1, 4294967295, 'File size (KB)');
    if (input.resize && input.resize.mode !== 'none') {
      const r = input.resize;
      result.resize = { mode: choice(r.mode, Object.keys(MODES).filter(k => k !== 'none'), 'longEdge', 'resize mode'),
        value: number(r.value, 2048, 0.01, 65535, 'Size', false), height: number(r.height, 2048, 1, 65535, 'Height'), dontEnlarge: r.dontEnlarge !== false };
    }
    return result;
  }

  function init({ api, state, selection, buildNaming, readNaming, toast }) {
    const $ = id => document.getElementById('image-export-' + id), dialog = $('dialog');
    let destination = '', running = false, cancelRequested = false, lastUsed, previewGeneration = 0, snapshot = [], session;
    const opt = (value, label) => { const node = document.createElement('option'); node.value = value; node.textContent = label; return node; };
    const setChoices = (id, values) => $(id).replaceChildren(...Object.entries(values).map(([v, label]) => opt(v, label)));
    setChoices('format', Object.fromEntries(Object.entries(FORMATS).map(([v, spec]) => [v, spec.label])));
    setChoices('space', SPACES); setChoices('resize', MODES);
    let presets = [];
    const presetName = () => $('preset-name').value.trim();
    const selectedPreset = () => presets.find(p => p.id === $('preset').value);
    function presetChoices(id = $('preset').value) {
      presets = state.settings.exportPresets || PRESETS;
      $('preset').replaceChildren(opt('last', 'Last used'), ...presets.map(p => opt(p.id, p.name)));
      $('preset').value = presets.some(p => p.id === id) ? id : 'last';
      const p = selectedPreset();
      $('preset-name').value = p?.name || '';
      for (const action of ['rename', 'delete']) $('preset-' + action).disabled = !p || !!p.builtin;
      for (const action of ['duplicate', 'up', 'down']) $('preset-' + action).disabled = !p;
      $('preset-reset').disabled = !p?.builtin;
    }
    async function storePresets(next, id) {
      state.settings = await api.settings({ exportPresets: next }); presetChoices(id);
    }
    const uniqueName = name => { let v = name; for(let n=2;presets.some(p=>p.name.toLowerCase()===v.toLowerCase());n++)v=`${name.slice(0,72)} (${n})`;return v; };
    for (const action of ['save', 'rename', 'duplicate', 'delete', 'up', 'down', 'reset']) $('preset-' + action).onclick = async () => {
      try {
        const p = selectedPreset(), next = structuredClone(presets), index = next.findIndex(v => v.id === p?.id);
        let id = p?.id;
        if (action === 'save' || action === 'duplicate') {
          id = crypto.randomUUID();
          next.push(action === 'duplicate' ? { ...structuredClone(p), id, builtin: false, name: uniqueName(p.name) } : { id, name: presetName() || uniqueName('My export'), options: read(), naming: readNaming('image-export'), subfolder: $('subfolder').value, conflict: $('conflict').value });
        } else if (!p) return;
        else if (action === 'rename' && !p.builtin) next[index].name = presetName();
        else if (action === 'delete' && !p.builtin) next.splice(index, 1);
        else if (action === 'reset' && p.builtin) next[index] = structuredClone(PRESETS.find(v=>v.id===id));
        else if (action === 'up' || action === 'down') {
          const to = index + (action === 'up' ? -1 : 1); if(to<0 || to>=next.length)return;
          [next[index],next[to]] = [next[to],next[index]];
        }
        await storePresets(next,id);
        if (action === 'reset') applyPreset(selectedPreset());
      } catch(e) { $('status').textContent = e.message || String(e); }
    };
    function applyPreset(p) {
      fill(p?.options || lastUsed);
      $('subfolder').value = p?.subfolder ?? state.settings.exportSubfolder ?? '';
      $('conflict').value = p?.conflict || state.settings.exportConflict || 'unique';
      buildNaming('image-export', p?.naming || state.settings.naming, preview); refresh();
    }
    const picked = () => state.session?.items.filter(i => i.flag === 'pick' && !i.trashed) || [];
    const scoped = () => ($('scope').value === 'selection' ? selection() : picked()).filter(i => !i.trashed);
    function fill(input) {
      let o; try { o = options(input); } catch { o = options(); }
      $('format').value = o.format; depths(o.bitDepth);
      for (const [id, key] of Object.entries({ quality: 'quality', space: 'colorSpace', ppi: 'ppi', sharpen: 'sharpen', amount: 'sharpenAmount', metadata: 'metadata', compression: 'tiffCompression', effort: 'jxlEffort' })) $(id).value = key === 'tiffCompression' ? o[key].toLowerCase() : o[key];
      $('webp-lossless').checked = o.webpLossless; $('avif-speed').value = o.avifSpeed; $('lossless').checked = o.jxlLossless; $('progressive').checked = o.jxlProgressive; $('location').checked = o.removeLocation;
      $('limit').checked = !!o.limitKb; $('limit-kb').value = o.limitKb || 2000;
      $('resize').value = o.resize?.mode || 'none'; $('size').value = o.resize?.value || 2048; $('height').value = o.resize?.height || 2048; $('enlarge').checked = o.resize?.dontEnlarge !== false;
      refresh();
    }
    function depths(wanted) {
      const values = FORMATS[$('format').value].depths;
      $('depth').replaceChildren(...values.map(n => opt(String(n), n === 32 ? '32-bit float' : `${n}-bit`)));
      $('depth').value = String(values.includes(Number(wanted)) ? wanted : values[0]);
    }
    function read() {
      return options({ format: $('format').value, quality: $('quality').value, bitDepth: $('depth').value, colorSpace: $('space').value, ppi: $('ppi').value,
        webpLossless: $('webp-lossless').checked, avifSpeed: $('avif-speed').value, jxlLossless: $('lossless').checked, jxlProgressive: $('progressive').checked, jxlEffort: $('effort').value, tiffCompression: $('compression').value,
        limitKb: $('limit').checked ? $('limit-kb').value : null, sharpen: $('sharpen').value, sharpenAmount: $('amount').value,
        metadata: $('metadata').value, removeLocation: $('location').checked,
        resize: $('resize').value === 'none' ? null : { mode: $('resize').value, value: $('size').value, height: $('height').value, dontEnlarge: $('enlarge').checked } });
    }
    async function preview() {
      const generation = ++previewGeneration;
      try {
        const item = scoped()[0]; if (!item) { $('name-preview').textContent = ''; return; }
        const name = await api.namingPreview(state.session.id, readNaming('image-export'), item.id, FORMATS[$('format').value].extension);
        if (generation === previewGeneration) $('name-preview').textContent = name;
      } catch (e) { if (generation === previewGeneration) $('name-preview').textContent = (e.message || String(e)); }
    }
    function refresh() {
      const format = $('format').value, spec = FORMATS[format], resize = $('resize').value;
      $('quality-row').hidden = !spec.quality || format === 'jxl' && $('lossless').checked || format === 'webp' && $('webp-lossless').checked;
      $('webp-row').hidden = format !== 'webp'; $('avif-row').hidden = format !== 'avif'; $('jxl-row').hidden = format !== 'jxl'; $('compression-row').hidden = format !== 'tiff'; $('limit-row').hidden = format !== 'jpeg';
      $('limit-kb').disabled = !$('limit').checked || running;
      $('space').disabled = format === 'avif' || running;
      if (format === 'avif') $('space').value = 'srgb';
      const fallback = format === 'jxl' && !$('lossless').checked && ['adobeRgb', 'proPhoto'].includes($('space').value);
      $('format-note').textContent = format === 'avif' ? 'AVIF exports sRGB. Faster favors speed; Smaller spends more time compressing (no ICC profile).' : format === 'webp' ? 'WebP exports 8-bit images. Choose lossless to preserve every output pixel.' : fallback ? 'Lossy JPEG XL writes this color space as Rec. 2020.' : '';
      $('size-row').hidden = resize === 'none'; $('height-field').hidden = !['widthHeight', 'dimensions'].includes(resize);
      $('size-unit').textContent = resize === 'percent' ? '%' : resize === 'megapixels' ? 'MP' : 'px';
      $('amount').disabled = $('sharpen').value === 'none' || running;
      const items = scoped(), edits = $('source').value === 'edited' ? items.filter(i => i.dehancer).length : 0;
      const raw = items.filter(i => i.raw && !($('source').value === 'edited' && i.dehancer)).length;
      $('counts').textContent = `${items.length} photos · ${edits} Dehancer edits · ${raw} developed from RAW · ${items.length - edits - raw} image originals`;
      $('source-note').textContent = edits ? 'Dehancer saves 8-bit sRGB TIFFs. Wider spaces and greater bit depths add no source color or detail.' : 'RAWs use each photo’s current develop settings. Other images are re-encoded from the original.';
      $('metadata-note').textContent = `Preset: ${state.settings.presets?.find(p => p.id === state.settings.activePreset)?.name || 'Current'} · nonempty creator, copyright, title, caption and keywords apply within the selected policy.`;
      $('destination-path').textContent = destination || 'Choose folder…';
      if (document.activeElement !== $('folder')) $('folder').value = destination;
      $('start').disabled = running || !items.length || !destination || !api.canDevelop || state.pendingSaves > 0 || state.deleting || state.copy.running;
      $('cancel').hidden = !running; $('close').disabled = running;
      void preview();
    }
    async function open() {
      if (running || state.busy || state.copy.running || state.deleting || !state.session) return;
      try {
        state.settings = await api.settings(); lastUsed = state.settings.exportOptions;
        await Promise.all(state.session.items.filter(i => i.dehancer).map(async item => {
          const develop = await api.developGet(state.session.id, item.id); item.dehancer = !!(develop.edited && develop.tiff);
        }));
        $('subfolder').value = state.settings.exportSubfolder || ''; $('conflict').value = state.settings.exportConflict || 'unique';
        $('scope').value = 'picks'; $('source').value = 'edited'; presetChoices('last');
        $('naming-preset').replaceChildren(opt('', 'Current naming'), ...(state.settings.presets || []).map(p => opt(p.id, p.name)));
        buildNaming('image-export', state.settings.naming, preview); fill(lastUsed);
        $('status').textContent = api.canDevelop ? '' : 'Finished-image export needs the desktop app.'; $('results').hidden = true; $('reveal').hidden = true; $('progress').hidden = true;
        dialog.showModal(); refresh();
      } catch (e) { toast((e.message || String(e))); }
    }
    $('preset').onchange = () => { const p = selectedPreset(); presetChoices(); applyPreset(p); };
    $('naming-preset').onchange = () => {
      const preset = state.settings.presets?.find(p => p.id === $('naming-preset').value);
      buildNaming('image-export', preset?.naming || state.settings.naming, preview);
    };
    $('format').onchange = () => { depths(); refresh(); };
    dialog.addEventListener('input', refresh); dialog.addEventListener('change', refresh);
    $('destination').onclick = async () => { try { destination = await api.pickFolder('Export finished images to…') || destination; refresh(); } catch (e) { $('status').textContent = (e.message || String(e)); } };
    $('folder').oninput = () => { destination = $('folder').value.trim(); refresh(); };
    $('close').onclick = () => { if (!running) dialog.close(); };
    dialog.addEventListener('cancel', e => { if (running) { e.preventDefault(); $('status').textContent = 'Cancel the export first. Active encoders must finish before it can stop.'; } });
    api.onExportProgress(p => { if (running) { $('progress').max = Math.max(1, p.total); $('progress').value = p.done; $('status').textContent = `${p.done} / ${p.total}${p.name ? ' · ' + p.name : ''}`; } });
    $('cancel').onclick = async () => { cancelRequested = true; $('cancel').disabled = true; $('status').textContent = 'Cancelling after active encoders finish…'; try { await api.developCancel(); } catch (e) { $('status').textContent = (e.message || String(e)); } };
    $('reveal').onclick = () => { void api.revealDestination(destination).catch(e => { $('status').textContent = (e.message || String(e)); }); };
    $('start').onclick = async () => {
      if (running || $('start').disabled || state.busy) return;
      let o; try { o = read(); } catch (e) { $('status').textContent = (e.message || String(e)); return; }
      snapshot = scoped().map(i => ({ ...i })); session = state.session.id; running = true; cancelRequested = false; state.busy = true;
      $('results').hidden = true; $('reveal').hidden = true; $('status').textContent = 'Checking names and destinations…'; $('cancel').disabled = false;
      dialog.querySelectorAll('input,select,button').forEach(el => { el.disabled = true; }); $('cancel').disabled = false; refresh();
      try {
        const plan = await api.exportPlan(session, snapshot.map(i => i.id), { folder: destination, naming: readNaming('image-export'), subfolder: $('subfolder').value, extension: FORMATS[o.format].extension, conflict: $('conflict').value });
        const errors = plan.filter(p => p.error);
        if (errors.length) { $('status').textContent = 'Export has not started. Fix the filenames or destination.'; $('results').textContent = errors.map(p => `${p.name}: ${p.error}`).join('\n'); $('results').hidden = false; return; }
        const items = [];
        for (const p of plan.filter(p => !p.skip)) {
          if (cancelRequested) break;
          const develop = await api.developGet(session, p.id);
          items.push({ id: p.id, dest: p.dest, settings: develop.settings, edited: $('source').value === 'edited' && develop.edited && !!develop.tiff });
        }
        if (cancelRequested) { $('status').textContent = 'Export cancelled before writing files.'; return; }
        state.settings = await api.settings({ exportOptions: o, exportSubfolder: $('subfolder').value, exportConflict: $('conflict').value, naming: readNaming('image-export') });
        lastUsed = o; $('progress').hidden = false; $('progress').value = 0; $('progress').max = Math.max(1, items.length);
        const result = items.length ? await api.exportPhotos(session, items, o, $('conflict').value === 'overwrite', state.settings.metadata) : { results: [] };
        const completed = new Map(result.results.map(r => [r.id, r]));
        const rows = plan.map(p => p.skip ? { ...p, status: 'exists', error: p.reason } : completed.get(p.id)).filter(Boolean);
        const count = status => rows.filter(r => status.includes(r.status)).length;
        $('status').textContent = `${count(['exported'])} exported · ${count(['exists', 'cancelled'])} skipped · ${count(['failed'])} failed`;
        $('results').textContent = rows.filter(r => r.status !== 'exported').map(r => `${snapshot.find(i => i.id === r.id)?.name || r.id}: ${r.error || (r.status === 'cancelled' ? 'Cancelled' : 'Already exists')}`).join('\n');
        $('results').hidden = !$('results').textContent; $('reveal').hidden = !count(['exported']);
      } catch (e) { $('status').textContent = (e.message || String(e)); }
      finally {
        running = false; state.busy = false;
        dialog.querySelectorAll('input,select,button').forEach(el => { el.disabled = false; }); presetChoices(); refresh();
      }
    };
    document.getElementById('image-export').onclick = open;
    return { open, refresh };
  }
  return { FORMATS, SPACES, MODES, PRESETS, options, init };
});
