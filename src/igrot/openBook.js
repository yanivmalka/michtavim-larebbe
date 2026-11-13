// "Opening the book": a volume is chosen, the letter is put between two of its leaves, and the
// spread found there is the answer – the two facing pages, with the end of one letter, whole
// short letters and the beginning of the next, as the printed pages hold them.
//
// The printed page breaks come from the page maps (data/pages, see pageMap.js); the text itself
// comes from the online source and is drawn in our own layout. A volume without a map falls back
// to a simulated page: a random point inside a random letter, the page starting up to about one
// page-length before it, and the layout engine filling one book-sized page from there.
import { fetchLetter as defaultFetch, bodyOf } from './chabadlibrary.js';
import { blankPage, layout, spreadImage } from '../render/bookPage.js';
import {
  bodyText, hebrewNumeral, insideLetters, mappedPage, sliceBlocks, spreadPages, spreadsOf, textPages,
} from './pageMap.js';

/** Roughly how many characters fit on one rendered page – used only to pick a start point. */
export const PAGE_CHARS = 1500;

const lengthOf = (blocks) => blocks.reduce((n, b) => n + b.text.length + 1, 0);

/** Cuts a block list at character offset `at` (snapped forward to a word start). */
function sliceFrom(blocks, at) {
  let pos = 0;
  for (let b = 0; b < blocks.length; b++) {
    const len = blocks[b].text.length + 1;
    if (at < pos + len) {
      const off = at - pos;
      if (off === 0) return blocks.slice(b);
      const text = blocks[b].text;
      const space = text.indexOf(' ', off);
      const rest = space === -1 ? '' : text.slice(space + 1);
      return [...(rest ? [{ ...blocks[b], text: rest, continued: true }] : []), ...blocks.slice(b + 1)];
    }
    pos += len;
  }
  return [];
}

/**
 * A page is fully described by a small "spec" – volume, first letter, number of letters
 * and the character offset where the page starts – so its image can be drawn again at any
 * time (after a server restart, for sharing, for the full-screen view).
 * A page from a printed-page map is the spec ['m', volume, PDF page] instead, and a spread (the
 * two facing pages the book opens on) is ['s', volume, even printed number of the right-hand page].
 */
export const encodeSpec = (spec) => Buffer.from(JSON.stringify(
  spec.e !== undefined ? ['s', spec.v, spec.e]
    : spec.p !== undefined ? ['m', spec.v, spec.p] : [spec.v, spec.i, spec.n, spec.s],
)).toString('base64url');

export function decodeSpec(str, volumes) {
  try {
    const arr = JSON.parse(Buffer.from(String(str), 'base64url').toString());
    if (arr[0] === 's') {
      const [, v, e] = arr;
      return Number.isInteger(v) && volumes[v] && spreadPages(volumes[v], e) ? { v, e } : null;
    }
    if (arr[0] === 'm') {
      const [, v, p] = arr;
      return Number.isInteger(v) && Number.isInteger(p) && volumes[v] && mappedPage(volumes[v], p) ? { v, p } : null;
    }
    const [v, i, n, s] = arr;
    const ok = [v, i, n, s].every(Number.isInteger) && volumes[v] && i >= 0 && n >= 1 && n <= 12
      && i + n <= volumes[v].letters.length && s >= 0 && s < 500000;
    return ok ? { v, i, n, s } : null;
  } catch {
    return null;
  }
}

const FIT_SCALES = [1, 0.94, 0.88, 0.82, 0.76, 0.7, 0.64, 0.58];
const HEBREW_LETTER = /[\u05D0-\u05EA]/;

/**
 * One page from a flow of blocks, with the text made smaller (in steps) until every letter on it fits.
 * `truncated` is true only if the text does not fit even at the smallest size.
 */
function fitOnePage(flow, header) {
  const letters = [...new Set(flow.map((b) => b.letter))];
  let result;
  for (const scale of FIT_SCALES) {
    result = layout(flow, { header, maxPages: 1, scale });
    if (letters.every((k) => result.shown.get(k)?.complete)) return { ...result, truncated: false };
  }
  return { ...result, truncated: true };
}

/**
 * The running header of a printed page: the page number at the outer edge, as in the book
 * (even pages are on the right, odd pages on the left).
 */
