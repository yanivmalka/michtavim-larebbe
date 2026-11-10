import { randomUUID } from 'node:crypto';
import { loadCatalog } from './igrot/catalog.js';
import { openBook, renderSpec, decodeSpec, encodeSpec, turnPage } from './igrot/openBook.js';
import { fetchLetter } from './igrot/chabadlibrary.js';
import { layout, pngsToPdf } from './render/bookPage.js';
import { explainAnswer } from './ai/explain.js';

/** Small LRU of rendered page images (they can always be drawn again). */
const pageCache = {
  max: 200,
  map: new Map(),
  get(k) { const v = this.map.get(k); if (v) { this.map.delete(k); this.map.set(k, v); } return v; },
  set(k, v) { this.map.set(k, v); if (this.map.size > this.max) this.map.delete(this.map.keys().next().value); },
};
let catalog;
const getCatalog = () => (catalog ??= loadCatalog());

/** PNG of the page described by `spec`, drawn again if needed. null if the spec is invalid. */
export async function getPageImage(specStr, deps = {}) {
  const cached = pageCache.get(specStr);
  if (cached) return cached;
  const volumes = deps.volumes || getCatalog();
  const spec = decodeSpec(specStr, volumes);
  if (!spec) return null;
  const page = await renderSpec(volumes, spec, deps);
  pageCache.set(specStr, page.png);
  return page.png;
}

/** The neighbouring page (dir 1 = next, -1 = previous) as links, or null at the end of the volume. */
export async function getTurnedPage(specStr, dir, deps = {}) {
  const volumes = deps.volumes || getCatalog();
  const spec = decodeSpec(specStr, volumes);
  if (!spec) return undefined;
  const next = await turnPage(volumes, spec, dir, deps);
  if (!next) return null;
  const s = encodeSpec(next);
  return { spec: s, imagePath: `/api/page/${s}.png`, pdfPath: `/api/page/${s}.pdf`, volumeHeading: volumes[next.v].heading };
}

export async function getPagePdf(specStr, deps = {}) {
  const png = await getPageImage(specStr, deps);
  if (!png) return null;
  const volumes = deps.volumes || getCatalog();
  return pngsToPdf([png], `אגרות קודש, ${volumes[decodeSpec(specStr, volumes).v].heading}`);
}

/** The full text of one letter, rendered on as many pages as it needs. */
export async function getLetterPdf(id, deps = {}) {
  const volumes = deps.volumes || getCatalog();
  const vol = volumes.find((v) => v.letters.some(([lid]) => lid === id));
  if (!vol) return null;
  const l = await (deps.fetchLetter || fetchLetter)(id);
  const number = l.letterHeading || vol.letters.find(([lid]) => lid === id)[1];
  const flow = [{ kind: 'number', text: number, letter: 0 }, ...l.blocks.map((b) => ({ ...b, letter: 0 }))];
  const { pages } = layout(flow, {
    header: { right: `אגרות קודש · אגרת ${number}`, left: vol.heading },
    footer: (i, count) => `מקור: ספריית ליובאוויטש · ${l.viewerUrl}${count > 1 ? ` · ${i + 1}/${count}` : ''}`,
  });
  return pngsToPdf(pages, `אגרות קודש, ${vol.heading}, אגרת ${number}`);
}

/** What Claude reads: the page as it opened, letter by letter. */
export function pageAsText(letters) {
  return letters.map((l) => {
    const notes = [!l.startsOnPage && 'ההתחלה בעמוד הקודם', !l.endsOnPage && 'ההמשך בעמוד הבא'].filter(Boolean);
    return `=== אגרת ${l.number}${notes.length ? ` (${notes.join('; ')})` : ''} ===\n${l.pageText}`;
  }).join('\n\n');
}

/**
 * The single entry point used by both the web app and the WhatsApp webhook.
 * deps can be overridden in tests.
 */
export async function answerLetter({ letter, replyLanguage }, deps = {}) {
  const { volumes = getCatalog(), open = openBook, explain = explainAnswer, random } = deps;
  const trimmed = String(letter || '').trim();
  if (trimmed.length < 2) throw new Error('LETTER_EMPTY');
  if (trimmed.length > 8000) throw new Error('LETTER_TOO_LONG');

  const page = await open(volumes, { random });
  const letters = page.letters.filter((l) => l.pageText.trim());
  const title = `אגרות קודש, ${page.volumeHeading}, אגרות ${letters.map((l) => l.number).join(', ')}`;
  // The page itself never depends on Claude: if the explanation is unavailable
  // (no key, no credit, outage) the answer is still returned, without it.
  let ai;
  try {
    ai = { ...(await explain({ letter: trimmed, igeret: pageAsText(letters), replyLanguage, title })), explained: true };
  } catch (err) {
    console.warn('explanation unavailable:', err?.status || '', err?.message || err);
    ai = { explained: false, sourceLanguage: null, replyLanguage: replyLanguage || null, translation: '', explanation: '', keyQuote: '' };
  }

  const id = randomUUID();
  pageCache.set(page.spec, page.png);

  return {
    id,
    volume: page.volume,
    volumeHeading: page.volumeHeading,
    title,
    // stable links: the page can always be drawn again from its spec
    imagePath: `/api/page/${page.spec}.png`,
    pdfPath: `/api/page/${page.spec}.pdf`,
    letters: letters.map((l) => ({
      id: l.id,
      number: l.number,
      startsOnPage: l.startsOnPage,
      endsOnPage: l.endsOnPage,
      pageText: l.pageText,
      fullText: l.full.text,
      viewerUrl: l.viewerUrl,
      pdfPath: `/api/igrot/${l.id}.pdf`,
    })),
    ...ai,
  };
}

let positions;
/**
 * The letter `offset` places away from letter `id` in book order (‑1 = previous, 1 = next),
 * for paging beyond the letters of the opened page. Returns null at the ends of the book.
 */
export async function getNeighborLetter(id, offset, deps = {}) {
  const { volumes = getCatalog(), fetch: fetchFn = fetchLetter } = deps;
  const flat = deps.volumes ? null : positions;
  const list = flat || volumes.flatMap((v) => v.letters.map(([lid, heading]) => ({ id: lid, heading, volumeHeading: v.heading })));
  if (!deps.volumes) positions = list;
  const at = list.findIndex((l) => l.id === id);
  if (at === -1) return undefined;
  const target = list[at + offset];
  if (!target) return null;
  const l = await fetchFn(target.id);
  return {
    id: target.id,
    number: l.letterHeading || target.heading,
    volumeHeading: l.volumeHeading || target.volumeHeading,
    fullText: l.text,
    viewerUrl: l.viewerUrl,
  };
}
