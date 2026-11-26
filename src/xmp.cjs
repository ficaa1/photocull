const fs = require('node:fs/promises');
const path = require('node:path');
const { publish, checkedMove, stamp } = require('./exclusive-move.cjs');
const { randomUUID } = require('node:crypto');
const { normalizeSettings, text } = require('./preferences.cjs');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XMP = 'http://ns.adobe.com/xap/1.0/';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const DC = 'http://purl.org/dc/elements/1.1/';
const PHOTOCULL = 'https://www.filipbiljic.com/photocull/ns/1.0/';
const XML = 'http://www.w3.org/XML/1998/namespace';

function parse(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XMP with a document type or entity declaration is unsupported; existing sidecar left intact.');
  const issues = [];
  const doc = new DOMParser({ onError: (level, message) => {
    if (level !== 'warning') issues.push(message);
  } }).parseFromString(xml, 'application/xml');
  if (issues.length || doc.documentElement?.localName !== 'xmpmeta' || !doc.getElementsByTagNameNS(RDF, 'RDF').length) {
    throw new Error('The existing XMP is malformed or unsupported; it was left intact.');
  }
  return doc;
}

function photoDescriptions(doc) {
  const descriptions = Array.from(doc.getElementsByTagNameNS(RDF, 'Description')).filter(desc => desc.parentNode?.namespaceURI === RDF && desc.parentNode.localName === 'RDF');
  const subject = descriptions[0]?.getAttributeNS(RDF, 'about') || '';
  return descriptions.filter(desc => (desc.getAttributeNS(RDF, 'about') || '') === subject);
}

function property(doc, name, namespace = XMP) {
  for (const desc of photoDescriptions(doc)) {
    if (desc.hasAttributeNS(namespace, name)) return desc.getAttributeNS(namespace, name);
    const el = Array.from(desc.childNodes).find(n => n.namespaceURI === namespace && n.localName === name);
    if (el) return el.textContent;
  }
  return '';
}

// A frozen capture snapshot replaces the active preset's descriptive fields for that photo. Blank
// fields write nothing, so existing values survive and a later global preset cannot fill them.
function normalizeCaptureMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid capture metadata.');
  if (input.keywords !== undefined && (!Array.isArray(input.keywords) || input.keywords.length > 100)) throw new Error('Use at most 100 keywords.');
  if (input.presetId !== undefined && input.presetId !== null && (typeof input.presetId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(input.presetId))) throw new Error('Invalid metadata preset.');
  return { creator: text(input.creator ?? '', 1024), copyright: text(input.copyright ?? '', 1024), caption: text(input.caption ?? '', 8192),
    keywords: [...new Set((input.keywords || []).map(k => text(k, 128)).filter(Boolean))], presetId: input.presetId ?? null };
}
function captureSettings(settings, item) {
  const config = normalizeSettings(settings);
  if (item?.captureMetadata) {
    const { creator, copyright, caption, keywords } = normalizeCaptureMetadata(item.captureMetadata);
    Object.assign(config.metadata, { creator, copyright, caption, keywords, title: '' });
  }
  Object.assign(config.metadata, item?.metadataOverrides);
  return config;
}

const dcFields = { title: ['title', 'Alt'], caption: ['description', 'Alt'], creator: ['creator', 'Seq'], copyright: ['rights', 'Alt'], keywords: ['subject', 'Bag'] };
const rdfChildren = (parent, name) => Array.from(parent?.childNodes || []).filter(n => n.namespaceURI === RDF && n.localName === name);
function rdfValue(entry) {
  return entry.getAttributeNS(RDF, 'parseType') === 'Resource' ? rdfChildren(entry, 'value')[0] : entry;
}
function isDefaultLanguage(entry) {
  return entry.getAttributeNS(XML, 'lang') === 'x-default' || rdfValue(entry)?.getAttributeNS(XML, 'lang') === 'x-default';
}

