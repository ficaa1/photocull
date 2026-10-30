const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

async function fixtures(folder, count = 24) {
  await fs.mkdir(folder, { recursive: true });
  await Promise.all(Array.from({ length: count }, async (_, i) => {
    const hue = 85 + i * 11;
    const svg = `<svg width="1800" height="1200" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x2="0" y2="1"><stop stop-color="hsl(${hue},18%,28%)"/><stop offset="1" stop-color="hsl(${hue},25%,65%)"/></linearGradient></defs><rect width="1800" height="1200" fill="url(#g)"/><circle cx="${1100 + i * 10}" cy="310" r="105" fill="#e6dbb5"/><path d="M0 1100L530 380 1040 1050 1420 510 1800 1080V1200H0Z" fill="#263e37"/><path d="M0 1150L720 700 1220 1100 1600 830 1800 1150V1200H0Z" fill="#18312d"/></svg>`;
    await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).withMetadata({ orientation: i === 2 ? 6 : 1 }).toFile(path.join(folder, `DSC_${String(i + 1).padStart(4, '0')}.jpg`));
  }));
  return folder;
}
module.exports = { fixtures };
