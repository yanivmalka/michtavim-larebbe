import { randomUUID } from 'node:crypto';
import { loadCatalog } from './igrot/catalog.js';
import { openBook, renderSpec, decodeSpec, encodeSpec, turnPage, specFrom } from './igrot/openBook.js';
import { findLetter, findVolume } from './igrot/letterNumbers.js';
import { fetchLetter } from './igrot/chabadlibrary.js';
import { layout, pngsToPdf, drawHighlights } from './render/bookPage.js';
import { findQuote, stripForeignScript, parseHighlights } from './highlights.js';
import { analyzePage, followUp, translateTexts, expandAcronyms, readPagePhoto, transcribeAudio } from './ai/index.js';

/** Small LRU of rendered page images (they can always be drawn again). */
const pageCache = {
  max: 200,
  map: new Map(),
  get(k) { const v = this.map.get(k); if (v) { this.map.delete(k); this.map.set(k, v); } return v; },
  set(k, v) { this.map.set(k, v); if (this.map.size > this.max) this.map.delete(this.map.keys().next().value); },
};
let catalog;
const getCatalog = () => (catalog ??= loadCatalog());

/** The drawn page (PNG + where every word sits), drawn again if needed. null if the spec is invalid. */
async function pageData(specStr, deps = {}) {
  const cached = pageCache.get(specStr);
  if (cached) return cached;
  const volumes = deps.volumes || getCatalog();
  const spec = decodeSpec(specStr, volumes);
  if (!spec) return null;
  const page = await renderSpec(volumes, spec, deps);
  return remember(page);
}
const remember = (page) => { const data = { png: page.png, boxes: page.boxes || [] }; pageCache.set(page.spec, data); return data; };

/**
 * PNG of the page described by `spec`. With `hl` ("<letter id>:<start>-<end>,…;…", offsets in the
 * letters' page text) the quoted words are marked on the image, as with a highlighter.
 */
