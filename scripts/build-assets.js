'use strict';
/**
 * Generates the application's branding assets from vector sources:
 *   build/icon.png, build/icon.ico            application / installer icon (16–256 px)
 *   build/installerSidebar.bmp (164×314)      NSIS welcome/finish page artwork
 *   build/uninstallerSidebar.bmp (164×314)    NSIS uninstaller artwork
 *   build/installerHeader.bmp (150×57)        NSIS page header artwork
 *   src/renderer/assets/icon.png|ico          runtime window/tray icon
 *
 * Rendering uses the Chromium bundled with Playwright (dev-time only); the
 * resulting files are committed so packaging does not depend on this script.
 * Usage: node scripts/build-assets.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'build');
const RUNTIME = path.join(ROOT, 'src', 'renderer', 'assets');

const MARK = (id = 'm') => `
  <defs>
    <linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffc46b"/><stop offset="1" stop-color="#f07c1e"/></linearGradient>
    <linearGradient id="${id}d" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d2433"/><stop offset="1" stop-color="#0c1018"/></linearGradient>
  </defs>
  <path d="M32 3l25 14.5v29L32 61 7 46.5v-29z" fill="url(#${id}g)"/>
  <path d="M32 9.5l19.5 11.25v22.5L32 54.5 12.5 43.25v-22.5z" fill="url(#${id}d)"/>
  <rect x="21" y="21" width="22" height="8" rx="2" fill="none" stroke="#ffb04a" stroke-width="2.4"/>
  <rect x="21" y="33" width="22" height="8" rx="2" fill="none" stroke="#ffb04a" stroke-width="2.4"/>
  <circle cx="25.5" cy="25" r="1.6" fill="#3ccf8e"/><circle cx="25.5" cy="37" r="1.6" fill="#3ccf8e"/>
  <path d="M30 25h9M30 37h9" stroke="#ffb04a" stroke-width="2.2" stroke-linecap="round"/>
  <path d="M32 45v4" stroke="#ffb04a" stroke-width="2.4" stroke-linecap="round"/>`;

const ICON_SVG = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">${MARK()}</svg>`;

// Hexagon lattice used as a subtle industrial texture.
function hexPattern(w, h, r, color, opacity) {
  let out = '';
  const dx = r * Math.sqrt(3); const dy = r * 1.5;
  for (let row = -1; row * dy < h + r; row++) {
    for (let col = -1; col * dx < w + r; col++) {
      const cx = col * dx + (row % 2 ? dx / 2 : 0); const cy = row * dy;
      const pts = Array.from({ length: 6 }, (_, i) => { const a = Math.PI / 6 + (i * Math.PI) / 3; return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`; }).join(' ');
      out += `<polygon points="${pts}" fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="1"/>`;
    }
  }
  return out;
}

const SIDEBAR_SVG = (subtitle) => `<svg xmlns="http://www.w3.org/2000/svg" width="164" height="314" viewBox="0 0 164 314">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#151b27"/><stop offset="1" stop-color="#0a0d13"/></linearGradient>
    <radialGradient id="glow" cx="50%" cy="34%" r="55%"><stop offset="0" stop-color="#f6a03c" stop-opacity=".35"/><stop offset="1" stop-color="#f6a03c" stop-opacity="0"/></radialGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffc46b"/><stop offset="1" stop-color="#f07c1e"/></linearGradient>
  </defs>
  <rect width="164" height="314" fill="url(#bg)"/>
  ${hexPattern(164, 314, 14, '#ffffff', 0.035)}
  <rect width="164" height="314" fill="url(#glow)"/>
  <g transform="translate(42 58) scale(1.25)">${MARK('s')}</g>
  <text x="82" y="170" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="700" fill="#e8ecf4">Satisfactory</text>
  <text x="82" y="189" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="700" fill="#e8ecf4">Server Manager</text>
  <rect x="62" y="201" width="40" height="3" rx="1.5" fill="url(#bar)"/>
  <text x="82" y="222" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="9.5" letter-spacing="1.6" fill="#a9b2c5">${subtitle}</text>
  <!-- conveyor -->
  <rect x="14" y="276" width="136" height="9" rx="4.5" fill="#1b2231" stroke="#3a4660"/>
  ${Array.from({ length: 10 }, (_, i) => `<circle cx="${21 + i * 13.5}" cy="280.5" r="2" fill="#3a4660"/>`).join('')}
  <rect x="30" y="264" width="12" height="12" rx="2" fill="url(#bar)"/><rect x="62" y="264" width="12" height="12" rx="2" fill="url(#bar)" opacity=".7"/><rect x="118" y="264" width="12" height="12" rx="2" fill="#3ccf8e" opacity=".85"/>
</svg>`;

const HEADER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="57" viewBox="0 0 150 57">
  <defs><linearGradient id="bar" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffc46b"/><stop offset="1" stop-color="#f07c1e"/></linearGradient></defs>
  <rect width="150" height="57" fill="#ffffff"/>
  ${hexPattern(150, 57, 9, '#f07c1e', 0.07)}
  <g transform="translate(102 6) scale(0.72)">${MARK('h')}</g>
  <text x="96" y="25" text-anchor="end" font-family="Segoe UI, Arial, sans-serif" font-size="10.5" font-weight="700" fill="#151b27">Satisfactory</text>
  <text x="96" y="38" text-anchor="end" font-family="Segoe UI, Arial, sans-serif" font-size="10.5" font-weight="700" fill="#151b27">Server Manager</text>
  <rect x="66" y="43" width="30" height="2.5" rx="1.25" fill="url(#bar)"/>
</svg>`;

/** 24-bit bottom-up BMP from RGBA (alpha composited onto white). */
function toBmp(width, height, rgba) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + rowSize * height;
  const b = Buffer.alloc(size);
  b.write('BM', 0); b.writeUInt32LE(size, 2); b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14); b.writeInt32LE(width, 18); b.writeInt32LE(height, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28);
  b.writeUInt32LE(rowSize * height, 34); b.writeInt32LE(2835, 38); b.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4; const a = rgba[i + 3] / 255;
      const c = (v) => Math.round(v * a + 255 * (1 - a));
      b[row + x * 3] = c(rgba[i + 2]); b[row + x * 3 + 1] = c(rgba[i + 1]); b[row + x * 3 + 2] = c(rgba[i]);
    }
  }
  return b;
}

