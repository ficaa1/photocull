// Shared by the desktop UI and the copy planner.
(function (root) {
  const tokens = new Set(['filename', 'text', 'date', 'capturedate', 'year', 'month', 'day']);
  function needsCapture(template) { return /\{(capturedate|year|month|day)\}/.test(template); }
  function dateParts(value) {
    const match = /^(\d{4})[:\-]?(\d{2})[:\-]?(\d{2})/.exec(String(value || ''));
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 12 || Number(match[3]) < 1 || Number(match[3]) > 31) throw new Error('Capture date unavailable.');
    return { year: match[1], month: match[2], day: match[3] };
  }
  function renderName(name, naming, index = 0, { captured, now = new Date() } = {}) {
    const filename = name.replace(/\.[^.]+$/, ''), extension = name.slice(filename.length);
    const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const parts = needsCapture(naming.template) ? dateParts(captured) : {};
    const values = { filename, text: naming.text, date, ...parts, capturedate: parts.year ? parts.year + parts.month + parts.day : '' };
    const stem = naming.template.replace(/\{([^{}]+)\}/g, (_token, key) => {
      if (/^seq(?::[1-6])?$/.test(key)) return String(naming.start + index).padStart(Number(key.split(':')[1] || 4), '0');
      if (!tokens.has(key)) throw new Error('Unknown filename token.');
      return values[key];
    }).trim().replace(/[. ]+$/, '');
    if (!stem || /[<>:"/\\|?*\x00-\x1f{}]/.test(stem) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(stem) || stem.length + extension.length > 200) throw new Error('Invalid export filename.');
    return { stem, extension, filename: stem + extension };
  }
  const api = { renderName, needsCapture };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PhotoCullNaming = api;
})(globalThis);
