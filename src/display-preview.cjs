const sharp = require('sharp');

function orient(image, orientation) {
  const angle = { 3: 180, 4: 180, 5: 270, 6: 90, 7: 90, 8: 270 }[orientation] || 0;
  if ([2, 4, 5, 7].includes(orientation)) image = image.flop();
  return angle ? image.rotate(angle) : image;
}

// Pixel encoding only: selection, scheduling, pass-through and cache publication
// belong to PreviewService. A replacement must return an upright, tagged sRGB JPEG.
async function encodeDisplayPreview(file, { edge, quality, orientation }) {
  let image = sharp(file, { failOn: 'error', limitInputPixels: 160_000_000 });
  image = orientation ? orient(image, orientation) : image.autoOrient();
  if (edge) image = image.resize(edge, edge, { fit: 'inside', withoutEnlargement: true, fastShrinkOnLoad: true });
  const metadata = await image.metadata();
  // Sharp 0.35 processes RGB16 in Display P3. Establish sRGB for untagged
  // samples, then convert and tag; toColourspace alone doesn't change primaries.
  if (metadata.space === 'rgb16' && !metadata.hasProfile) image = image.pipelineColourspace('srgb');
  return image.withIccProfile('srgb').jpeg({ quality }).toBuffer();
}

module.exports = { encodeDisplayPreview, orient };
