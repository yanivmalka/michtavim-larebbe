import { randomUUID } from 'node:crypto';
import { loadCatalog, drawLetter } from './igrot/catalog.js';
import { fetchLetter } from './igrot/chabadlibrary.js';
import { renderLetterPdf } from './pdf/letterPdf.js';
import { explainAnswer } from './ai/explain.js';

const MAX_STORED = 500;
/** In-memory store of answered letters so the PDF can be served by id (web + WhatsApp). */
const answers = new Map();
let catalog;

export const getAnswerPdf = (id) => answers.get(id)?.pdf;

/**
 * The single entry point used by both the web app and the WhatsApp webhook.
 * deps can be overridden in tests.
 */
export async function answerLetter({ letter, replyLanguage }, deps = {}) {
  const {
    volumes = (catalog ??= loadCatalog()),
    fetch: fetchFn = fetchLetter,
    explain = explainAnswer,
    renderPdf = renderLetterPdf,
    random,
  } = deps;
  const trimmed = String(letter || '').trim();
  if (trimmed.length < 2) throw new Error('LETTER_EMPTY');
  if (trimmed.length > 8000) throw new Error('LETTER_TOO_LONG');

  const pick = drawLetter(volumes, random);
  const igeret = await fetchFn(pick.id);
  const meta = {
    ...igeret,
    volumeHeading: igeret.volumeHeading || pick.volumeHeading,
    letterHeading: igeret.letterHeading || pick.letterHeading,
  };
  const title = `אגרות קודש, ${meta.volumeHeading}, אגרת ${meta.letterHeading}`;
  const [pdf, ai] = await Promise.all([
    renderPdf(meta),
    explain({ letter: trimmed, igeret: meta.text, replyLanguage, title }),
  ]);

  const id = randomUUID();
  answers.set(id, { pdf, at: Date.now() });
  if (answers.size > MAX_STORED) answers.delete(answers.keys().next().value);

  return {
    id,
    volume: pick.volume,
    volumeHeading: meta.volumeHeading,
    letterNumber: meta.letterHeading,
    title,
    pdfPath: `/api/answers/${id}.pdf`,
    viewerUrl: meta.viewerUrl,
    original: meta.text,
    ...ai,
  };
}
