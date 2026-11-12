// Chooses the AI provider: AI_PROVIDER=gemini|claude, or whichever has a key (Gemini first).
import {
  explainAnswer, followUpClaude, translateClaude, acronymsClaude, readPhotoClaude, claudeAvailable, smallJsonClaude,
  SUMMARY_SYSTEM, summarySchema, SummarySchema, ARAMAIC_SYSTEM, aramaicSchema, AramaicSchema,
} from './explain.js';
import {
  explainWithGemini, followUpWithGemini, translateWithGemini, acronymsWithGemini, readPhotoWithGemini, transcribeWithGemini, geminiAvailable, generateJson,
} from './gemini.js';

export function provider() {
  const wanted = process.env.AI_PROVIDER;
  if (wanted === 'claude' || wanted === 'gemini') return wanted;
  if (geminiAvailable()) return 'gemini';
  if (claudeAvailable()) return 'claude';
  return null;
}

export async function analyzePage(input) {
  const p = provider();
  if (!p) throw new Error('AI_NOT_CONFIGURED');
  return { ...(p === 'gemini' ? await explainWithGemini(input) : await explainAnswer(input)), provider: p };
}

export async function followUp(input) {
  const p = provider();
  if (!p) throw new Error('AI_NOT_CONFIGURED');
  return { answer: p === 'gemini' ? await followUpWithGemini(input) : await followUpClaude(input), provider: p };
}

/** Translates strings to another language, keeping their order. */
export async function translateTexts(input) {
  const p = provider();
  if (!p) throw new Error('AI_NOT_CONFIGURED');
  return translateWith(p, input);
}
const translateWith = (p, input) => (p === 'gemini' ? translateWithGemini(input) : translateClaude(input));

/** Expands abbreviations (ראשי תיבות) in the context of the page. */
export async function expandAcronyms(input) {
  const p = provider();
  if (!p) throw new Error('AI_NOT_CONFIGURED');
  return p === 'gemini' ? acronymsWithGemini(input) : acronymsClaude(input);
}

/** The numbers printed on a photographed page. */
export async function readPagePhoto(input) {
  const p = provider();
  if (!p) throw new Error('AI_NOT_CONFIGURED');
  return p === 'gemini' ? readPhotoWithGemini(input) : readPhotoClaude(input);
}

/** Speech to text. Claude takes no audio, so this needs Gemini whatever the provider of the rest. */
export async function transcribeAudio(input) {
  if (!geminiAvailable()) throw new Error('VOICE_NOT_CONFIGURED');
  return transcribeWithGemini(input);
}

const smallJson = (input) => {
  const p = provider();
  if (!p) throw new Error('AI_NOT_CONFIGURED');
  return p === 'gemini' ? generateJson(input) : smallJsonClaude(input);
};

/** A name for the chat and a one-line summary of the letter. */
export async function summarizeLetter({ letter }) {
  return SummarySchema.parse(await smallJson({ system: SUMMARY_SYSTEM, schema: summarySchema, text: `המכתב:\n"""\n${letter}\n"""` }));
}

/** The Aramaic phrase around `word` in `sentence`, translated to `language`. */
export async function translateAramaic({ sentence, word, language }) {
  return AramaicSchema.parse(await smallJson({
    system: ARAMAIC_SYSTEM, schema: aramaicSchema,
    text: `שפת היעד: ${language}\n\nהמשפט:\n"""\n${sentence}\n"""\n\nהמילה שסומנה: ${JSON.stringify(word)}`,
  }));
}
