// Builds data/catalog.json: every letter id in the Rebbe's Igrot Kodesh on chabadlibrary.org.
// Run once (and again if the site adds volumes): npm run catalog
import { writeFileSync } from 'node:fs';
import { listVolumes, listLetters } from '../src/igrot/chabadlibrary.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const volumes = await listVolumes();
const out = [];
for (const [i, v] of volumes.entries()) {
  await sleep(800); // be gentle with the site
  const letters = await listLetters(v.id);
  out.push({ volume: i + 1, heading: v.heading, id: v.id, letters: letters.map((l) => [l.id, l.heading]) });
  console.log(`${v.heading}: ${letters.length} letters`);
}
const total = out.reduce((n, v) => n + v.letters.length, 0);
writeFileSync(new URL('../data/catalog.json', import.meta.url), JSON.stringify({
  source: 'https://chabadlibrary.org/books/1200000000',
  builtAt: new Date().toISOString().slice(0, 10),
  total,
  volumes: out,
}) + '\n');
console.log(`total: ${total} letters`);