/** ICO container with PNG-compressed images (supported since Windows Vista). */
function toIco(pngs) {
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size; dir[o + 1] = size >= 256 ? 0 : size; dir[o + 2] = 0; dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6); dir.writeUInt32LE(data.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

async function main() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<html><body style="margin:0;background:transparent"></body></html>');
  const render = (svg, w, h) => page.evaluate(async ({ svg: s, w: W, h: H }) => {
    const img = new Image();
    img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(s)))}`;
    await img.decode();
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, 0, 0, W, H);
    return { png: c.toDataURL('image/png').split(',')[1], rgba: Array.from(ctx.getImageData(0, 0, W, H).data) };
  }, { svg, w, h });

  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(RUNTIME, { recursive: true });
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const s of sizes) pngs.push({ size: s, data: Buffer.from((await render(ICON_SVG(s), s, s)).png, 'base64') });
  const ico = toIco(pngs);
  const big = Buffer.from((await render(ICON_SVG(512), 512, 512)).png, 'base64');
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);
  fs.writeFileSync(path.join(OUT, 'icon.png'), big);
  fs.writeFileSync(path.join(RUNTIME, 'icon.ico'), ico);
  fs.writeFileSync(path.join(RUNTIME, 'icon.png'), pngs.find((p) => p.size === 256).data);
  const side = await render(SIDEBAR_SVG('SETUP'), 164, 314);
  fs.writeFileSync(path.join(OUT, 'installerSidebar.bmp'), toBmp(164, 314, side.rgba));
  const unside = await render(SIDEBAR_SVG('UNINSTALL'), 164, 314);
  fs.writeFileSync(path.join(OUT, 'uninstallerSidebar.bmp'), toBmp(164, 314, unside.rgba));
  const head = await render(HEADER_SVG, 150, 57);
  fs.writeFileSync(path.join(OUT, 'installerHeader.bmp'), toBmp(150, 57, head.rgba));
  // Previews for documentation / review.
  fs.writeFileSync(path.join(OUT, 'preview-sidebar.png'), Buffer.from(side.png, 'base64'));
  fs.writeFileSync(path.join(OUT, 'preview-header.png'), Buffer.from(head.png, 'base64'));
  await browser.close();
  console.log('Assets written to build/ and src/renderer/assets/');
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { toBmp, toIco };
