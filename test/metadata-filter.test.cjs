const test = require('node:test');
const assert = require('node:assert/strict');
const { compile, fromExif, descriptive } = require('../src/renderer/metadata-filter.js');

const portrait = { name: 'frame-1.jpg', camera: 'Sony A7', lens: '50mm prime', iso: 800, f: 2.8,
  focal: 50, shutter: 0.004, orient: 'portrait', date: '2026-11-03', keywords: ['Studio', 'portrait'],
  title: 'Golden Hour', caption: 'Two dancers', creator: 'Ana', copyright: '2026' };
const wide = { ...portrait, name: 'frame-2.jpg', iso: 400, focal: 85, keywords: ['outdoors'], title: 'Hills', orient: 'landscape' };
const unknown = { name: 'untagged.jpg', keywords: [] };
const matches = (query, filters) => [portrait, wide, unknown].filter(compile(query, filters)).map(row => row.name);

test('boolean queries group phrases and field comparisons with NOT before AND before OR', () => {
  const first = ['frame-1.jpg'], second = ['frame-2.jpg'];
  for (const [query, expected] of [
    ['title:"golden hour" camera:a7 lens:50 ISO>=800 AND f<=2.8', first],
    ['"golden hour" AND caption:dancers creator:ANA date:2026-11 orient:portrait', first],
    ['tag:studio or kw:outdoor NOT focal>=85', first],
    ['iso:100-400 -kw:studio', second], ['iso>400 shutter:1/250', first],
    ['tag:studio OR focal>=85 iso<800', [...first, ...second]], ['-frame NOT tag:studio', ['untagged.jpg']],
    ['kw:outdoors AND NOT "Golden Hour"', second], ['focal:85-50', []], ['iso>=oops', []],
    ['iso<=0', []], ['frame-2', second], ['frame missing', []],
    ['"OR"', [...first, ...second]], ['"title:hills"', []]
  ]) assert.deepEqual(matches(query), expected, query);
});

test('facet filters intersect the query, enforce inclusive bounds and reject unknown metadata', () => {
  const criteria = { camera: 'Sony A7', lens: '50mm prime', orient: 'portrait', date: '2026-11-03',
    dateFrom: '2026-11-03', dateTo: '2026-11-03', keyword: 'Studio', isoMin: '400', isoMax: '800',
    fMax: '2.8', focalMin: '50', shutterMin: '1/250', shutterMax: '1/200' };
  assert.deepEqual(matches('creator:Ana OR untagged', criteria), ['frame-1.jpg']);
  for (const overrides of [{ dateTo: '2026-11-02' }, { keyword: 'outdoors' }, { isoMax: '799' }, { shutterMin: '1/200' }])
    assert.deepEqual(matches('', { ...criteria, ...overrides }), []);
  assert.deepEqual(matches('', { dateTo: '2027' }), ['frame-1.jpg', 'frame-2.jpg']);
});

test('the EXIF index uses capture-local dates, oriented source dimensions and descriptive fallbacks', () => {
  const tags = { Model: 'A7', LensModel: 'Prime', FocalLength: 85, ISO: '800', FNumber: '2.8', ExposureTime: '1/250',
    DateTimeOriginal: '2026:11:03 23:50:00-06:00', ImageWidth: 6000, ImageHeight: 4000, Orientation: 6,
    ObjectName: 'Portrait', Artist: 'Ana', CopyrightNotice: '©', 'Caption-Abstract': 'Dancer', Keywords: 'dance' };
  assert.deepEqual(fromExif(tags), { camera: 'A7', lens: 'Prime', focal: 85, iso: 800, f: 2.8, shutter: 0.004,
    date: '2026-11-03', orient: 'portrait', embedded: { title: 'Portrait', creator: 'Ana', copyright: '©', caption: 'Dancer', keywords: ['dance'] } });
  assert.equal(fromExif({ ImageWidth: 200, ImageHeight: 200 }).orient, 'square');
  assert.equal(fromExif({}).orient, '');
  const item = { captureMetadata: { creator: 'Capture' }, sidecarMetadata: { title: 'Sidecar' }, metadataOverrides: { creator: '', keywords: [] } };
  assert.deepEqual(descriptive(item, fromExif(tags).embedded, { caption: 'Preset' }),
    { title: 'Sidecar', caption: 'Dancer', creator: '', copyright: '©', keywords: [] });
});
