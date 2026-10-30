const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { normalizeSettings } = require('./preferences.cjs');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XMP = 'http://ns.adobe.com/xap/1.0/';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const DC = 'http://purl.org/dc/elements/1.1/';
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

function property(doc, name) {
  for (const desc of Array.from(doc.getElementsByTagNameNS(RDF, 'Description'))) {
    if (desc.hasAttributeNS(XMP, name)) return desc.getAttributeNS(XMP, name);
    const el = desc.getElementsByTagNameNS(XMP, name)[0];
    if (el) return el.textContent;
  }
  return '';
}

function readXmp(xml, settings) {
  const doc = parse(xml);
  const rating = Number(property(doc, 'Rating'));
  const label = property(doc, 'Label');
  const pickLabel = settings ? settings.colors.find(c => c.id === settings.metadata.pickColor)?.label : 'Green';
  const result = { rating: rating > 0 && rating <= 5 ? Math.round(rating) : 0,
    flag: rating === -1 ? 'reject' : pickLabel && label === pickLabel ? 'pick' : 'none' };
  if (settings) result.color = settings.colors.find(c => c.label && c.label === label)?.id || null;
  return result;
}

function updateXmp(xml, decision, settings) {
  const config = normalizeSettings(settings), metadata = config.metadata;
  const base = '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF}"><rdf:Description rdf:about=""/></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>`;
  const doc = parse(xml || base), oldLabel = property(doc, 'Label');
  let desc = doc.getElementsByTagNameNS(RDF, 'Description')[0];
  if (!desc) {
    desc = doc.createElementNS(RDF, 'rdf:Description'); desc.setAttributeNS(RDF, 'rdf:about', '');
    doc.getElementsByTagNameNS(RDF, 'RDF')[0].appendChild(desc);
  }
  function remove(namespace, name) {
    for (const d of Array.from(doc.getElementsByTagNameNS(RDF, 'Description'))) d.removeAttributeNS(namespace, name);
    for (const el of Array.from(doc.getElementsByTagNameNS(namespace, name))) el.parentNode.removeChild(el);
  }
  function scalar(namespace, prefix, name, value) {
    remove(namespace, name); desc.setAttributeNS(XMLNS, 'xmlns:' + prefix, namespace);
    desc.setAttributeNS(namespace, `${prefix}:${name}`, value);
  }
  function collection(name, type, values) {
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
  // Empty preset fields preserve existing values. Keywords are merged.
  if (metadata.creator) collection('creator', 'Seq', [metadata.creator]);
  if (metadata.copyright) collection('rights', 'Alt', [metadata.copyright]);
  if (metadata.title) collection('title', 'Alt', [metadata.title]);
  if (metadata.caption) collection('description', 'Alt', [metadata.caption]);
  if (metadata.keywords.length) {
    const keywords = [];
    for (const subject of Array.from(doc.getElementsByTagNameNS(DC, 'subject'))) {
      for (const li of Array.from(subject.getElementsByTagNameNS(RDF, 'li'))) keywords.push(li.textContent);
    }
    for (const d of Array.from(doc.getElementsByTagNameNS(RDF, 'Description'))) if (d.hasAttributeNS(DC, 'subject')) keywords.push(d.getAttributeNS(DC, 'subject'));
    collection('subject', 'Bag', [...new Set([...keywords, ...metadata.keywords])]);
  }
  return new XMLSerializer().serializeToString(doc);
}

async function atomicWrite(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, data, { flag: 'wx' });
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}

async function writeXmp(file, decision, settings) {
  let old = '';
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('The XMP destination must be a regular file.');
    if (info.size > 2 * 1024 * 1024) throw new Error('Existing sidecar exceeds the 2 MB editing limit; it was left intact.');
    old = await fs.readFile(file, 'utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const next = updateXmp(old, decision, settings);
  // Keep a recoverable original, without overwriting a previous backup.
  if (old) await fs.copyFile(file, `${file}.photocull-backup`, fs.constants.COPYFILE_EXCL).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  await atomicWrite(file, next);
}

module.exports = { readXmp, updateXmp, writeXmp, atomicWrite };
