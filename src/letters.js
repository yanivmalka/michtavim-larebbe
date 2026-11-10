import { randomUUID } from 'node:crypto';
import { loadVolumes, drawPage } from './igrot/catalog.js';
import { fetchPage } from './igrot/source.js';
import { explainAnswer } from './ai/explain.js';

const MAX_STORED = 500;
/** In-memory store of answered pages so the PDF can be served by id (web + WhatsApp). */
const answers = new Map();

export const getAnswerPdf = (id) => answers.get(id)?.pdf;

/**
 * The single entry point used by both the web app and the WhatsApp webhook.
 * deps can be overridden in tests.
 */
export async function answerLetter({ letter, replyLanguage }, deps = {}) {
  const { volumes = loadVolumes(), fetch: fetchFn = fetchPage, explain = explainAnswer, random } = deps;
  const trimmed = String(letter || '').trim();
  if (trimmed.length < 2) throw new Error('LETTER_EMPTY');
  if (trimmed.length > 8000) throw new Error('LETTER_TOO_LONG');

  const pick = drawPage(volumes, random);
  const { pdf, viewerUrl } = await fetchFn(pick);
  const ai = await explain({ letter: trimmed, pdf, replyLanguage, volume: pick.volume, page: pick.page });

  const id = randomUUID();
  answers.set(id, { pdf, at: Date.now() });
  if (answers.size > MAX_STORED) answers.delete(answers.keys().next().value);

  return {
    id,
    volume: pick.volume,
    page: pick.page,
    pdfPath: `/api/answers/${id}.pdf`,
    viewerUrl,
    ...ai,
  };
}
