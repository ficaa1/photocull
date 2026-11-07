const sharp = require('sharp');

// The desktop shell's measure (src-tauri/src/sharpness.rs), so scores from
// either side rank the same way: variance of a four-neighbour Laplacian on
// Rec.709 luminance, with the focus region weighted four times and at least
// 12% of each axis wide.
function measure(width, height, data, channels, focus = null) {
  if (width < 3 || height < 3 || data.length < width * height * channels) throw new Error('Preview is too small for focus analysis.');
  const luma = new Float32Array(width * height);
  for (let i = 0, p = 0; i < luma.length; i++, p += channels) luma[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
  const inFocus = (x, y) => !!focus && Math.abs(x / width - focus.x) <= Math.max(focus.width, 0.12) / 2
    && Math.abs(y / height - focus.y) <= Math.max(focus.height, 0.12) / 2;
  let total = 0, sum = 0, squares = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const value = luma[i - 1] + luma[i + 1] + luma[i - width] + luma[i + width] - 4 * luma[i];
      const weight = inFocus(x, y) ? 4 : 1;
      total += weight; sum += value * weight; squares += value * value * weight;
    }
  }
  return Math.max(0, squares / total - (sum / total) ** 2);
}

function focusRegion(focus) {
  if (!Number.isFinite(focus?.x) || !Number.isFinite(focus?.y)) return null;
  return { x: focus.x, y: focus.y, width: focus.width ?? 0.025, height: focus.height ?? 0.025 };
}

async function scoreFile(file, focus) {
  const { data, info } = await sharp(file).rotate().toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return measure(info.width, info.height, data, info.channels, focusRegion(focus));
}

module.exports = { measure, scoreFile };
