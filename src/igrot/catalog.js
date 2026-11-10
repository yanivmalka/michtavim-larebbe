import { readFileSync } from 'node:fs';

const CATALOG_PATH = new URL('../../data/catalog.json', import.meta.url);

/** Loads data/catalog.json (built by `npm run catalog`): volumes with their letter ids. */
export function loadCatalog(path = CATALOG_PATH) {
  return JSON.parse(readFileSync(path, 'utf8')).volumes;
}
