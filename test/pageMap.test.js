import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { buildVolumeMap, normalizeHebrew } from '../scripts/build-pages.mjs';
import { openBook, renderSpec, decodeSpec, encodeSpec, turnPage } from '../src/igrot/openBook.js';
import {
  attachPageMaps, loadPageMaps, nearestWordStart, sliceBlocks, bodyText, hebrewNumeral, spreadsOf, spreadPages,
} from '../src/igrot/pageMap.js';
import { answerLetter, getPagePdf, getTurnedPage } from '../src/letters.js';
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

test('a volume with a map opens on a spread: the even page on the right, the odd page on the left', async () => {
  const { volumes, fetchLetter } = setup();
  const page = await openBook(volumes, { random: () => 0.5, fetchLetter });
  const spec = decodeSpec(page.spec, volumes);
  assert.ok(spec && spec.e !== undefined, 'the spec is a spread');
  assert.equal(spec.e % 2, 0);
  assert.deepEqual(page.sides.map((s) => [s.side, s.printed]), [['right', spec.e], ['left', spec.e + 1]]);
  // twice as wide as one page
  assert.equal(page.png.readUInt32BE(16), 2 * page.sides[0].png.readUInt32BE(16));
  assert.ok(page.letters.length >= 1);
});

test('the spreads of a volume pair the printed pages, and the first page stands alone on the left', () => {
  const { volumes } = setup();
  // the synthetic scan has printed pages 1..12
  assert.deepEqual(spreadsOf(volumes[0]), [0, 2, 4, 6, 8, 10, 12]);
  const first = spreadPages(volumes[0], 0);
  assert.equal(first.right, null);
  assert.equal(first.left.printed, 1);
  const last = spreadPages(volumes[0], 12);
  assert.equal(last.right.printed, 12);
  assert.equal(last.left, null);
  assert.equal(spreadPages(volumes[0], 3), null, 'a spread starts on an even page');
  assert.equal(spreadPages(volumes[0], 14), null);
});

test('a spread holds the text of both its pages, and a letter that crosses the fold is listed once', async () => {
  const { v, volumes, fetchLetter } = setup();
  const e = 2; // printed pages 2 and 3: both inside letter 1, which ends on page 3
  const spread = await renderSpec(volumes, { v: 0, e }, { fetchLetter });
  const pair = spreadPages(volumes[0], e);
  const expected = normalizeHebrew(
    [pair.right, pair.left].flatMap((p) => p.segments.map((s) => v.bodies[s.i].slice(s.from, s.to))).join(''),
  ).norm;
  assert.equal(normalizeHebrew(spread.letters.map((l) => l.pageText).join('')).norm, expected);
  const ids = spread.letters.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length, 'no letter is listed twice');
  assert.equal(spread.letters[0].startsOnPage, false);
});

test('turning the leaf of a spread shows the next and previous spreads', async () => {
  const { volumes, fetchLetter } = setup();
  assert.deepEqual(await turnPage(volumes, { v: 0, e: 4 }, 1, { fetchLetter }), { v: 0, e: 6 });
  assert.deepEqual(await turnPage(volumes, { v: 0, e: 4 }, -1, { fetchLetter }), { v: 0, e: 2 });
  assert.equal(await turnPage(volumes, { v: 0, e: 0 }, -1, { fetchLetter }), null);
  assert.equal(await turnPage(volumes, { v: 0, e: 12 }, 1, { fetchLetter }), null);
  assert.deepEqual(decodeSpec(encodeSpec({ v: 0, e: 6 }), volumes), { v: 0, e: 6 });
  assert.equal(decodeSpec(encodeSpec({ v: 0, e: 14 }), volumes), null);
  assert.equal(decodeSpec(encodeSpec({ v: 0, e: 5 }), volumes), null);
});

