// Shared by the desktop UI, the copy planner and the tether coordinator.
(function (root) {
  const tokens = new Set(['filename', 'text', 'date', 'capturedate', 'year', 'month', 'day']);
  const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
  const UNSAFE = /[<>:"/\\|?*\x00-\x1f{}]/;
  const pad = (value, width) => (value < 0 ? '-' : '') + String(Math.abs(value)).padStart(width, '0');
  const two = n => String(n).padStart(2, '0');
  function validStem(stem, extension) { return !!stem && !UNSAFE.test(stem) && !RESERVED.test(stem) && stem.length + extension.length <= 200; }
  function needsCapture(template) { return /\{(capturedate|year|month|day)\}/.test(template); }
  function dateParts(value) {
    const match = /^(\d{4})[:\-]?(\d{2})[:\-]?(\d{2})/.exec(String(value || ''));
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 12 || Number(match[3]) < 1 || Number(match[3]) > 31) throw new Error('Capture date unavailable.');
    return { year: match[1], month: match[2], day: match[3] };
  }
  function renderName(name, naming, index = 0, { captured, now = new Date() } = {}) {
    const filename = name.replace(/\.[^.]+$/, ''), extension = name.slice(filename.length);
    const date = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`;
    const parts = needsCapture(naming.template) ? dateParts(captured) : {};
    const values = { filename, text: naming.text, date, ...parts, capturedate: parts.year ? parts.year + parts.month + parts.day : '' };
    const stem = naming.template.replace(/\{([^{}]+)\}/g, (_token, key) => {
      if (/^seq(?::[1-6])?$/.test(key)) return pad(naming.start + index, Number(key.split(':')[1] || 4));
      if (!tokens.has(key)) throw new Error('Unknown filename token.');
      return values[key];
    }).trim().replace(/[. ]+$/, '');
    if (!validStem(stem, extension)) throw new Error('Invalid export filename.');
    return { stem, extension, filename: stem + extension };
  }

  // Capture naming is case-sensitive and separate from the copy/export tokens above.
  const CAPTURE_TOKENS = Object.freeze(['Name', 'JobName', 'Counter', 'CameraCounter', 'Date', 'Time', 'ISO', 'Shutter', 'Aperture', 'FocalLength', 'Camera', 'Subfolder', 'Original']);
  const METERED = new Set(['ISO', 'Shutter', 'Aperture', 'FocalLength']);
  const invalid = message => Object.assign(new Error(message), { code: 'NAME_INVALID' });
  function parseCaptureTemplate(template) {
    if (typeof template !== 'string' || !template || template.length > 180) throw invalid('Use a naming format of 1–180 characters.');
    if (/[\x00-\x1f\x7f]/.test(template)) throw invalid('The naming format contains control characters.');
    const parts = [];
    for (let i = 0; i < template.length;) {
      const open = template.indexOf('{', i), close = template.indexOf('}', i);
      if (close !== -1 && (open === -1 || close < open)) throw invalid('Unmatched } in the naming format.');
      if (open === -1) { parts.push({ text: template.slice(i) }); break; }
      if (open > i) parts.push({ text: template.slice(i, open) });
      const end = template.indexOf('}', open), body = end === -1 ? '' : template.slice(open + 1, end);
      if (end === -1) throw invalid('Unclosed { in the naming format.');
      if (body.includes('{')) throw invalid('Naming tokens cannot be nested.');
      const width = /^Counter:([1-6])$/.exec(body);
      if (width) parts.push({ token: 'Counter', width: Number(width[1]) });
      else if (CAPTURE_TOKENS.includes(body)) parts.push({ token: body, width: 4 });
      else throw invalid(`Unknown naming token {${body}}.`);
      i = end + 1;
    }
    if (parts.some(p => p.text !== undefined && /[<>:"/\\|?*]/.test(p.text))) throw invalid('Literal text contains a character that is not allowed in filenames. Choose folders with the folder picker.');
    return parts;
  }
  function validateCaptureTemplate(template) {
    try { return { valid: true, tokens: [...new Set(parseCaptureTemplate(template).filter(p => p.token).map(p => p.token))], error: null }; }
    catch (error) { return { valid: false, tokens: [], error: error.message }; }
  }
  const trim = (value, digits) => String(Number(value.toFixed(digits)));
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  function rational(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? { value } : null;
    if (Array.isArray(value) && value.length === 2) value = `${value[0]}/${value[1]}`;
    const text = String(value ?? '').trim().replace(/^f\/?/i, '').replace(/\s*(mm|s|sec|")$/i, '');
    const fraction = /^(\d+)\/(\d+)$/.exec(text);
    if (fraction) {
      let [n, d] = [Number(fraction[1]), Number(fraction[2])];
      if (!n || !d || !Number.isSafeInteger(n) || !Number.isSafeInteger(d)) return null;
      const g = gcd(n, d); n /= g; d /= g;
      return { value: n / d, n, d };
    }
    return /^\d+(?:\.\d+)?$/.test(text) && Number(text) > 0 ? { value: Number(text) } : null;
  }
  function formatShutterToken(input) {
    const r = rational(input);
    if (!r) return null;
    if (r.value >= 1) return trim(r.value, 1) + 's';
    if (r.n === 1) return `1-${r.d}`;
    const reciprocal = 1 / r.value;
    return Math.abs(reciprocal - Math.round(reciprocal)) < 1e-3 * reciprocal ? `1-${Math.round(reciprocal)}` : trim(r.value, 4) + 's';
  }
  function formatApertureToken(input) { const r = rational(input); return r ? 'f' + trim(r.value, 2) : null; }
  function formatFocalToken(input) { const r = rational(input); return r ? trim(r.value, 1) + 'mm' : null; }
  function formatIsoToken(input) { const r = rational(input); return r && r.value >= 1 && r.value <= 10_000_000 ? String(Math.round(r.value)) : null; }
  function wallTime(value) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : { date: `${value.getFullYear()}${two(value.getMonth() + 1)}${two(value.getDate())}`, time: `${two(value.getHours())}${two(value.getMinutes())}${two(value.getSeconds())}` };
    const m = /^(\d{4})[:\-]?(\d{2})[:\-]?(\d{2})(?:[ T]?(\d{2}):?(\d{2}):?(\d{2}))?/.exec(typeof value === 'string' ? value : '');
    if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31 || m[4] && (+m[4] > 23 || +m[5] > 59 || +m[6] > 59)) return null;
    return { date: m[1] + m[2] + m[3], time: m[4] ? m[4] + m[5] + m[6] : null };
  }
  // Inserted metadata never contributes a separator, control character or brace.
  const clean = value => String(value).normalize('NFC').trim().replace(/[<>:"/\\|?*\x00-\x1f\x7f{}]+/g, '-').replace(/-{2,}/g, '-');
  const FORMAT = { ISO: formatIsoToken, Shutter: formatShutterToken, Aperture: formatApertureToken, FocalLength: formatFocalToken };
  // context: jobName, counter, cameraCounter, captureTime (camera wall time), hostTime (frozen fallback),
  // iso, shutter, aperture, focalLength, camera, subfolder, original, extension | extensions.
  // Preview never throws and never consumes anything; publication throws NAME_INVALID.
  function renderCaptureName(template, context = {}, { preview = false } = {}) {
    const estimated = new Set(), pending = new Set(), warnings = [];
    try {
      const parts = parseCaptureTemplate(template);
      const stem = parts.map(part => {
        if (part.text !== undefined) return part.text;
        const token = part.token;
        if (token === 'Name' || token === 'JobName') {
          if (typeof context.jobName !== 'string' || !context.jobName.trim() || context.jobName.length > 80) throw invalid('Enter a job name of 1–80 characters.');
          return clean(context.jobName);
        }
        if (token === 'Counter') {
          if (!Number.isSafeInteger(context.counter)) throw invalid('Capture counter unavailable.');
          return pad(context.counter, part.width);
        }
        if (token === 'CameraCounter') {
          if (!Number.isSafeInteger(context.cameraCounter) || context.cameraCounter < 0) throw invalid('Camera Counter unavailable. Choose a format without {CameraCounter}.');
          return pad(context.cameraCounter, 4);
        }
        if (token === 'Date' || token === 'Time') {
          // Date and Time always come from one timestamp.
          let wall = wallTime(context.captureTime);
          if (!wall?.time) wall = wallTime(context.hostTime);
          if (!wall && preview) { estimated.add(token); wall = wallTime(new Date()); }
          if (!wall || token === 'Time' && !wall.time) throw invalid('Capture time unavailable.');
          if (preview && !context.captureTime) estimated.add(token);
          return token === 'Date' ? wall.date : wall.time;
        }
        if (METERED.has(token)) {
          if (preview) estimated.add(token);
          const formatted = FORMAT[token](context[token === 'ISO' ? 'iso' : token[0].toLowerCase() + token.slice(1)]);
          if (formatted) return formatted;
          warnings.push(`${token} unknown`); return 'unknown';
        }
        if (token === 'Original') {
          if (typeof context.original === 'string' && context.original) return clean(context.original);
          if (preview) { pending.add(token); return 'DSC00001'; }
          throw invalid('Original camera filename unavailable.');
        }
        const value = token === 'Camera' ? context.camera : context.subfolder;
        if (typeof value === 'string' && clean(value)) return clean(value);
        warnings.push(`${token} unknown`); return 'unknown';
      }).join('').normalize('NFC').trim().replace(/[. ]+$/, '');
      const extensions = preview ? (Array.isArray(context.extensions) ? context.extensions : ['.ARW', '.JPG']).slice(0, 2) : [context.extension];
      for (const extension of extensions) {
        if (typeof extension !== 'string' || !/^\.[A-Za-z0-9]{1,8}$/.test(extension) || context.allowedExtensions && !context.allowedExtensions.has(extension.toLowerCase())) throw invalid('Unsupported capture file type.');
        if (!validStem(stem, extension) || stem.startsWith('.') || new TextEncoder().encode(stem + extension).length > 255) throw invalid('The capture filename is empty, reserved or too long.');
      }
      if (preview) return { valid: true, filenames: extensions.map(e => stem + e), estimatedTokens: [...estimated], pendingTokens: [...pending], warning: warnings.join('; ') || null, stem };
      return { stem, extension: extensions[0], filename: stem + extensions[0], warnings };
    } catch (error) {
      if (!preview) throw error.code ? error : invalid(error.message);
      return { valid: false, filenames: [], estimatedTokens: [...estimated], pendingTokens: [...pending], warning: error.message, stem: null };
    }
  }
  const api = { renderName, needsCapture, CAPTURE_TOKENS, parseCaptureTemplate, validateCaptureTemplate, renderCaptureName, formatShutterToken, formatApertureToken, formatFocalToken, formatIsoToken, captureWallTime: wallTime, validStem };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PhotoCullNaming = api;
})(globalThis);