function pageHeader(vol, printed) {
  const center = `אגרות קודש · ${vol.heading}`;
  if (!Number.isInteger(printed) || printed < 1) return { center };
  return printed % 2 === 0 ? { right: hebrewNumeral(printed), center } : { left: hebrewNumeral(printed), center };
}

/**
 * Draws a page of a printed-page map: the letters' text exactly as the page holds it.
 * Returns null when the map no longer matches the letters (their text changed), so the caller can
 * fall back to the simulated page.
 */
export async function renderMapped(volumes, spec, { fetchLetter = defaultFetch } = {}) {
  const vol = volumes[spec.v];
  const page = mappedPage(vol, spec.p);
  if (!page) return null;
  const flow = [];
  const parts = [];
  for (const seg of page.segments) {
    const [id, heading] = vol.letters[seg.i];
    const l = await fetchLetter(id);
    const text = bodyText(l.blocks);
    if (vol.pageMap.letters[seg.i]?.bodyLength !== text.length || seg.to > text.length) return null;
    const k = parts.length;
    const number = l.letterHeading || heading;
    // The maps count Hebrew letters only, so a range can stop short of punctuation, digits or
    // brackets at the very start or end of a letter: those belong to this page too.
    const from = HEBREW_LETTER.test(text.slice(0, seg.from)) ? seg.from : 0;
    const to = HEBREW_LETTER.test(text.slice(seg.to)) ? seg.to : text.length;
    const startsOnPage = from === 0;
    if (startsOnPage) flow.push({ kind: 'number', text: number, letter: k });
    for (const b of sliceBlocks(bodyOf(l.blocks), from, to)) flow.push({ ...b, letter: k });
    parts.push({ id, number, startsOnPage, endsOnPage: to >= text.length, full: l });
  }
  if (!flow.length) return null;

  const { pages, shown, truncated } = fitOnePage(flow, pageHeader(vol, page.printed));
  const letters = parts.map((p, k) => {
    const shownText = shown.get(k)?.text ?? '';
    return {
      id: p.id,
      number: p.number,
      viewerUrl: p.full.viewerUrl,
      startsOnPage: p.startsOnPage,
      endsOnPage: p.endsOnPage,
      pageText: p.startsOnPage ? shownText.split('\n').slice(1).join('\n') : shownText,
      full: p.full,
    };
  });
  return { volume: vol.volume, volumeHeading: vol.heading, png: pages[0], letters, spec: encodeSpec(spec), end: null, consumed: 0, truncated };
}

/**
 * Draws a spread: the two facing pages a letter lies between when it is put into the book.
 * `sides` describes each page (its own spec and image, or a blank page when the map has no text
 * for it). A letter that runs over the fold is listed once, with the text of both pages.
 * Returns null when a page cannot be drawn from the map any more.
 */
export async function renderSpread(volumes, spec, { fetchLetter = defaultFetch } = {}) {
  const vol = volumes[spec.v];
  const pair = spreadPages(vol, spec.e);
  if (!pair) return null;

  const sides = [];
  for (const [side, page, printed] of [['right', pair.right, spec.e], ['left', pair.left, spec.e + 1]]) {
    if (page) {
      const drawn = await renderMapped(volumes, { v: spec.v, p: page.pdf }, { fetchLetter });
      if (!drawn) return null;
      sides.push({ side, printed, spec: drawn.spec, png: drawn.png, letters: drawn.letters, truncated: drawn.truncated });
    } else {
      const note = insideLetters(vol, printed) ? 'הטקסט של עמוד זה אינו זמין' : '';
      sides.push({ side, printed, spec: null, png: blankPage(pageHeader(vol, printed), note), letters: [], truncated: false });
    }
  }

  const letters = [];
  for (const side of sides) {
    for (const l of side.letters) {
      const last = letters.at(-1);
      if (last && last.id === l.id) {
        last.pageText = `${last.pageText}\n${l.pageText}`;
        last.endsOnPage = l.endsOnPage;
      } else {
        letters.push({ ...l });
      }
    }
  }
  return {
    volume: vol.volume,
    volumeHeading: vol.heading,
    png: await spreadImage(sides[0].png, sides[1].png),
    letters,
    spec: encodeSpec(spec),
    sides: sides.map(({ side, printed, spec: s, png }) => ({ side, printed, spec: s, png })),
    end: null,
    consumed: 0,
    truncated: sides.some((s) => s.truncated),
  };
}

