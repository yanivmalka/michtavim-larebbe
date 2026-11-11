// Gemini (Google AI Studio) – translation, explanation and follow-up questions.
import { GoogleGenAI } from '@google/genai';
import {
  SYSTEM, FOLLOWUP_SYSTEM, TRANSLATE_SYSTEM, ACRONYM_SYSTEM, jsonSchema, AnswerSchema, translateSchema, TranslateSchema, acronymSchema, AcronymSchema,
} from './explain.js';

export const geminiAvailable = () => Boolean(process.env.GEMINI_API_KEY);

/**
 * Models to try, in order. On the free tier a model is often "experiencing high demand"
 * (503) or out of quota (429), so the next one is tried instead of waiting.
 * GEMINI_MODELS overrides the list (comma-separated); GEMINI_MODEL puts one model first.
 */
export function modelChain() {
  const list = (process.env.GEMINI_MODELS || 'gemini-flash-latest,gemini-flash-lite-latest,gemini-2.5-flash,gemini-2.5-flash-lite')
    .split(',').map((m) => m.trim()).filter(Boolean);
  const first = process.env.GEMINI_MODEL;
  return first ? [first, ...list.filter((m) => m !== first)] : list;
}

let client;
const getClient = () => (client ??= new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  // one attempt of at most 40 s per model – the fallback below replaces the SDK's long retries
  httpOptions: { timeout: 40000, retryOptions: { attempts: 1 } },
}));

const RETRYABLE = new Set([404, 429, 500, 503, 504]);
/** Runs `call(model)` on each model in turn until one answers. */
export async function withFallback(call, models = modelChain()) {
  let lastError;
  for (const model of models) {
    try {
      return await call(model);
    } catch (err) {
      lastError = err;
      const status = Number(err?.status);
      const timedOut = err?.name === 'AbortError' || /timeout|timed out|aborted/i.test(err?.message || '');
      if (!RETRYABLE.has(status) && !timedOut) throw err;
      console.warn(`gemini: ${model} unavailable (${status || 'timeout'}), trying the next model`);
    }
  }
  throw lastError;
}

// Gemini's schema dialect has no additionalProperties
const geminiSchema = (s) => JSON.parse(JSON.stringify(s, (k, v) => (k === 'additionalProperties' ? undefined : v)));
const schema = geminiSchema(jsonSchema);

export async function explainWithGemini({ letter, igeret, replyLanguage, title }) {
  if (!geminiAvailable()) throw new Error('AI_NOT_CONFIGURED');
  const langLine = replyLanguage ? `שפת המענה: ${replyLanguage}.` : 'שפת המענה: השפה שבה נכתב המכתב.';
  const response = await withFallback((model) => getClient().models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: `${title}:\n"""\n${igeret}\n"""\n\n${langLine}\n\nהמכתב שנכתב לרבי:\n"""\n${letter}\n"""` }] }],
    config: { systemInstruction: SYSTEM, responseMimeType: 'application/json', responseJsonSchema: schema, temperature: 0.4 },
  }));
  const text = response.text;
  if (!text) throw new Error(response.promptFeedback?.blockReason ? 'AI_REFUSED' : 'AI_EMPTY');
  return AnswerSchema.parse(JSON.parse(text));
}

export async function followUpWithGemini({ context, history, question }) {
  if (!geminiAvailable()) throw new Error('AI_NOT_CONFIGURED');
  const contents = [
    { role: 'user', parts: [{ text: context }] },
    { role: 'model', parts: [{ text: 'הבנתי. אשמח לענות על שאלות על הניתוח.' }] },
  ];
  for (const h of history) contents.push({ role: 'user', parts: [{ text: h.q }] }, { role: 'model', parts: [{ text: h.a }] });
  contents.push({ role: 'user', parts: [{ text: question }] });
  const response = await withFallback((model) => getClient().models.generateContent({
    model, contents, config: { systemInstruction: FOLLOWUP_SYSTEM, temperature: 0.5 },
  }));
  if (!response.text) throw new Error(response.promptFeedback?.blockReason ? 'AI_REFUSED' : 'AI_EMPTY');
  return response.text.trim();
}

/** A JSON answer from the first model that is available. */
async function generateJson({ system, text, schema: responseSchema, temperature = 0.2 }) {
  if (!geminiAvailable()) throw new Error('AI_NOT_CONFIGURED');
  const response = await withFallback((model) => getClient().models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text }] }],
    config: { systemInstruction: system, responseMimeType: 'application/json', responseJsonSchema: geminiSchema(responseSchema), temperature },
  }));
  if (!response.text) throw new Error(response.promptFeedback?.blockReason ? 'AI_REFUSED' : 'AI_EMPTY');
  return JSON.parse(response.text);
}

/** Translates `items` (strings) to `language` (ISO 639-1), keeping their order. */
export async function translateWithGemini({ language, items }) {
  const out = await generateJson({ system: TRANSLATE_SYSTEM, text: `שפת היעד: ${language}\n\n${JSON.stringify({ items })}`, schema: translateSchema });
  return TranslateSchema.parse(out).items;
}

/** Expands abbreviations as used on the page. */
export async function acronymsWithGemini({ context, words }) {
  const out = await generateJson({
    system: ACRONYM_SYSTEM, schema: acronymSchema,
    text: `הקטע:\n"""\n${context}\n"""\n\nראשי התיבות לפענוח: ${JSON.stringify(words)}`,
  });
  return AcronymSchema.parse(out).items;
}
