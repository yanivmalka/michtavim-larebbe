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

/** The printed pages of a map that have letter text on them, in book order. */
export const textPages = (map) => (map?.pages || []).filter((p) => p.matched && p.segments.length);

/** The page with printed number `p` (PDF page number) in a volume's map, or null. */
export function mappedPage(vol, p) {
  const page = vol?.pageMap?.pages?.[p - 1];
  return page && page.pdf === p && page.matched && page.segments.length ? page : null;
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
