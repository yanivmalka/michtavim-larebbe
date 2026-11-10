// Client for the Igrot Kodesh text on chabadlibrary.org (ספריית ליובאוויטש).
const BASE = process.env.CHABADLIBRARY_BASE || 'https://chabadlibrary.org/books';
export const IGROT_SECTION_ID = 1200000000; // ספרי כ"ק אדמו"ר ← אגרות קודש
const UA = 'michtavim-larebbe/0.2 (+https://github.com/yanivmalka/michtavim-larebbe)';

export const viewerUrl = (id) => `${BASE}/${id}`;

async function main(path, fetchFn = fetch) {
  const res = await fetchFn(`${BASE}/api/main?path=${encodeURIComponent(path)}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`SOURCE_HTTP_${res.status}`);
  const body = await res.json();
  if (!body?.content) throw new Error('SOURCE_BAD_RESPONSE');
  return body.content;
}

/** [{ id, heading: 'כרך א' }, ...] */
export async function listVolumes(fetchFn) {
  const c = await main(IGROT_SECTION_ID, fetchFn);
  return c.data.map(({ id, heading }) => ({ id, heading }));
}

/** [{ id, heading: 'קסט' }, ...] – the letters of one volume, by their number. */
export async function listLetters(volumeId, fetchFn) {
  const c = await main(volumeId, fetchFn);
  return c.data.map(({ id, heading }) => ({ id, heading }));
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&(\w+);/g, (m, n) => ENTITIES[n] ?? m);

/**
 * Turns the letter HTML into blocks: { kind, text } where kind is one of
 * date | city | address | text | signature | note | footnote.
 */
export function parseLetterHtml(html) {
  const blocks = [];
  let pages = [];
  const re = /<(p|div|h\d)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  let inFootnotes = false;
  while ((m = re.exec(html))) {
    const cls = (m[2].match(/class=["']?([\w-]+)/) || [])[1] || '';
    const text = decode(m[3].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
      .replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
    if (!text) continue;
    if (cls === 'pagenumber') { pages.push(text); continue; }
    if (/comment_number/.test(cls)) { inFootnotes = true; continue; }
    const kind = inFootnotes ? 'footnote'
      : /bsd/.test(cls) ? 'date'
        : /city/.test(cls) ? 'city'
          : /address/.test(cls) ? 'address'
            : /signature/.test(cls) ? 'signature'
              : 'text';
    blocks.push({ kind, text });
  }
  return { blocks, pages };
}

export const blocksToText = (blocks) => blocks
  .map((b) => (b.kind === 'footnote' ? `[הערה] ${b.text}` : b.text)).join('\n\n');

/** Fetches one letter. */
export async function fetchLetter(id, fetchFn) {
  const c = await main(id, fetchFn);
  if (c.type !== 'page' || typeof c.data?.text !== 'string') throw new Error('SOURCE_BAD_RESPONSE');
  const { blocks, pages } = parseLetterHtml(c.data.text);
  if (!blocks.length) throw new Error('SOURCE_EMPTY_LETTER');
  const tree = c.tree || [];
  return {
    id,
    volumeHeading: tree.at(-2)?.heading || '',
    letterHeading: tree.at(-1)?.heading || '',
    pages,
    blocks,
    text: blocksToText(blocks),
    viewerUrl: viewerUrl(id),
  };
}
