(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PhotoCullMetadata = factory();
})(globalThis, () => {
  const textFields = ['title', 'caption', 'creator', 'copyright'];
  const numericFields = ['iso', 'focal', 'f', 'shutter'];
  const lower = value => String(value ?? '').toLowerCase();

  function descriptive(item, embedded = {}, preset = {}) {
    const base = { ...embedded, ...item.sidecarMetadata };
    const defaults = item.captureMetadata || preset;
    const result = {};
    for (const key of textFields) result[key] = defaults[key] || base[key] || '';
    if (item.metadataReverts?.includes('creator') && !item.captureMetadata?.creator && base.creators?.length) result.creator = base.creators[0];
    result.keywords = [...new Set([...(base.keywords || []), ...(defaults.keywords || [])])];
    return Object.assign(result, item.metadataOverrides);
  }

  function number(value) {
    const match = /^(\d+(?:\.\d+)?|\.\d+)(?:\/(\d+(?:\.\d+)?))?$/.exec(String(value ?? '').trim());
    if (!match) return null;
    const n = Number(match[1]) / Number(match[2] ?? 1);
    return Number.isFinite(n) ? n : null;
  }

  function fromExif(tags) {
    let width = Number(tags.ExifImageWidth || tags.ImageWidth), height = Number(tags.ExifImageHeight || tags.ImageHeight);
    if ([5, 6, 7, 8].includes(Number(tags.Orientation))) [width, height] = [height, width];
    const captured = /^(\d{4})[:-](\d\d)[:-](\d\d)/.exec(tags.DateTimeOriginal || '');
    const words = tags.Subject ?? tags.Keywords ?? [];
    const first = value => String((Array.isArray(value) ? value[0] : value) ?? '');
    return {
      camera: String(tags.Model || tags.Make || ''), lens: String(tags.LensModel || ''),
      iso: number(tags.ISO), focal: number(tags.FocalLength), f: number(tags.FNumber), shutter: number(tags.ExposureTime),
      orient: width > 0 && height > 0 ? (width === height ? 'square' : width > height ? 'landscape' : 'portrait') : '',
      date: captured ? captured.slice(1).join('-') : '',
      embedded: { title: first(tags.Title ?? tags.ObjectName), caption: first(tags.Description ?? tags['Caption-Abstract'] ?? tags.ImageDescription),
        creator: first(tags.Creator ?? tags['By-line'] ?? tags.Artist), copyright: first(tags.Rights ?? tags.CopyrightNotice ?? tags.Copyright),
        keywords: (Array.isArray(words) ? words : [words]).filter(word => typeof word === 'string' && word) }
    };
  }

  function numericMatch(field, operator, value) {
    const [start, end, extra] = value.split('-');
    const min = number(start), max = number(end);
    if (min === null || extra !== undefined || end !== undefined && (operator !== ':' || max === null)) return () => false;
    return row => {
      const n = row[field];
      if (!Number.isFinite(n)) return false;
      if (end !== undefined) return n >= min && n <= max;
      switch (operator) {
        case '>=': return n >= min;
        case '<=': return n <= min;
        case '>': return n > min;
        case '<': return n < min;
        default: return n === min;
      }
    };
  }

  function term(token) {
    const value = lower(token.replaceAll('"', ''));
    const field = /^(iso|focal|f|shutter)(>=|<=|>|<|:|=)(.*)$/.exec(value);
    if (!token.startsWith('"') && field) return numericMatch(field[1], field[2], field[3]);
    const text = /^(camera|lens|orient|date|kw|tag|title|caption|creator|copyright):(.+)$/.exec(value);
    if (!token.startsWith('"') && text) {
      const [, key, needle] = text;
      if (key === 'kw' || key === 'tag') return row => row.keywords.some(word => lower(word).includes(needle));
      return row => lower(row[key]).includes(needle);
    }
    return row => [row.name, row.camera, row.lens, row.date, row.orient, ...textFields.map(key => row[key]), ...row.keywords]
      .some(part => lower(part).includes(value));
  }

  function parseQuery(query) {
    const groups = [];
    let group = [], negate = false;
    for (let token of query.match(/(?:"[^"]*(?:"|$)|[^\s"]+)+/g) || []) {
      switch (token.toUpperCase()) {
        case 'OR': if (group.length) groups.push(group); group = []; negate = false; continue;
        case 'AND': continue;
        case 'NOT': negate = !negate; continue;
      }
      if (token.startsWith('-') && token.length > 1) { negate = !negate; token = token.slice(1); }
      const match = term(token);
      group.push(negate ? row => !row.metadataPending && !match(row) : match);
      negate = false;
    }
    if (group.length) groups.push(group);
    return row => !groups.length || groups.some(terms => terms.every(match => match(row)));
  }

  function compile(query, filters = {}) {
    const matches = [];
    if (query.trim()) matches.push(parseQuery(query));
    for (const key of ['camera', 'lens', 'orient', 'date']) if (filters[key]) matches.push(row => row[key] === filters[key]);
    if (filters.keyword) matches.push(row => row.keywords.includes(filters.keyword));
    if (filters.dateFrom) matches.push(row => row.date && row.date >= filters.dateFrom);
    if (filters.dateTo) matches.push(row => row.date && row.date <= filters.dateTo);
    for (const key of numericFields) {
      if (filters[key + 'Min']) matches.push(numericMatch(key, '>=', filters[key + 'Min']));
      if (filters[key + 'Max']) matches.push(numericMatch(key, '<=', filters[key + 'Max']));
    }
    return row => matches.every(match => match(row));
  }

  return { textFields, descriptive, fromExif, parseQuery, compile };
});
