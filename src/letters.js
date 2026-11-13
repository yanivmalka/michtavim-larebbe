import { randomUUID } from 'node:crypto';
import { loadCatalog } from './igrot/catalog.js';
import { attachPageMaps, hebrewNumeral, loadPageMaps, spreadPages } from './igrot/pageMap.js';
import { openBook, renderSpec, decodeSpec, encodeSpec, turnPage } from './igrot/openBook.js';
import { fetchLetter } from './igrot/chabadlibrary.js';
import { layout, pngsToPdf } from './render/bookPage.js';
import { analyzePage, followUp } from './ai/index.js';

/** Small LRU of rendered page images (they can always be drawn again). */
const pageCache = {
  max: 200,
  map: new Map(),
  get(k) { const v = this.map.get(k); if (v) { this.map.delete(k); this.map.set(k, v); } return v; },
  set(k, v) { this.map.set(k, v); if (this.map.size > this.max) this.map.delete(this.map.keys().next().value); },
};
let catalog;
const getCatalog = () => (catalog ??= attachPageMaps(loadCatalog(), loadPageMaps()));

/** PNG of the page described by `spec`, drawn again if needed. null if the spec is invalid. */
export async function getPageImage(specStr, deps = {}) {
  const cached = pageCache.get(specStr);
  if (cached) return cached;
  const volumes = deps.volumes || getCatalog();
  const spec = decodeSpec(specStr, volumes);
  if (!spec) return null;
  const page = await renderSpec(volumes, spec, deps);
  if (!page) return null;
  pageCache.set(specStr, page.png);
  return page.png;
}

const pageLinks = (s) => ({ spec: s, imagePath: `/api/page/${s}.png`, pdfPath: `/api/page/${s}.pdf` });

/**
 * The pages of a spread that have text, right-hand page first, each with its own image link –
 * for showing one page at a time on a narrow screen. Undefined for a spec that is not a spread.
 */
function sidesOf(volumes, spec) {
  if (spec.e === undefined) return undefined;
  const pair = spreadPages(volumes[spec.v], spec.e);
  return [['right', pair.right], ['left', pair.left]].filter(([, page]) => page).map(([side, page]) => ({
    side,
    printed: page.printed,
    imagePath: `/api/page/${encodeSpec({ v: spec.v, p: page.pdf })}.png`,
  }));
}

/** "עמ' רלו–רלז" for a spread, from the printed numbers of its pages. */
const pagesLabel = (sides) => (sides?.length ? `עמ' ${sides.map((s) => hebrewNumeral(s.printed)).join('–')}` : '');

/** The neighbouring page (dir 1 = next, -1 = previous) as links, or null at the end of the volume. */
export async function getTurnedPage(specStr, dir, deps = {}) {
  const volumes = deps.volumes || getCatalog();
  const spec = decodeSpec(specStr, volumes);
  if (!spec) return undefined;
  const next = await turnPage(volumes, spec, dir, deps);
  if (!next) return null;
  const sides = sidesOf(volumes, next);
  return { ...pageLinks(encodeSpec(next)), volumeHeading: volumes[next.v].heading, ...(sides && { sides }) };
}

export async function getPagePdf(specStr, deps = {}) {
  const volumes = deps.volumes || getCatalog();
  const spec = decodeSpec(specStr, volumes);
  if (!spec) return null;
  // a spread becomes two PDF pages (right-hand page first), each at full size
  const sides = sidesOf(volumes, spec);
  const specs = sides ? sides.map((s) => /\/api\/page\/([\w-]+)\.png$/.exec(s.imagePath)[1]) : [specStr];
  const pngs = [];
  for (const s of specs) {
    const png = await getPageImage(s, deps);
    if (!png) return null;
    pngs.push(png);
  }
  return pngsToPdf(pngs, ['אגרות קודש', volumes[spec.v].heading, pagesLabel(sides)].filter(Boolean).join(', '));
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
  const { volumes = getCatalog(), open = openBook, random } = deps;
  const trimmed = String(letter || '').trim();
  if (trimmed.length < 2) throw new Error('LETTER_EMPTY');
  if (trimmed.length > 8000) throw new Error('LETTER_TOO_LONG');

  const page = await open(volumes, { random });
  const letters = page.letters.filter((l) => l.pageText.trim());
  const spec = decodeSpec(page.spec, volumes);
  const sides = spec ? sidesOf(volumes, spec) : undefined;
  const title = ['אגרות קודש', page.volumeHeading, pagesLabel(sides), `אגרות ${letters.map((l) => l.number).join(', ')}`]
    .filter(Boolean).join(', ');
  // The explanation is made only on request (POST /api/analysis), not here.
  const ai = { explained: false, replyLanguage: replyLanguage || null };

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
    // a spread: its pages one by one (right-hand page first), for narrow screens
    ...(sides && { sides }),
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

// ---------- explanation and follow-up questions, on request ----------
const clip = (str, n) => String(str || '').slice(0, n);

/** The text of the page described by `specStr`, as the AI reads it. */
async function pageForAi(specStr, deps) {
  const volumes = deps.volumes || getCatalog();
  const spec = decodeSpec(specStr, volumes);
  if (!spec) throw new Error('PAGE_NOT_FOUND');
  const page = await renderSpec(volumes, spec, deps);
  if (!page) throw new Error('PAGE_NOT_FOUND');
  const letters = page.letters.filter((l) => l.pageText.trim());
  const sides = sidesOf(volumes, spec);
  const intro = sides ? 'המכתב הונח בין שני עמודים פונים של הספר. להלן הטקסט של שניהם ברצף: העמוד הימני ואחריו השמאלי.\n\n' : '';
  const title = ['אגרות קודש', page.volumeHeading, pagesLabel(sides), `אגרות ${letters.map((l) => l.number).join(', ')}`]
    .filter(Boolean).join(', ');
  return { text: intro + pageAsText(letters), title };
}

export async function analyze({ spec, letter, replyLanguage }, deps = {}) {
  const q = String(letter || '').trim();
  if (q.length < 2) throw new Error('LETTER_EMPTY');
  const page = await pageForAi(spec, deps);
  const run = deps.analyze || analyzePage;
  return run({ letter: clip(q, 8000), igeret: page.text, replyLanguage, title: page.title });
}

export async function askFollowUp({ spec, letter, analysis, history, question }, deps = {}) {
  const q = String(question || '').trim();
  if (q.length < 2) throw new Error('QUESTION_EMPTY');
  const page = await pageForAi(spec, deps);
  const context = [
    `${page.title}:\n\"\"\"\n${page.text}\n\"\"\"`,
    `המכתב שנכתב לרבי:\n\"\"\"\n${clip(letter, 8000)}\n\"\"\"`,
    analysis?.translation ? `התרגום שנכתב:\n${clip(analysis.translation, 12000)}` : '',
    `הניתוח שנכתב:\n${clip(analysis?.explanation, 6000)}`,
  ].filter(Boolean).join('\n\n');
  const past = (Array.isArray(history) ? history : []).slice(-10).map((h) => ({ q: clip(h?.q, 2000), a: clip(h?.a, 4000) }));
  const run = deps.followUp || followUp;
  return run({ context, history: past, question: clip(q, 2000) });
}
