import { randomUUID } from 'node:crypto';
import { loadCatalog } from './igrot/catalog.js';
import { openBook } from './igrot/openBook.js';
import { layout, pngsToPdf } from './render/bookPage.js';
import { explainAnswer } from './ai/explain.js';

const MAX_STORED = 300;
/** Answers kept in memory so their image/PDFs can be served by id (web + WhatsApp). */
const answers = new Map();
let catalog;

function remember(id, entry) {
  answers.set(id, entry);
  if (answers.size > MAX_STORED) answers.delete(answers.keys().next().value);
}

export const getPagePng = (id) => answers.get(id)?.png;

export async function getPagePdf(id) {
  const a = answers.get(id);
  if (!a) return null;
  a.pdf ??= await pngsToPdf([a.png], a.title);
  return a.pdf;
}

/** The full text of one letter from the page, rendered on as many pages as it needs. */
export async function getLetterPdf(id, n) {
  const l = answers.get(id)?.letters[n];
  if (!l) return null;
  if (!l.pdf) {
    const flow = [{ kind: 'number', text: l.number, letter: 0 }, ...l.full.blocks.map((b) => ({ ...b, letter: 0 }))];
    const { pages } = layout(flow, {
      header: { right: `אגרות קודש · אגרת ${l.number}`, left: answers.get(id).volumeHeading },
      footer: (i, count) => `מקור: ספריית ליובאוויטש · ${l.viewerUrl}${count > 1 ? ` · ${i + 1}/${count}` : ''}`,
    });
    l.pdf = await pngsToPdf(pages, `אגרות קודש, ${answers.get(id).volumeHeading}, אגרת ${l.number}`);
  }
  return l.pdf;
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
  const { volumes = (catalog ??= loadCatalog()), open = openBook, explain = explainAnswer, random } = deps;
  const trimmed = String(letter || '').trim();
  if (trimmed.length < 2) throw new Error('LETTER_EMPTY');
  if (trimmed.length > 8000) throw new Error('LETTER_TOO_LONG');

  const page = await open(volumes, { random });
  const letters = page.letters.filter((l) => l.pageText.trim());
  const title = `אגרות קודש, ${page.volumeHeading}, אגרות ${letters.map((l) => l.number).join(', ')}`;
  const ai = await explain({ letter: trimmed, igeret: pageAsText(letters), replyLanguage, title });

  const id = randomUUID();
  remember(id, { png: page.png, title, volumeHeading: page.volumeHeading, letters });

  return {
    id,
    volume: page.volume,
    volumeHeading: page.volumeHeading,
    title,
    imagePath: `/api/answers/${id}/page.png`,
    pdfPath: `/api/answers/${id}/page.pdf`,
    letters: letters.map((l, n) => ({
      number: l.number,
      startsOnPage: l.startsOnPage,
      endsOnPage: l.endsOnPage,
      pageText: l.pageText,
      fullText: l.full.text,
      viewerUrl: l.viewerUrl,
      pdfPath: `/api/answers/${id}/letters/${n}.pdf`,
    })),
    ...ai,
  };
}
