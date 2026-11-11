import { randomUUID } from 'node:crypto';
import { loadCatalog } from './igrot/catalog.js';
import { openBook, renderSpec, decodeSpec, encodeSpec, turnPage } from './igrot/openBook.js';
import { fetchLetter } from './igrot/chabadlibrary.js';
import { layout, pngsToPdf } from './render/bookPage.js';
import { analyzePage, followUp, translateTexts, expandAcronyms } from './ai/index.js';

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

/** The letters of a drawn page, as the clients see them: the text on the page (same as the image) and the whole letter. */
const lettersOut = (page) => page.letters.filter((l) => l.pageText.trim()).map((l) => ({
  id: l.id,
  number: l.number,
  startsOnPage: l.startsOnPage,
  endsOnPage: l.endsOnPage,
  pageText: l.pageText,
  fullText: l.full.text,
  viewerUrl: l.viewerUrl,
  pdfPath: `/api/igrot/${l.id}.pdf`,
}));
const titleOf = (page, letters) => `אגרות קודש, ${page.volumeHeading}, אגרות ${letters.map((l) => l.number).join(', ')}`;

/**
 * The neighbouring page (dir 1 = next, -1 = previous) with its links and the text on it,
 * or null at the end of the volume.
 */
export async function getTurnedPage(specStr, dir, deps = {}) {
  const volumes = deps.volumes || getCatalog();
  const spec = decodeSpec(specStr, volumes);
  if (!spec) return undefined;
  const next = await turnPage(volumes, spec, dir, deps);
  if (!next) return null;
  const page = await renderSpec(volumes, next, deps);
  pageCache.set(page.spec, page.png);
  const letters = lettersOut(page);
  return {
    spec: page.spec, imagePath: `/api/page/${page.spec}.png`, pdfPath: `/api/page/${page.spec}.pdf`,
    volumeHeading: page.volumeHeading, title: titleOf(page, letters), letters,
  };
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
  const { volumes = getCatalog(), open = openBook, random } = deps;
  const trimmed = String(letter || '').trim();
  if (trimmed.length < 2) throw new Error('LETTER_EMPTY');
  if (trimmed.length > 8000) throw new Error('LETTER_TOO_LONG');

  const page = await open(volumes, { random });
  const letters = lettersOut(page);
  const title = titleOf(page, letters);
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
    letters,
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
  const letters = page.letters.filter((l) => l.pageText.trim());
  return { text: pageAsText(letters), title: `אגרות קודש, ${page.volumeHeading}, אגרות ${letters.map((l) => l.number).join(', ')}` };
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

const LANG = /^[a-z]{2}$/;
/**
 * Translates an analysis that was already written (explanation, page translation, key quote and the
 * answers to follow-up questions) to another language. Strings are returned in the same shape.
 */
export async function translateAnalysis({ language, explanation, translation, keyQuote, followups }, deps = {}) {
  if (!LANG.test(String(language || ''))) throw new Error('LANGUAGE_BAD');
  const answers = (Array.isArray(followups) ? followups : []).slice(0, 20).map((f) => clip(f?.a, 4000));
  const items = [clip(explanation, 8000), clip(translation, 16000), clip(keyQuote, 1000), ...answers];
  if (!items.some(Boolean)) throw new Error('NOTHING_TO_TRANSLATE');
  const run = deps.translate || translateTexts;
  const out = await run({ language, items });
  if (!Array.isArray(out) || out.length !== items.length) throw new Error('AI_EMPTY');
  const keep = (i) => (items[i] ? out[i] : '');
  return { replyLanguage: language, explanation: keep(0), translation: keep(1), keyQuote: keep(2), followups: answers.map((_, i) => keep(3 + i)) };
}

/** Expands abbreviations that the dictionary in the app does not know, in the context of the page. */
export async function acronyms({ spec, words }, deps = {}) {
  const list = [...new Set((Array.isArray(words) ? words : []).map((w) => clip(w, 30).trim()).filter(Boolean))].slice(0, 20);
  if (!list.length) throw new Error('QUESTION_EMPTY');
  const page = await pageForAi(spec, deps);
  const run = deps.acronyms || expandAcronyms;
  const items = await run({ context: page.text, words: list });
  return { items: list.map((word) => ({ word, options: (items.find((i) => i.word === word)?.options || []).slice(0, 3) })) };
}
