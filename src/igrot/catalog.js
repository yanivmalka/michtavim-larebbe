import { readFileSync } from 'node:fs';

const CATALOG_PATH = new URL('../../data/volumes.json', import.meta.url);

/** Volumes that have a source id and a page range – only these can be drawn. */
export function loadVolumes(path = CATALOG_PATH) {
  const { volumes } = JSON.parse(readFileSync(path, 'utf8'));
  return volumes.filter(
    (v) => v.sourceId && Number.isInteger(v.firstLetterPage) && Number.isInteger(v.lastLetterPage)
      && v.lastLetterPage >= v.firstLetterPage,
  );
}

/**
 * Draws a random page, the way people open a volume of Igrot Kodesh at random.
 * Every page across all configured volumes has an equal chance.
 */
export function drawPage(volumes, random = Math.random) {
  if (!volumes.length) {
    throw new Error('CATALOG_EMPTY');
  }
  const total = volumes.reduce((n, v) => n + (v.lastLetterPage - v.firstLetterPage + 1), 0);
  let pick = Math.floor(random() * total);
  for (const v of volumes) {
    const size = v.lastLetterPage - v.firstLetterPage + 1;
    if (pick < size) return { volume: v.volume, sourceId: v.sourceId, page: v.firstLetterPage + pick };
    pick -= size;
  }
  /* c8 ignore next */
  throw new Error('unreachable');
}