test('every volume is as likely as any other, whatever its number of letters', async () => {
  const { v, map, fetchLetter } = setup();
  const small = { volume: 1, heading: 'כרך א', letters: v.letters.slice(0, 1) };
  const volumes = attachPageMaps([small, { volume: 2, heading: 'כרך ב', letters: v.letters }], new Map([[2, { ...map, volume: 2 }]]));
  // the first random number picks the volume: below one half is the first volume, though it has one letter of five
  const one = await openBook(volumes, { random: (() => { const q = [0.49]; return () => q.shift() ?? 0; })(), fetchLetter });
  assert.equal(one.volume, 1);
  const two = await openBook(volumes, { random: (() => { const q = [0.51]; return () => q.shift() ?? 0; })(), fetchLetter });
  assert.equal(two.volume, 2);
});

test('the answer to a letter carries the spread, its pages one by one, and a two-page PDF', async () => {
  const { volumes, fetchLetter } = setup();
  const deps = { volumes, fetchLetter, random: (() => { const q = [0, 0.3]; return () => q.shift() ?? 0; })() };
  const answer = await answerLetter({ letter: 'שלום וברכה' }, { ...deps, open: (vols, o) => openBook(vols, { ...o, fetchLetter }) });
  assert.deepEqual(answer.sides.map((s) => s.side), ['right', 'left']);
  assert.match(answer.title, /עמ' ד–ה/);
  assert.ok(answer.sides.every((s) => /^\/api\/page\/[\w-]+\.png$/.test(s.imagePath)));
  const spec = /page\/([\w-]+)\.png/.exec(answer.imagePath)[1];
  const pdf = await getPagePdf(spec, deps);
  assert.equal((await PDFDocument.load(pdf)).getPageCount(), 2);
  const next = await getTurnedPage(spec, 1, deps);
  assert.deepEqual(next.sides.map((s) => s.printed), [6, 7]);
});

test('page numbers are written as the book prints them', () => {
  assert.deepEqual([1, 9, 10, 15, 16, 21, 100, 236, 400, 508].map(hebrewNumeral),
    ['א', 'ט', 'י', 'טו', 'טז', 'כא', 'ק', 'רלו', 'ת', 'תקח']);
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
  assert.equal(await renderSpec(volumes, { v: 0, e: 4 }, { fetchLetter }), null);
  const page = await openBook(volumes, { random: () => 0.5, fetchLetter });
  const spec = decodeSpec(page.spec, volumes);
  assert.ok(spec && spec.p === undefined && spec.e === undefined, 'simulated page: [volume, letter, count, offset]');
});

test('a volume without a map is opened as before', async () => {
  const { v, fetchLetter } = setup();
  const volumes = [{ volume: 1, heading: 'כרך א', letters: v.letters }];
  const page = await openBook(volumes, { random: () => 0.5, fetchLetter });
  const spec = decodeSpec(page.spec, volumes);
  assert.ok(spec.p === undefined && spec.e === undefined);
  assert.equal(page.sides, undefined);
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

test('punctuation at the very start or end of a letter stays with the page that holds the letter', async () => {
  // the map counts Hebrew letters only: its range leaves out the opening bracket and the closing period
  const text = '[אייר] שלום וברכה לכל המשתתפים.';
  const map = {
    volume: 1,
    letters: [{ bodyLength: text.length }],
    pages: [{ pdf: 1, printed: 1, matched: true, segments: [{ i: 0, from: 1, to: text.length - 1 }] }],
  };
  const volumes = attachPageMaps([{ volume: 1, heading: 'כרך א', letters: [['x', 'א']] }], new Map([[1, map]]));
  const fetchLetter = async () => ({ blocks: [{ kind: 'text', text }], text, letterHeading: 'א', viewerUrl: 'u' });
  const page = await renderSpec(volumes, { v: 0, p: 1 }, { fetchLetter });
  assert.equal(page.letters[0].startsOnPage, true);
  assert.equal(page.letters[0].endsOnPage, true);
  assert.equal(page.letters[0].pageText, text);
});
