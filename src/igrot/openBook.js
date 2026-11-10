// "Opening the book": picks a random spot in a volume and builds the page found there –
// possibly the end of one letter, whole short letters, and the beginning of the next.
//
// The online source has the letters' text but not the printed page breaks, so the page is
// simulated: a random point is chosen inside a random letter, the page starts up to about
// one page-length before it, and the layout engine fills one book-sized page from there.
import { fetchLetter as defaultFetch, bodyOf } from './chabadlibrary.js';
import { layout } from '../render/bookPage.js';

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
 */
export const encodeSpec = ({ v, i, n, s }) => Buffer.from(JSON.stringify([v, i, n, s])).toString('base64url');
export function decodeSpec(str, volumes) {
  try {
    const [v, i, n, s] = JSON.parse(Buffer.from(String(str), 'base64url').toString());
    const ok = [v, i, n, s].every(Number.isInteger) && volumes[v] && i >= 0 && n >= 1 && n <= 12
      && i + n <= volumes[v].letters.length && s >= 0 && s < 500000;
    return ok ? { v, i, n, s } : null;
  } catch {
    return null;
  }
}

/** Draws the page described by `spec`. */
export async function renderSpec(volumes, spec, { fetchLetter = defaultFetch } = {}) {
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
  return { volume: vol.volume, volumeHeading: vol.heading, png: pages[0], letters, spec: encodeSpec(spec) };
}

/**
 * Opens the book at a random spot.
 * @returns {Promise<{ volume: number, volumeHeading: string, png: Buffer, spec: string,
 *   letters: { id, number, viewerUrl, startsOnPage: boolean, endsOnPage: boolean, pageText: string, full: object }[] }>}
 */
export async function openBook(volumes, { random = Math.random, fetchLetter = defaultFetch } = {}) {
  const total = volumes.reduce((n, v) => n + v.letters.length, 0);
  if (!total) throw new Error('CATALOG_EMPTY');
  let pick = Math.floor(random() * total);
  let v = 0;
  while (pick >= volumes[v].letters.length) pick -= volumes[v++].letters.length;
  const vol = volumes[v];

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
