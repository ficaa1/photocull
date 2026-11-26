(function (root) {
  const sizes = { letter: [612, 792], a4: [210 * 72 / 25.4, 297 * 72 / 25.4], square: [612, 612], landscape16x9: [648, 1152] };
  const defaults = {
    scope: 'selection', format: 'pdf', pageSize: 'letter', orientation: 'portrait', dpi: 150,
    columns: 4, rows: 5, marginMm: 12, gapMm: 5, theme: 'light', headerTitle: '',
    captions: { filename: true, rating: true, exif: false }, jpegQuality: 88,
  };
  function checkKeys(value, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(allowed, key)))
      throw new Error('Unknown contact sheet option.');
  }
  function layout(input = {}) {
    checkKeys(input, defaults);
    const o = { ...defaults, ...input };
    checkKeys(o.captions, defaults.captions);
    o.captions = { ...defaults.captions, ...o.captions };
    for (const [key, values] of Object.entries({ scope: ['selection', 'picks', 'all'], format: ['pdf', 'jpeg'],
      pageSize: Object.keys(sizes), orientation: ['portrait', 'landscape'], dpi: [150, 200, 300], theme: ['light', 'dark'] })) {
      if (!values.includes(o[key])) throw new Error('Invalid ' + key + '.');
    }
    for (const [key, min, max] of [['columns', 1, 8], ['rows', 1, 10], ['marginMm', 5, 40], ['gapMm', 2, 20], ['jpegQuality', 60, 98]]) {
      const valid = key.endsWith('Mm') ? Number.isFinite(o[key]) : Number.isInteger(o[key]);
      if (!valid || o[key] < min || o[key] > max) throw new Error(key + ' must be between ' + min + ' and ' + max + '.');
    }
    if (typeof o.headerTitle !== 'string' || o.headerTitle.length > 200) throw new Error('Use up to 200 characters for the header.');
    if (Object.values(o.captions).some(value => typeof value !== 'boolean')) throw new Error('Invalid caption choice.');
    let [widthPt, heightPt] = sizes[o.pageSize];
    if (o.orientation === 'landscape') [widthPt, heightPt] = [heightPt, widthPt];
    const px = pt => Math.round(pt * o.dpi / 72);
    const width = px(widthPt), height = px(heightPt);
    const margin = px(o.marginMm * 72 / 25.4), gap = px(o.gapMm * 72 / 25.4);
    const header = px(22), line = px(10), font = px(8);
    const cellWidth = Math.floor((width - 2 * margin - (o.columns - 1) * gap) / o.columns);
    const cellHeight = Math.floor((height - 2 * margin - header - (o.rows - 1) * gap) / o.rows);
    const imageHeight = cellHeight - Object.values(o.captions).filter(Boolean).length * line;
    if (cellWidth < px(10) || imageHeight < px(10)) throw new Error('Reduce the rows, columns, margins or gaps to fit the page.');
    return { options: o, widthPt, heightPt, width, height, margin, gap, header, line, font, cellWidth, cellHeight, imageHeight, capacity: o.columns * o.rows };
  }
  function cell(g, index) {
    return { x: g.margin + index % g.options.columns * (g.cellWidth + g.gap),
      y: g.margin + g.header + Math.floor(index / g.options.columns) * (g.cellHeight + g.gap) };
  }
  const api = { layout, cell };
  if (typeof module === 'object') module.exports = api; else root.PhotoCullSheetLayout = api;
})(globalThis);
