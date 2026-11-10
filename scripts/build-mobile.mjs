// Copies the web UI into www/ for the Android app and points it at the server.
import { cpSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

const api = (process.env.API_BASE_URL || '').replace(/\/$/, '');
if (!api) {
  console.warn('ℹ️  API_BASE_URL is not set – the app will ask for the server address on first use.');
}
if (existsSync('www')) rmSync('www', { recursive: true });
cpSync('public', 'www', { recursive: true });
rmSync('www/sw.js');
writeFileSync('www/config.js', `window.MLR_API_BASE = ${JSON.stringify(api)};\n`);
// Capacitor's core runtime (registerPlugin) – the app talks to native plugins through it.
cpSync('node_modules/@capacitor/core/dist/capacitor.js', 'www/capacitor.js');
const html = readFileSync('www/index.html', 'utf8');
writeFileSync('www/index.html', html.replace('<script src="config.js"></script>', '<script src="capacitor.js"></script>\n  <script src="config.js"></script>'));
console.log(`www/ ready (API_BASE_URL=${api || '<empty>'})`);
