// Copies the web UI into www/ for the Android app and points it at the server.
import { cpSync, rmSync, writeFileSync, existsSync } from 'node:fs';

const api = (process.env.API_BASE_URL || '').replace(/\/$/, '');
if (!api) {
  console.warn('⚠️  API_BASE_URL is not set – the app will not be able to reach the server.');
}
if (existsSync('www')) rmSync('www', { recursive: true });
cpSync('public', 'www', { recursive: true });
rmSync('www/sw.js');
writeFileSync('www/config.js', `window.MLR_API_BASE = ${JSON.stringify(api)};\n`);
console.log(`www/ ready (API_BASE_URL=${api || '<empty>'})`);