export async function getPageImage(specStr, deps = {}, hl = '') {
  const data = await pageData(specStr, deps);
  if (!data) return null;
  const wanted = hl ? parseHighlights(hl) : null;
  if (!wanted) return data.png;
  const boxes = data.boxes.filter((b) => wanted.some((h) => h.id === b.id && h.ranges.some(([s, e]) => b.s < e && b.e > s)));
  if (!boxes.length) return data.png;
  const key = `${specStr}?${hl}`;
  const cached = pageCache.get(key);
  if (cached) return cached.png;
  const png = await drawHighlights(data.png, boxes);
  pageCache.set(key, { png, boxes: [] });
  return png;
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
  remember(page);
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
  remember(page);

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

// ---------- a photo of a printed page, and a letter dictated by voice ----------
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const base64Of = (data, max, code) => {
  const b = String(data || '').replace(/^data:[^,]*,/, '');
  if (!b || b.length > max || !/^[A-Za-z0-9+/=\s]+$/.test(b)) throw new Error(code);
  return b.replace(/\s/g, '');
};

/**
 * A photo of a page of Igrot Kodesh: the AI reads only the numbers on it (letter numbers, page, volume),
 * and the letters themselves are taken from the library – so the text is exact, not read off the photo.
 */
export async function answerPhoto({ image, mimeType }, deps = {}) {
  const volumes = deps.volumes || getCatalog();
  const type = String(mimeType || 'image/jpeg').toLowerCase();
  if (!IMAGE_TYPES.has(type)) throw new Error('PHOTO_BAD');
  const data = base64Of(image, 8_000_000, 'PHOTO_BAD');
  const read = await (deps.readPhoto || readPagePhoto)({ data, mimeType: type });
  if (!read.isIgrot) throw new Error('PHOTO_NOT_IGROT');
  if (!read.readable || !read.letters.length) throw new Error('PHOTO_UNREADABLE');

  const vWanted = findVolume(volumes, read.volume);
  let found = read.letters.map((n) => ({ n, at: findLetter(volumes, n) })).filter((f) => f.at);
  // a misread digit could point to another volume: the volume printed on the page decides
  if (vWanted >= 0 && found.some((f) => f.at.v === vWanted)) found = found.filter((f) => f.at.v === vWanted);
  if (!found.length) throw new Error('PHOTO_NOT_FOUND');
  const first = found[0].at;
  const sameVol = found.filter((f) => f.at.v === first.v && f.at.i >= first.i && f.at.i - first.i < 12);
  const last = Math.max(...sameVol.map((f) => f.at.i));

  const fill = await specFrom(volumes, first.v, first.i, 0, deps.fetchLetter || fetchLetter);
  const spec = { ...fill, n: Math.min(12, Math.max(fill.n, last - first.i + 1), volumes[first.v].letters.length - first.i) };
  const page = await renderSpec(volumes, spec, deps);
  remember(page);
  const letters = lettersOut(page);
  return {
    id: randomUUID(),
    volume: page.volume,
    volumeHeading: page.volumeHeading,
    title: titleOf(page, letters),
    imagePath: `/api/page/${page.spec}.png`,
    pdfPath: `/api/page/${page.spec}.pdf`,
    letters,
    explained: false,
    replyLanguage: null,
    // what was read off the photo, as printed
    photo: {
      volume: read.volume || '', page: read.page || '', letters: sameVol.map((f) => f.n), continuesFromPrevious: !!read.continuesFromPrevious,
    },
  };
}

const AUDIO_TYPE = /^audio\/(webm|ogg|mp4|mpeg|mp3|aac|wav|x-wav|3gpp|amr)(;.*)?$/;
/** A letter dictated by voice → its text. */
export async function transcribe({ audio, mimeType }, deps = {}) {
  const type = String(mimeType || '').toLowerCase();
  if (!AUDIO_TYPE.test(type)) throw new Error('VOICE_BAD');
  const data = base64Of(audio, 4_000_000, 'VOICE_BAD');
  const text = stripForeignScript(await (deps.transcribe || transcribeAudio)({ data, mimeType: type.split(';')[0] }));
  if (!text.trim()) throw new Error('VOICE_EMPTY');
  return { text: clip(text.trim(), 8000) };
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
  remember(page);
  const letters = page.letters.filter((l) => l.pageText.trim());
  return { spec: page.spec, letters, text: pageAsText(letters), title: `אגרות קודש, ${page.volumeHeading}, אגרות ${letters.map((l) => l.number).join(', ')}` };
}

/**
 * The quotes the explanation rests on, found in the letters of the page: one item per letter,
 * with flat [start, end, start, end, …] offsets in its pageText (flat, so it can be stored in Firestore).
 */
export function highlightsFor(page, sources) {
  const quotes = (Array.isArray(sources) ? sources : []).map((q) => String(q || '').trim()).filter(Boolean).slice(0, 12);
  const byLetter = new Map();
  let found = 0;
  for (const quote of quotes) {
    for (const l of page.letters) {
      const r = findQuote(l.pageText, quote);
      if (!r) continue;
      byLetter.set(l.id, [...(byLetter.get(l.id) || []), ...r]);
      found += 1;
      break;
    }
  }
  const highlights = [...byLetter].map(([id, r]) => ({ spec: page.spec, id, r }));
  return { highlights, sourcesFound: found, sourcesTotal: quotes.length };
}

export async function analyze({ spec, letter, replyLanguage }, deps = {}) {
  const q = String(letter || '').trim();
  if (q.length < 2) throw new Error('LETTER_EMPTY');
  const page = await pageForAi(spec, deps);
  const run = deps.analyze || analyzePage;
  const { sources, ...out } = await run({ letter: clip(q, 8000), igeret: page.text, replyLanguage, title: page.title });
  for (const k of ['translation', 'explanation', 'keyQuote']) if (typeof out[k] === 'string') out[k] = stripForeignScript(out[k]);
  return { ...out, ...highlightsFor(page, sources) };
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
  const out = await run({ context, history: past, question: clip(q, 2000) });
  return { ...out, answer: stripForeignScript(out.answer) };
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
  const keep = (i) => (items[i] ? stripForeignScript(out[i]) : '');
  return { replyLanguage: language, explanation: keep(0), translation: keep(1), keyQuote: keep(2), followups: answers.map((_, i) => keep(3 + i)) };
}

/**
 * Expands abbreviations that the dictionary in the app does not know, in context: the sentence they
 * were tapped in (`sentence`, sent by the app), or else the whole page.
 */
export async function acronyms({ spec, words, sentence }, deps = {}) {
  const list = [...new Set((Array.isArray(words) ? words : []).map((w) => clip(w, 30).trim()).filter(Boolean))].slice(0, 20);
  if (!list.length) throw new Error('QUESTION_EMPTY');
  const context = typeof sentence === 'string' && sentence.trim().length >= 3 ? clip(sentence.trim(), 1500) : (await pageForAi(spec, deps)).text;
  const run = deps.acronyms || expandAcronyms;
  const items = await run({ context, words: list });
  return { items: list.map((word) => ({ word, options: (items.find((i) => i.word === word)?.options || []).slice(0, 3) })) };
}
