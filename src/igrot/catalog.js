import { readFileSync } from 'node:fs';

const CATALOG_PATH = new URL('../../data/catalog.json', import.meta.url);

/** Loads data/catalog.json (built by `npm run catalog`). */
export function loadCatalog(path = CATALOG_PATH) {
  return JSON.parse(readFileSync(path, 'utf8')).volumes;
}

/**
 * Draws one letter at random, the way people open Igrot Kodesh at random.
 * Every letter across all volumes has an equal chance.
 */
export function drawLetter(volumes, random = Math.random) {
  const total = volumes.reduce((n, v) => n + v.letters.length, 0);
  if (!total) throw new Error('CATALOG_EMPTY');
  let pick = Math.floor(random() * total);
  for (const v of volumes) {
    if (pick < v.letters.length) {
      const [id, heading] = v.letters[pick];
      return { volume: v.volume, volumeHeading: v.heading, id, letterHeading: heading };
    }
    pick -= v.letters.length;
  }
  /* c8 ignore next */
  throw new Error('unreachable');
}
