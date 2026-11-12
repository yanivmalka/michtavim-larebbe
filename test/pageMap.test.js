import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildVolumeMap, normalizeHebrew } from '../scripts/build-pages.mjs';
import { openBook, renderSpec, decodeSpec, encodeSpec, turnPage } from '../src/igrot/openBook.js';
import { attachPageMaps, loadPageMaps, nearestWordStart, sliceBlocks, bodyText } from '../src/igrot/pageMap.js';
import { syntheticVolume } from './support/synthetic-volume.js';

// One volume with a map built from its synthetic scan, plus a fake source for the letters' text.
function setup({ stale = false } = {}) {
  const v = syntheticVolume();
  const { map } = buildVolumeMap({
    volume: 1, pdfName: 'synthetic.pdf', letters: v.letters, bodies: v.bodies, pdfPages: v.pdfPages,
  });
  if (stale) map.letters.forEach((l) => { l.bodyLength += 1; }); // the source text changed since the map was built
  const volumes = attachPageMaps([{ volume: 1, heading: 'כרך א', letters: v.letters }], new Map([[1, map]]));
  const byId = new Map(v.letters.map(([id], k) => [id, k]));
  const fetchLetter = async (id) => {
    const k = byId.get(id);
    return {
      id,
      blocks: [{ kind: 'text', text: v.bodies[k] }],
      text: v.bodies[k],
      letterHeading: `אגרת ${k + 1}`,
      viewerUrl: `https://example.test/${id}`,
    };
  };
  return { v, map, volumes, fetchLetter };
}

test('a volume with a map opens on a printed page of the map', async () => {
  const { volumes, fetchLetter } = setup();
  const page = await openBook(volumes, { random: () => 0.5, fetchLetter });
  const spec = decodeSpec(page.spec, volumes);
  assert.ok(spec && spec.p !== undefined, 'the spec is a printed page, not a simulated one');
  assert.ok(page.png instanceof Buffer && page.png.length > 1000);
  assert.ok(page.letters.length >= 1);
});

test('the text on a printed page is the text the map gives for it', async () => {
  const { v, volumes, fetchLetter } = setup();
  const p = 4; // covers the end of letter 1 and the start of letter 2 (the break is inside letter 1)
  const page = await renderSpec(volumes, { v: 0, p }, { fetchLetter });
  assert.equal(page.truncated, false);

  // the expected text: the letters' bodies cut at the map's ranges, letter by letter
  const expected = normalizeHebrew(
    volumes[0].pageMap.pages[p - 1].segments.map((s) => v.bodies[s.i].slice(s.from, s.to)).join(''),
  ).norm;
  const shown = normalizeHebrew(page.letters.map((l) => l.pageText).join('')).norm;
  assert.equal(shown, expected);
  assert.equal(page.letters[0].startsOnPage, false);
  assert.equal(page.letters.at(-1).endsOnPage, false);
});

test('turning the page moves to the next and previous printed page with text', async () => {
  const { volumes, fetchLetter } = setup();
  const spec = { v: 0, p: 5 };
  const next = await turnPage(volumes, spec, 1, { fetchLetter });
  assert.deepEqual(next, { v: 0, p: 6 });
  const prev = await turnPage(volumes, spec, -1, { fetchLetter });
  assert.deepEqual(prev, { v: 0, p: 4 });
  // the first page with text has no previous page; front matter is not a page of the book
  assert.equal(await turnPage(volumes, { v: 0, p: 2 }, -1, { fetchLetter }), null);
  assert.deepEqual(decodeSpec(encodeSpec(next), volumes), next);
});

test('a page that is not in the map is not a valid spec', () => {
  const { volumes } = setup();
  assert.equal(decodeSpec(encodeSpec({ v: 0, p: 1 }), volumes), null, 'front matter');
  assert.equal(decodeSpec(encodeSpec({ v: 0, p: 999 }), volumes), null, 'beyond the scan');
});

test('a map that no longer matches the letters is not drawn, and opening falls back to a simulated page', async () => {
  const { volumes, fetchLetter } = setup({ stale: true });
  assert.equal(await renderSpec(volumes, { v: 0, p: 5 }, { fetchLetter }), null);
  const page = await openBook(volumes, { random: () => 0.5, fetchLetter });
  const spec = decodeSpec(page.spec, volumes);
  assert.ok(spec && spec.p === undefined, 'simulated page: [volume, letter, count, offset]');
});

test('a volume without a map is opened as before', async () => {
  const { v, fetchLetter } = setup();
  const volumes = [{ volume: 1, heading: 'כרך א', letters: v.letters }];
  const page = await openBook(volumes, { random: () => 0.5, fetchLetter });
  assert.ok(decodeSpec(page.spec, volumes).p === undefined);
});

test('loadPageMaps reads vol-NN.json files and skips broken ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pages-'));
  writeFileSync(join(dir, 'vol-03.json'), JSON.stringify({ volume: 3, pages: [] }));
  writeFileSync(join(dir, 'vol-04.json'), '{ broken');
  writeFileSync(join(dir, 'vol-05.json'), JSON.stringify({ volume: 6, pages: [] }));
  writeFileSync(join(dir, 'notes.txt'), 'x');
  const maps = loadPageMaps(dir);
  assert.deepEqual([...maps.keys()], [3]);
});

test('sliceBlocks cuts a range across blocks and keeps each block kind', () => {
  const blocks = [{ kind: 'date', text: 'ab' }, { kind: 'text', text: 'cdef' }];
  assert.equal(bodyText(blocks), 'ab\ncdef');
  assert.deepEqual(sliceBlocks(blocks, 1, 5), [
    { kind: 'date', text: 'b', continued: true },
    { kind: 'text', text: 'cd', continued: false },
  ]);
});

test('nearestWordStart moves a break to a word start', () => {
  assert.equal(nearestWordStart('אבג דהו', 4), 4); // already a word start
  assert.equal(nearestWordStart('אבג דהו', 2), 0); // the nearest word start is the beginning
  assert.equal(nearestWordStart('אבגדה ווז', 7), 6); // inside a word: the start of the next word
});