function descriptive(doc) {
  const result = {};
  for (const desc of photoDescriptions(doc)) for (const [key, [name, type]] of Object.entries(dcFields)) {
    let values;
    if (desc.hasAttributeNS(DC, name)) values = [desc.getAttributeNS(DC, name)];
    else {
      const el = Array.from(desc.childNodes).find(n => n.namespaceURI === DC && n.localName === name);
      if (!el) continue;
      const value = rdfValue(el);
      const container = Array.from(value?.childNodes || []).find(n => n.namespaceURI === RDF && ['Alt', 'Bag', 'Seq'].includes(n.localName));
      const entries = rdfChildren(container, 'li');
      const preferred = type === 'Alt' && entries.find(isDefaultLanguage);
      values = entries.length ? (preferred ? [preferred] : entries).map(li => rdfValue(li)?.textContent ?? '') : [value?.textContent ?? ''];
    }
    if (key === 'keywords') result[key] = [...new Set([...(result[key] || []), ...values.filter(Boolean)])];
    else if (!Object.hasOwn(result, key)) {
      result[key] = values[0];
      if (key === 'creator' && values.length > 1) result.creators = values;
    }
  }
  return result;
}

function editedFields(doc) {
  return property(doc, 'editedFields', PHOTOCULL).split(' ').filter(key => Object.hasOwn(dcFields, key));
}

function readXmp(xml, settings, { portable = false } = {}) {
  const doc = parse(xml), rawRating = property(doc, 'Rating'), label = property(doc, 'Label');
  const rating = Number(rawRating);
  const pickLabel = settings ? settings.colors.find(c => c.id === settings.metadata.pickColor)?.label : 'Green';
  const result = { rating: rating > 0 && rating <= 5 ? Math.round(rating) : 0,
    flag: rating === -1 ? 'reject' : pickLabel && label === pickLabel ? 'pick' : 'none' };
  if (settings) result.color = settings.colors.find(c => c.label && c.label === label)?.id || (label === '' ? '' : null);
  if (!portable) return result;
  const flag = property(doc, 'flag', PHOTOCULL);
  const savedRating = Number(property(doc, 'rating', PHOTOCULL));
  // Standard fields remain authoritative when another application changes them.
  const ownRating = property(doc, 'standardRating', PHOTOCULL);
  const ownLabel = property(doc, 'standardLabel', PHOTOCULL);
  if (['pick', 'reject', 'none'].includes(flag) && rawRating === ownRating && label === ownLabel) {
    result.flag = flag;
    const color = property(doc, 'color', PHOTOCULL);
    if (settings && (color === '' || color === 'none' || /^[1-8]$/.test(color))) result.color = color === 'none' ? null : color;
    if (Number.isInteger(savedRating) && savedRating >= 0 && savedRating <= 5) result.rating = savedRating;
  }
  result.modified = Date.parse(property(doc, 'modified', PHOTOCULL)) || 0;
  const metadata = descriptive(doc);
  if (Object.keys(metadata).length) result.metadata = metadata;
  const fields = editedFields(doc);
  if (fields.length) result.metadataOverrides = Object.fromEntries(fields.map(key => [key, metadata[key] ?? (key === 'keywords' ? [] : '')]));
  const capture = property(doc, 'captureMetadata', PHOTOCULL);
  if (capture) {
    try { const value = JSON.parse(capture); if (value?.version === 1) result.captureMetadata = normalizeCaptureMetadata(value.metadata); }
    catch { result.warning = 'Invalid PhotoCull capture metadata in XMP; decisions were still imported.'; }
  }
  const state = property(doc, 'develop', PHOTOCULL);
  if (state) {
    try {
      const value = JSON.parse(state);
      if (value?.version === 1 && (value.state === null || value.state && typeof value.state === 'object' && !Array.isArray(value.state))) result.develop = value.state;
    } catch { result.warning = 'Invalid PhotoCull develop data in XMP; decisions were still imported.'; }
  }
  return result;
}