/** Draws the page described by `spec`. */
export async function renderSpec(volumes, spec, { fetchLetter = defaultFetch } = {}) {
  if (spec.e !== undefined) return renderSpread(volumes, spec, { fetchLetter });
  if (spec.p !== undefined) return renderMapped(volumes, spec, { fetchLetter });
  const vol = volumes[spec.v];
  const chain = await Promise.all(Array.from({ length: spec.n }, async (_, k) => {
    const [id, heading] = vol.letters[spec.i + k];
    const l = await fetchLetter(id);
    return { id, heading: l.letterHeading || heading, letter: l, body: bodyOf(l.blocks) };
  }));
  const start = spec.s;

  // the first letter from `start`, the others whole, each headed by its number
  const flow = [];
  chain.forEach((c, k) => {
    const blocks = k === 0 ? sliceFrom(c.body, start) : c.body;
    const fromTop = k > 0 || start === 0;
    if (fromTop) flow.push({ kind: 'number', text: c.heading, letter: k });
    for (const b of blocks) flow.push({ ...b, letter: k, continued: b.continued || (!fromTop && b === blocks[0]) });
  });

  const { pages, shown } = layout(flow, { header: { right: 'אגרות קודש', left: vol.heading }, maxPages: 1 });

  const letters = [];
  chain.forEach((c, k) => {
    const s = shown.get(k);
    if (!s) return;
    const fromTop = k > 0 || start === 0;
    letters.push({
      id: c.id,
      number: c.heading,
      viewerUrl: c.letter.viewerUrl,
      startsOnPage: fromTop,
      endsOnPage: s.complete,
      // the letter-number line is not part of the text
      pageText: fromTop ? s.text.split('\n').slice(1).join('\n') : s.text,
      full: c.letter,
    });
  });
  // where this page ends, and how much text it holds – for turning to the next / previous page
  let end = null;
  let consumed = 0;
  chain.forEach((c, k) => {
    const sh = shown.get(k);
    if (!sh) return;
    const fromTop = k > 0 || start === 0;
    const body = fromTop ? sh.text.split('\n').slice(1).join('\n') : sh.text;
    consumed += body.length + 1;
    end = sh.complete
      ? { i: spec.i + k + 1, s: 0 }
      : { i: spec.i + k, s: (k === 0 ? start : 0) + body.length + 1 };
  });

  return { volume: vol.volume, volumeHeading: vol.heading, png: pages[0], letters, spec: encodeSpec(spec), end, consumed };
}

/** Spec of a page starting at letter `i`, offset `s`, with enough letters after it to fill a page. */
async function specFrom(volumes, v, i, s, fetchLetter) {
  const vol = volumes[v];
  if (i >= vol.letters.length) return null;
  const len = async (k) => lengthOf(bodyOf((await fetchLetter(vol.letters[k][0])).blocks));
  let n = 1;
  let ahead = (await len(i)) - s;
  while (ahead < PAGE_CHARS * 2 && i + n < vol.letters.length) {
    ahead += await len(i + n);
    n += 1;
  }
  return { v, i, n, s: Math.max(0, s) };
}

/**
 * The page after (dir = 1) or before (dir = -1) the one described by `spec`, within its volume.
 * The previous page is estimated from how much text this page holds, so the two can overlap
 * by a line or two. Returns null at the start / end of the volume.
 */
