// Renders public/icon.svg (the single source of the app icon) into every raster the app needs:
// Android launcher icons, Android splash screens and PNG icons for the PWA.
//   npm run icons
// public/icon.svg is drawn on the 108×108 adaptive-icon canvas: <g id="bg"> is the background layer and
// <g id="art"> the foreground, kept inside the 66 dp safe circle. Android gets the foreground alone
// (the background gradient lives in res/drawable/ic_launcher_background.xml), plus legacy square and
// round icons for places that still use them.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const RES = new URL('../android/app/src/main/res/', import.meta.url);
const PUBLIC = new URL('../public/', import.meta.url);
const svg = readFileSync(new URL('icon.svg', PUBLIC), 'utf8');
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

const withoutBackground = svg.replace(/<g id="bg">[\s\S]*?<\/g>/, '');
// Legacy icons show the central 84 dp of the canvas, masked to a rounded square / circle.
const legacy = (clip) => svg
  .replace('viewBox="0 0 108 108"', 'viewBox="12 12 84 84"')
  .replace('<defs>', `<defs><clipPath id="mask">${clip}</clipPath></defs><g clip-path="url(#mask)"><defs>`)
  .replace(/<\/svg>\s*$/, '</g></svg>');
const square = legacy('<rect x="12" y="12" width="84" height="84" rx="15"/>');
const round = legacy('<circle cx="54" cy="54" r="42"/>');

async function render(source, px) {
  const img = await loadImage(Buffer.from(source));
  const canvas = createCanvas(px, px);
  canvas.getContext('2d').drawImage(img, 0, 0, px, px);
  return canvas.toBuffer('image/png');
}

// Splash: the icon art on the night-blue background, sized by the short side of the screen.
async function splash(w, h) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(w / 2, h * 0.4, 0, w / 2, h * 0.4, Math.max(w, h) * 0.7);
  g.addColorStop(0, '#2f5a8e');
  g.addColorStop(1, '#162b47');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const size = Math.round(Math.min(w, h) * 0.55);
  ctx.drawImage(await loadImage(Buffer.from(withoutBackground)), (w - size) / 2, (h - size) / 2, size, size);
  return canvas.toBuffer('image/png');
}

for (const [density, scale] of Object.entries(DENSITIES)) {
  const dir = new URL(`mipmap-${density}/`, RES);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL('ic_launcher_foreground.png', dir), await render(withoutBackground, 108 * scale));
  writeFileSync(new URL('ic_launcher.png', dir), await render(square, 48 * scale));
  writeFileSync(new URL('ic_launcher_round.png', dir), await render(round, 48 * scale));
  console.log(`mipmap-${density}: foreground ${108 * scale}px, launcher ${48 * scale}px`);
}

const SPLASH = { mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] };
for (const [density, [short, long]] of Object.entries(SPLASH)) {
  writeFileSync(new URL(`drawable-port-${density}/splash.png`, RES), await splash(short, long));
  writeFileSync(new URL(`drawable-land-${density}/splash.png`, RES), await splash(long, short));
}
writeFileSync(new URL('drawable/splash.png', RES), await splash(480, 320));
console.log('splash screens written');

// PWA: PNG copies of the icon for browsers / platforms that do not take an SVG icon.
mkdirSync(new URL('icons/', PUBLIC), { recursive: true });
for (const px of [192, 512]) writeFileSync(new URL(`icons/icon-${px}.png`, PUBLIC), await render(svg, px));
writeFileSync(new URL('icons/apple-touch-icon.png', PUBLIC), await render(svg, 180));
console.log('public/icons written');
