// The printed-page maps (data/pages/vol-NN.json, built by scripts/build-pages.mjs from the scanned volumes).
// A map says which letters each printed page holds, and which character range of each letter's text.
// Opening the book uses a map when the volume has one; otherwise the page is simulated (openBook.js).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyOf } from './chabadlibrary.js';

export const PAGES_DIR = fileURLToPath(new URL('../../data/pages/', import.meta.url));

/** The text of a letter as the maps count it: the body blocks (no editorial notes), one per line. */
export const bodyText = (blocks) => bodyOf(blocks).map((b) => b.text).join('\n');

/** The editors' notes of a letter (its footnotes in print), one text per note, as the maps count them. */
export const notesOf = (blocks) => blocks.filter((b) => b.kind === 'note').map((b) => b.text);

/** True for a page record that holds letter text (a range that is empty holds none). */
const hasText = (p) => !!p && p.matched && p.segments.some((s) => s.to > s.from);

/** The printed pages of a map that have letter text on them, in book order. */
export const textPages = (map) => (map?.pages || []).filter(hasText);

/** The page with printed number `p` (PDF page number) in a volume's map, or null. */
export function mappedPage(vol, p) {
  const page = vol?.pageMap?.pages?.[p - 1];
  return page && page.pdf === p && hasText(page) ? page : null;
}

/** Maps by volume number, read from `dir`. A map that does not parse is skipped. */
export function loadPageMaps(dir = PAGES_DIR) {
  const maps = new Map();
  if (!existsSync(dir)) return maps;
  for (const file of readdirSync(dir)) {
    const m = /^vol-(\d+)\.json$/.exec(file);
    if (!m) continue;
    try {
      const map = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      if (map.volume === Number(m[1])) maps.set(map.volume, map);
    } catch {
      // a broken map is treated as absent: that volume is simulated
    }
  }
  return maps;
}

/** The catalog volumes, each with its map attached (`pageMap`) when there is one. */
export function attachPageMaps(volumes, maps) {
  return volumes.map((v) => (maps.has(v.volume) ? { ...v, pageMap: maps.get(v.volume) } : v));
}

/**
 * The part of a letter's body blocks that lies in [from, to) of bodyText(blocks), as blocks of
 * the same kind (date, address, text...). `continued` marks a piece that starts inside a block.
 */
export function sliceBlocks(bodyBlocks, from, to) {
  const out = [];
  let pos = 0;
  for (const b of bodyBlocks) {
    const start = pos;
    const end = pos + b.text.length;
    pos = end + 1; // the '\n' that bodyText puts between blocks
    const a = Math.max(from, start);
    const z = Math.min(to, end);
    if (z > a) out.push({ kind: b.kind, text: b.text.slice(a - start, z - start), continued: a > start });
  }
  return out;
}

/**
 * The nearest position to `pos` where a word starts (the character before it is a space or line
 * break, or it is the start of the text). A page break is moved there, so no word is cut in two.
 */
export function nearestWordStart(text, pos, radius = 20) {
  const isWordStart = (p) => p === 0 || p >= text.length || /\s/.test(text[p - 1]);
  if (isWordStart(pos)) return pos;
  for (let d = 1; d <= radius; d++) {
    if (pos - d >= 0 && isWordStart(pos - d)) return pos - d;
    if (isWordStart(pos + d)) return pos + d;
  }
  return pos;
}

// ---------- spreads: the two facing pages the book opens on ----------

const UNITS = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
const TENS = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
const HUNDREDS = ['', 'ק', 'ר', 'ש', 'ת', 'תק', 'תר', 'תש', 'תת', 'תתק'];

/** A page number as the book prints it: 15 → טו, 236 → רלו. */
export function hebrewNumeral(n) {
  if (!Number.isInteger(n) || n < 1 || n > 999) return String(n);
  const rest = n % 100;
  const tail = rest === 15 ? 'טו' : rest === 16 ? 'טז' : TENS[Math.floor(rest / 10)] + UNITS[rest % 10];
  return HUNDREDS[Math.floor(n / 100)] + tail;
}

const indexes = new WeakMap();
/** printed page number → page, for the pages of a map that have letter text. */
function printedIndex(map) {
  let index = indexes.get(map);
  if (!index) {
    index = new Map();
    for (const p of textPages(map)) if (Number.isInteger(p.printed) && !index.has(p.printed)) index.set(p.printed, p);
    indexes.set(map, index);
  }
  return index;
}

/**
 * The two facing pages of spread `e` (the even printed number of its right-hand page): in a Hebrew
 * book the even page is on the right and the odd page after it on the left. A side is null when
 * that page has no letter text in the map (front matter, a picture, a page missing from the scan).
 */
export function spreadPages(vol, e) {
  if (!vol?.pageMap || !Number.isInteger(e) || e < 0 || e % 2) return null;
  const index = printedIndex(vol.pageMap);
  const right = index.get(e) ?? null;
  const left = index.get(e + 1) ?? null;
  return right || left ? { right, left } : null;
}

const spreadLists = new WeakMap();
/** Every spread of a volume that has letter text on at least one side, in book order. */
export function spreadsOf(vol) {
  const map = vol?.pageMap;
  if (!map) return [];
  let list = spreadLists.get(map);
  if (!list) {
    const evens = new Set();
    for (const n of printedIndex(map).keys()) evens.add(n - (n % 2));
    list = [...evens].sort((a, b) => a - b);
    spreadLists.set(map, list);
  }
  return list;
}

const ranges = new WeakMap();
/** True when printed page `n` lies between the first and last text pages of the volume. */
export function insideLetters(vol, n) {
  const map = vol?.pageMap;
  if (!map) return false;
  let range = ranges.get(map);
  if (!range) {
    const numbers = [...printedIndex(map).keys()];
    range = { min: Math.min(...numbers), max: Math.max(...numbers) };
    ranges.set(map, range);
  }
  return n > range.min && n < range.max;
}