export async function turnPage(volumes, spec, dir, { fetchLetter = defaultFetch } = {}) {
  if (spec.e !== undefined) {
    // spreads of a map: turning the leaf shows the next or previous two pages
    const spreads = spreadsOf(volumes[spec.v]);
    const at = spreads.indexOf(spec.e);
    const next = at === -1 ? undefined : spreads[at + dir];
    return next === undefined ? null : { v: spec.v, e: next };
  }
  if (spec.p !== undefined) {
    // printed pages of a map: the next or previous page with text, within the volume
    const pages = textPages(volumes[spec.v].pageMap);
    const at = pages.findIndex((p) => p.pdf === spec.p);
    const next = at === -1 ? undefined : pages[at + dir];
    return next ? { v: spec.v, p: next.pdf } : null;
  }
  const page = await renderSpec(volumes, spec, { fetchLetter });
  const vol = volumes[spec.v];
  if (dir > 0) {
    if (!page.end || page.end.i >= vol.letters.length) return null;
    return specFrom(volumes, spec.v, page.end.i, page.end.s, fetchLetter);
  }
  if (spec.i === 0 && spec.s === 0) return null;

  // Positions relative to the start of letter spec.i (negative = in earlier letters).
  const HEADER = 40; // the space a letter number takes, in characters
  const len = async (k) => lengthOf(bodyOf((await fetchLetter(vol.letters[k][0])).blocks)) + HEADER;
  const toRel = async (i, s) => {
    let rel = s;
    for (let k = i; k < spec.i; k++) rel -= await len(k);
    for (let k = spec.i; k < i; k++) rel += await len(k);
    return rel;
  };
  const fromRel = async (rel) => {
    let i = spec.i;
    while (rel < 0 && i > 0) { i -= 1; rel += await len(i); }
    return { i, s: Math.max(0, rel) };
  };

  // Guess a start one page-length back, then correct it until that page ends where this one starts.
  const target = spec.s;
  let guess = target - page.consumed;
  let best = null;
  for (let round = 0; round < 4; round++) {
    const at = await fromRel(guess);
    const candidate = await specFrom(volumes, spec.v, at.i, at.s, fetchLetter);
    const drawn = await renderSpec(volumes, candidate, { fetchLetter });
    const endRel = drawn.end ? await toRel(drawn.end.i, drawn.end.s) : target;
    best = candidate;
    const diff = target - endRel;
    if (Math.abs(diff) < 25 || (at.i === 0 && at.s === 0 && diff < 0)) break;
    guess += diff;
  }
  return best;
}

/**
 * Opens the book the way it is done by hand: a volume is taken off the shelf (every volume is
 * as likely as any other), and the letter is put between two of its leaves (every gap is as
 * likely as any other). The answer is the spread found there: the two facing pages.
 * A volume without a printed-page map opens on one simulated page instead.
 * @returns {Promise<{ volume: number, volumeHeading: string, png: Buffer, spec: string, sides?: object[],
 *   letters: { id, number, viewerUrl, startsOnPage: boolean, endsOnPage: boolean, pageText: string, full: object }[] }>}
 */
export async function openBook(volumes, { random = Math.random, fetchLetter = defaultFetch } = {}) {
  const shelf = volumes.map((_, k) => k).filter((k) => volumes[k].letters.length);
  if (!shelf.length) throw new Error('CATALOG_EMPTY');
  const v = shelf[Math.floor(random() * shelf.length)];
  const vol = volumes[v];

  const spreads = spreadsOf(vol);
  if (spreads.length) {
    const spread = await renderSpread(volumes, { v, e: spreads[Math.floor(random() * spreads.length)] }, { fetchLetter });
    if (spread) return spread;
  }

  // no map (or it no longer matches the letters): a simulated page around a random letter
  const pick = Math.floor(random() * vol.letters.length);

  const load = async (i) => {
    const l = await fetchLetter(vol.letters[i][0]);
    return { i, body: bodyOf(l.blocks) };
  };

  // 1. a random point inside the chosen letter, and a page start up to ~one page before it
  const anchor = await load(pick);
  const point = Math.floor(random() * Math.max(1, lengthOf(anchor.body)));
  const back = Math.floor(random() * PAGE_CHARS * 0.85);

  // 2. walk back into previous letters (same volume) if the page starts before this letter
  const chain = [anchor];
  let start = point - back;
  while (start < 0 && chain[0].i > 0) {
    const prev = await load(chain[0].i - 1);
    chain.unshift(prev);
    start += lengthOf(prev.body) + 40; // + the space a letter number takes
  }
  start = Math.max(0, start);

  // 3. walk forward until there is clearly more text than one page
  let ahead = chain.reduce((n, c) => n + lengthOf(c.body), 0) - start;
  while (ahead < PAGE_CHARS * 2 && chain.at(-1).i < vol.letters.length - 1) {
    const next = await load(chain.at(-1).i + 1);
    chain.push(next);
    ahead += lengthOf(next.body);
  }

  return renderSpec(volumes, { v, i: chain[0].i, n: chain.length, s: start }, { fetchLetter });
}