// Generated properties can share the original Description without changing its
// foreign XML. Choose unused prefixes if another application binds ours elsewhere.
function generatedProperties(description, scopes) {
  const doc = description.ownerDocument, bindings = new Map();
  const prefixFor = (namespace, preferred) => {
    if (namespace === XML) return 'xml';
    if (bindings.has(namespace)) return bindings.get(namespace);
    let prefix = preferred;
    for (let n = 1; scopes[prefix] && scopes[prefix] !== namespace || [...bindings].some(([ns, p]) => p === prefix && ns !== namespace); n++) prefix = preferred + n;
    bindings.set(namespace, prefix); return prefix;
  };
  const name = node => node.namespaceURI ? prefixFor(node.namespaceURI, node.prefix || 'ns') + ':' + node.localName : node.nodeName;
  const copy = (node, root = false) => {
    if (node.nodeType !== 1) return node.cloneNode(true);
    const result = doc.createElementNS(node.namespaceURI, name(node));
    for (const attr of Array.from(node.attributes)) {
      if (attr.namespaceURI === XMLNS || root && attr.namespaceURI === RDF && attr.localName === 'about') continue;
      result.setAttributeNS(attr.namespaceURI, name(attr), attr.value);
    }
    for (const child of Array.from(node.childNodes)) result.appendChild(copy(child));
    return result;
  };
  const result = copy(description, true);
  for (const [namespace, prefix] of bindings) if (scopes[prefix] !== namespace) result.setAttributeNS(XMLNS, 'xmlns:' + prefix, namespace);
  const serializer = new XMLSerializer(), xml = serializer.serializeToString(result);
  const opening = /^<[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/.exec(xml)[0];
  return { attributes: Array.from(result.attributes).map(attr => serializer.serializeToString(attr)).join(''),
    children: result.childNodes.length ? xml.slice(opening.length, -('</' + result.nodeName + '>').length) : '' };
}

// Validate with the DOM, then edit only owned XML spans. Unknown attributes,
// elements, comments, namespace aliases and entity spellings retain their bytes.
function patchProperties(xml, owned, description, localized, original) {
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g;
  const stack = [], edits = [];
  const elements = localized.size ? original.getElementsByTagName('*') : null;
  let elementIndex = 0, match, insertion, target, subject;
  const key = (ns, name) => ns + ':' + name;
  const decode = value => value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_, entity) => entity[0] === '#' ? String.fromCodePoint(parseInt(entity.slice(entity[1].toLowerCase() === 'x' ? 2 : 1), entity[1].toLowerCase() === 'x' ? 16 : 10)) : ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[entity.toLowerCase()]);
  while ((match = tokens.exec(xml))) {
    const token = match[0], start = match.index, end = tokens.lastIndex;
    if (/^<[!?]/.test(token)) { if (stack.at(-1)?.desc) stack.at(-1).replaceable = false; continue; }
    if (token.startsWith('</')) {
      const node = stack.pop();
      if (node.defaultText !== undefined) edits.push([node.contentStart, start, node.defaultText]);
      if (node.appendDefault) edits.push([start, start, node.appendDefault]);
      if (node === target) edits.push([start, start, node.generated.children]);
      else if (node.replaceable) {
        for (let i = edits.length - 1; i >= 0; i--) if (edits[i][0] >= node.start) edits.splice(i, 1);
        edits.push([node.start, end, '']);
      } else if (node.remove) edits.push([node.start, end, '']);
      if (node.ns === RDF && node.local === 'RDF' && insertion === undefined) insertion = start;
      continue;
    }
    const parent = stack.at(-1), scopes = { ...parent?.scopes };
    const attrs = [...token.matchAll(/\s+([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*')/g)];
    for (const attr of attrs) {
      if (attr[1] === 'xmlns') scopes[''] = decode(attr[2].slice(1, -1));
      else if (attr[1].startsWith('xmlns:')) scopes[attr[1].slice(6)] = decode(attr[2].slice(1, -1));
    }
    const name = /^<([^\s/>]+)/.exec(token)[1], parts = name.split(':');
    const local = parts.at(-1), ns = scopes[parts.length > 1 ? parts[0] : ''];
    const about = attrs.find(a => a[1].split(':')[1] === 'about' && scopes[a[1].split(':')[0]] === RDF);
    const candidate = ns === RDF && local === 'Description' && parent?.ns === RDF && parent?.local === 'RDF';
    const currentSubject = about ? decode(about[2].slice(1, -1)) : '';
    if (candidate && subject === undefined) subject = currentSubject;
    const desc = candidate && currentSubject === subject;
    if (parent?.desc && !owned.has(key(ns, local))) parent.replaceable = false;
    const replaceable = desc && attrs.some(a => a[1].split(':').at(-1) === 'version' && scopes[a[1].split(':')[0]] === PHOTOCULL) && attrs.every(a => a[1] === 'xmlns' || a[1].startsWith('xmlns:') && [RDF, XMP, PHOTOCULL, DC].includes(decode(a[2].slice(1, -1))) || a[1].split(':').at(-1) === 'about' && scopes[a[1].split(':')[0]] === RDF || owned.has(key(scopes[a[1].split(':')[0]], a[1].split(':')[1])));
    const remove = !stack.some(n => n.remove) && parent?.desc && owned.has(key(ns, local));
    const node = { scopes, ns, local, start, desc, remove, replaceable };
    const edit = elements && localized.get(elements.item(elementIndex++));
    if (edit) Object.assign(node, edit, { contentStart: end });
    if (desc && !target) { target = node; node.generated = generatedProperties(description, scopes); }
    if (desc && !stack.some(n => n.remove) && !remove) for (const attr of attrs) {
      const [prefix, field] = attr[1].split(':');
      if (field && owned.has(key(scopes[prefix], field))) edits.push([start + attr.index, start + attr.index + attr[0].length, '']);
    }
    if (/\/\s*>$/.test(token)) {
      if (edit) edits.push([end - 2, end, '>' + (edit.defaultText ?? edit.appendDefault) + '</' + name + '>']);
      if (node === target) edits.push([end - 2, end, node.generated.attributes + '>' + node.generated.children + '</' + name + '>']);
      else if (remove || replaceable) {
        for (let i = edits.length - 1; i >= 0; i--) if (edits[i][0] >= start) edits.splice(i, 1);
        edits.push([start, end, '']);
      }
      if (ns === RDF && local === 'RDF' && insertion === undefined) {
        edits.push([end - 2, end, '>' + new XMLSerializer().serializeToString(description) + '</' + name + '>']); insertion = -1;
      }
    } else {
      if (node === target) edits.push([end - 1, end - 1, node.generated.attributes]);
      stack.push(node);
    }
  }
  if (!target && insertion >= 0) edits.push([insertion, insertion, new XMLSerializer().serializeToString(description)]);
  if (insertion === undefined) throw new Error('Unsupported RDF structure; existing sidecar left intact.');
  for (const [start, end, value] of edits.sort((a, b) => b[0] - a[0])) xml = xml.slice(0, start) + value + xml.slice(end);
  return xml;
}

function updateXmp(xml, decision, settings) {
  const config = captureSettings(settings, decision), metadata = config.metadata;
  const base = '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF}"><rdf:Description rdf:about=""/></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>`;
  const original = parse(xml || base), oldLabel = property(original, 'Label');
  const doc = parse(base), owned = new Set(), localized = new Map();
  let desc = doc.getElementsByTagNameNS(RDF, 'Description')[0];
  if (!desc) {
    desc = doc.createElementNS(RDF, 'rdf:Description'); desc.setAttributeNS(RDF, 'rdf:about', '');
    doc.getElementsByTagNameNS(RDF, 'RDF')[0].appendChild(desc);
  }
  function remove(namespace, name) {
    owned.add(namespace + ':' + name);
    for (const d of Array.from(doc.getElementsByTagNameNS(RDF, 'Description'))) d.removeAttributeNS(namespace, name);
    for (const el of Array.from(doc.getElementsByTagNameNS(namespace, name))) el.parentNode.removeChild(el);
  }
  function scalar(namespace, prefix, name, value) {
    remove(namespace, name); desc.setAttributeNS(XMLNS, 'xmlns:' + prefix, namespace);
    desc.setAttributeNS(namespace, `${prefix}:${name}`, value);
  }
  function collection(name, type, values) {
    if (type === 'Alt') {
      const properties = photoDescriptions(original).flatMap(d => Array.from(d.childNodes).filter(n => n.namespaceURI === DC && n.localName === name));
      const alt = properties.length === 1 && rdfChildren(rdfValue(properties[0]), 'Alt')[0];
      if (alt) {
        const text = new XMLSerializer().serializeToString(doc.createTextNode(values[0]));
        const defaults = rdfChildren(alt, 'li').filter(isDefaultLanguage);
        for (const entry of defaults) {
          const value = rdfValue(entry);
          if (!value || Array.from(value.childNodes).some(n => n.nodeType !== 3 && n.nodeType !== 4)) throw new Error('Unsupported qualified XMP text; existing sidecar left intact.');
          localized.set(value, { defaultText: text });
        }
        if (!defaults.length) {
          const li = alt.prefix ? alt.prefix + ':li' : 'li';
          localized.set(alt, { appendDefault: '<' + li + ' xml:lang="x-default">' + text + '</' + li + '>' });
        }
        return;
      }
      if (properties.some(el => el.getAttributeNS(RDF, 'parseType') === 'Resource')) throw new Error('Unsupported qualified XMP text; existing sidecar left intact.');
    }
    remove(DC, name); desc.setAttributeNS(XMLNS, 'xmlns:dc', DC);
    const field = doc.createElementNS(DC, 'dc:' + name), list = doc.createElementNS(RDF, 'rdf:' + type);
    for (const value of values) {
      const li = doc.createElementNS(RDF, 'rdf:li');
      if (type === 'Alt') li.setAttributeNS(XML, 'xml:lang', 'x-default');
      li.appendChild(doc.createTextNode(value)); list.appendChild(li);
    }
    field.appendChild(list); desc.appendChild(field);
  }
  if (metadata.writeRatings) scalar(XMP, 'xmp', 'Rating', String(decision.flag === 'reject' && metadata.rejectRating ? -1 : decision.rating));
  if (metadata.writeLabels) {
    const mapped = flag => config.colors.find(c => c.id === metadata[flag + 'Color'])?.label || '';
    let label;
    if (decision.color === '') label = '';
    else if (decision.color) label = config.colors.find(c => c.id === decision.color)?.label || '';
    else if (decision.flag === 'pick' || decision.flag === 'reject') label = mapped(decision.flag);
    else label = ![mapped('pick'), mapped('reject')].includes(oldLabel) ? oldLabel : '';
    scalar(XMP, 'xmp', 'Label', label);
  }
  const overrides = decision.metadataOverrides || {};
  const previous = editedFields(original);
  for (const [key, [name, type]] of Object.entries(dcFields)) {
    if (previous.includes(key) && !Object.hasOwn(decision, 'metadataOverrides')) continue;
    const restoring = (previous.includes(key) || decision.metadataReverts?.includes(key)) && !Object.hasOwn(overrides, key);
    if (key === 'keywords') {
      if (Object.hasOwn(overrides, key)) collection(name, type, overrides.keywords);
      else if (metadata.keywords.length || restoring) {
        const baseline = restoring ? decision.sidecarMetadata : descriptive(original);
        const words = [...new Set([...(baseline?.keywords || []), ...metadata.keywords])];
        if (words.length) collection(name, type, words);
        else remove(DC, name);
      }
    } else if (restoring && key === 'creator' && !decision.captureMetadata?.creator && decision.sidecarMetadata?.creators) {
      collection(name, type, decision.sidecarMetadata.creators);
    } else {
      const value = metadata[key] || (restoring && decision.sidecarMetadata?.[key]);
      const preservedAlt = type === 'Alt' && photoDescriptions(original)
        .flatMap(d => Array.from(d.childNodes).filter(n => n.namespaceURI === DC && n.localName === name))
        .some(el => el.getAttributeNS(RDF, 'parseType') === 'Resource'
          || rdfChildren(rdfValue(el), 'Alt').some(alt => rdfChildren(alt, 'li').some(li => !isDefaultLanguage(li) || li.getAttributeNS(RDF, 'parseType') === 'Resource')));
      if (value || Object.hasOwn(overrides, key) || restoring && preservedAlt) collection(name, type, [value || '']);
      else if (restoring) remove(DC, name);
    }
  }
  if (Object.keys(overrides).length) scalar(PHOTOCULL, 'photocull', 'editedFields', Object.keys(overrides).join(' '));
  else if (Object.hasOwn(decision, 'metadataOverrides')) remove(PHOTOCULL, 'editedFields');
  scalar(PHOTOCULL, 'photocull', 'version', '1');
  scalar(PHOTOCULL, 'photocull', 'flag', decision.flag || 'none');
  scalar(PHOTOCULL, 'photocull', 'color', decision.color ?? 'none');
  scalar(PHOTOCULL, 'photocull', 'rating', String(decision.rating || 0));
  scalar(PHOTOCULL, 'photocull', 'standardRating', metadata.writeRatings ? property(doc, 'Rating') : property(original, 'Rating'));
  scalar(PHOTOCULL, 'photocull', 'standardLabel', metadata.writeLabels ? property(doc, 'Label') : oldLabel);
  scalar(PHOTOCULL, 'photocull', 'modified', new Date(decision.modified || Date.now()).toISOString());
  if (decision.captureMetadata) scalar(PHOTOCULL, 'photocull', 'captureMetadata', JSON.stringify({ version: 1, metadata: normalizeCaptureMetadata(decision.captureMetadata) }));
  if (Object.hasOwn(decision, 'develop')) scalar(PHOTOCULL, 'photocull', 'develop', JSON.stringify({ version: 1, state: decision.develop ? { ...portableDevelop(decision.develop, decision.path, decision.photoRoot), edited: !!decision.develop.editedBy } : null }));
  desc.setAttributeNS(XMLNS, 'xmlns:rdf', RDF);
  return patchProperties(xml || base, owned, desc, localized, original);
}

async function atomicWrite(file, data, exclusive = false) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx');
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    if (exclusive) await publish(temp, file);
    else await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}

async function editedXmp(source, destination, decision, settings) {
  let old = '';
  try {
    const info = await fs.lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('The XMP destination must be a regular file.');
    if (info.size > 2 * 1024 * 1024) throw new Error('Existing sidecar exceeds the 2 MB editing limit; it was left intact.');
    old = await fs.readFile(source, 'utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const next = updateXmp(old, decision, settings);
  if (old) await fs.copyFile(source, destination + '.photocull-backup', fs.constants.COPYFILE_EXCL).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  return next;
}

async function writeXmp(file, decision, settings, renamed) {
  await writableSidecar(file);
  if (!renamed) {
    const exclusive = decision.exclusiveSidecar && !decision.renameSidecars?.has(file);
    const data = exclusive ? updateXmp('', decision, settings) : await editedXmp(file, file, decision, settings);
    await atomicWrite(file, data, exclusive);
    return { receipt: stamp(await fs.lstat(file)), metadata: descriptive(parse(data)) };
  }
  // Take ownership of the recorded entry before editing it. A replacement can then only block publication.
  const dir = await fs.mkdtemp(path.join(path.dirname(file), '.photocull-xmp-'));
  const old = path.join(dir, 'original.xmp'), next = path.join(dir, 'updated.xmp');
  let staged = false, keepOriginal = false;
  try {
    await checkedMove(file, old, renamed.expected, async (from, to) => {
      await fs.rename(from, to); staged = true; return renamed.variableFileIds;
    });
    const data = await editedXmp(old, file, decision, settings);
    await atomicWrite(next, data);
    const receipt = await checkedMove(next, file, stamp(await fs.lstat(next)), publish);
    return { receipt, metadata: descriptive(parse(data)) };
  } catch (error) {
    if (staged) {
      try { await publish(old, file); }
      catch (restoreError) {
        keepOriginal = true;
        throw Object.assign(new Error(`${error.message}. Recover ${old} to ${file}: ${restoreError.message}`), { code: 'FILE_CHANGED' });
      }
    }
    throw error;
  } finally {
    await fs.rm(next, { force: true });
    if (!keepOriginal) {
      await fs.rm(old, { force: true });
      await fs.rmdir(dir);
    }
  }
}

// Sidecars use slash-separated relative paths on every platform. Absolute paths
// outside the photo tree stay absolute; never reinterpret a foreign drive path.
function portablePath(file, photo, root, realPath = file) {
  if (typeof file !== 'string' || !photo) return file;
  const api = path.win32.isAbsolute(photo) && !path.posix.isAbsolute(photo) ? path.win32 : path;
  const relative = api.relative(api.dirname(photo), realPath);
  const inRoot = root && !api.relative(root, realPath).split(api.sep).includes('..') && !api.isAbsolute(api.relative(root, realPath));
  return relative && (inRoot || relative !== '..' && !relative.startsWith('..' + api.sep) && !api.isAbsolute(relative)) ? relative.split(api.sep).join('/') : file;
}
function resolvePath(file, photo, root = path.dirname(photo)) {
  if (typeof file !== 'string' || !file || file.includes('\0')) return null;
  if (path.isAbsolute(file) || path.win32.isAbsolute(file)) return file;
  const parts = file.split(/[\\/]/);
  const resolved = path.resolve(path.dirname(photo), ...parts), relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
  return resolved;
}
function portableDevelop(state, photo, root) {
  if (!state) return null;
  const { missing, ...saved } = state;
  const handoffs = state.handoffs || [], realPaths = new Map(handoffs.map(r => [r.path, r.realPath]));
  return { ...saved, tiff: portablePath(state.tiff, photo, root, realPaths.get(state.tiff)), handoffs: handoffs.map(r => ({ ...r, path: portablePath(r.path, photo, root, r.realPath), realPath: portablePath(r.realPath, photo, root) })) };
}
function resolveDevelop(state, photo, root) {
  if (!state) return null;
  return { ...state, tiff: resolvePath(state.tiff, photo, root), handoffs: (Array.isArray(state.handoffs) ? state.handoffs : []).filter(r => r && typeof r === 'object').map(r => ({ ...r, path: resolvePath(r.path, photo, root), realPath: resolvePath(r.realPath, photo, root) })) };
}
function sidecarPaths(photo) { return [photo.slice(0, -path.extname(photo).length) + '.xmp', photo + '.xmp']; }
async function writableSidecar(file) {
  const dir = await fs.stat(path.dirname(file));
  const stat = await fs.lstat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (!(dir.mode & 0o222) || stat && !(stat.mode & 0o222)) throw new Error('Sidecar location is read-only.');
  await fs.access(path.dirname(file), fs.constants.W_OK);
  if (stat) await fs.access(file, fs.constants.W_OK);
}
const shouldWriteSidecars = (settings, removable) => settings.writeSidecars !== 'never' && !removable;
module.exports = { normalizeCaptureMetadata, captureSettings, readXmp, updateXmp, writeXmp, atomicWrite, sidecarPaths, portableDevelop, resolveDevelop, portablePath, shouldWriteSidecars, PHOTOCULL };
