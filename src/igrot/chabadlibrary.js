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

const clean = (html) => decode(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
  .replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();

// Two markup generations exist on the site: igroys_* classes (volumes 1–26) and
// <p class=bodytext><div class=…> (later volumes).
function kindOf(cls) {
  if (/bsd|^bh$/.test(cls)) return 'date';
  if (/city|brooklyn/.test(cls)) return 'city';
  if (/address|lichvod/.test(cls)) return 'address';
  if (/signature/.test(cls)) return 'signature';
  if (/comment(?!_number)/.test(cls)) return 'note';
  return 'text';
}

/**
 * Turns the letter HTML into blocks: { kind, text } where kind is one of
 * date | city | address | text | signature | note (editorial note / footnote).
 */
export function parseLetterHtml(html, haoros = '') {
  const blocks = [];
  const pages = [];
  const flat = html.replace(/<p\b[^>]*>\s*(<div\b[^>]*>[\s\S]*?<\/div>)\s*<\/p>/gi, '$1');
  const re = /<(p|div|h\d)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  let inNotes = false;
  while ((m = re.exec(flat))) {
    const cls = (m[2].match(/class=["']?([\w-]+)/) || [])[1] || '';
    const text = clean(m[3]);
    if (!text) continue;
    if (cls === 'pagenumber') { pages.push(text); continue; }
    if (/comment_number/.test(cls)) { inNotes = true; continue; }
    blocks.push({ kind: inNotes ? 'note' : kindOf(cls), text });
  }
  const notes = haoros.replace(/<div class=oysbehaoro>[\s\S]*?<\/div>/gi, '');
  for (const [, inner] of notes.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = clean(inner);
    if (text) blocks.push({ kind: 'note', text });
  }
  return { blocks, pages };
}

export const bodyOf = (blocks) => blocks.filter((b) => b.kind !== 'note');

export const blocksToText = (blocks) => blocks
  .map((b) => (b.kind === 'note' ? `[הערה] ${b.text}` : b.text)).join('\n\n');

const cache = new Map();
const CACHE_MAX = 3000;

/** Fetches one letter. */
export async function fetchLetter(id, fetchFn) {
  if (!fetchFn && cache.has(id)) return cache.get(id);
  const c = await main(id, fetchFn);
  if (c.type !== 'page' || typeof c.data?.text !== 'string') throw new Error('SOURCE_BAD_RESPONSE');
  const { blocks, pages } = parseLetterHtml(c.data.text, c.data.haoros || '');
  if (!blocks.length) throw new Error('SOURCE_EMPTY_LETTER');
  const tree = c.tree || [];
  const letter = {
    id,
    volumeHeading: tree.at(-2)?.heading || '',
    letterHeading: tree.at(-1)?.heading || '',
    pages,
    blocks,
    text: blocksToText(blocks),
    viewerUrl: viewerUrl(id),
  };
  if (!fetchFn) {
    cache.set(id, letter);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return letter;
}
