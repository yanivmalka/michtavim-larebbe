// Gemini (Google AI Studio) – translation, explanation and follow-up questions.
import { GoogleGenAI } from '@google/genai';
import { SYSTEM, FOLLOWUP_SYSTEM, jsonSchema, AnswerSchema } from './explain.js';

const MODEL = () => process.env.GEMINI_MODEL || 'gemini-flash-latest';
export const geminiAvailable = () => Boolean(process.env.GEMINI_API_KEY);

let client;
const getClient = () => (client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));

// Gemini's schema dialect has no additionalProperties
const { additionalProperties, ...schema } = jsonSchema;

export async function explainWithGemini({ letter, igeret, replyLanguage, title }) {
  if (!geminiAvailable()) throw new Error('AI_NOT_CONFIGURED');
  const langLine = replyLanguage ? `שפת המענה: ${replyLanguage}.` : 'שפת המענה: השפה שבה נכתב המכתב.';
  const response = await getClient().models.generateContent({
    model: MODEL(),
    contents: [{ role: 'user', parts: [{ text: `${title}:\n"""\n${igeret}\n"""\n\n${langLine}\n\nהמכתב שנכתב לרבי:\n"""\n${letter}\n"""` }] }],
    config: { systemInstruction: SYSTEM, responseMimeType: 'application/json', responseJsonSchema: schema, temperature: 0.4 },
  });
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
  const response = await getClient().models.generateContent({
    model: MODEL(), contents, config: { systemInstruction: FOLLOWUP_SYSTEM, temperature: 0.5 },
  });
  if (!response.text) throw new Error(response.promptFeedback?.blockReason ? 'AI_REFUSED' : 'AI_EMPTY');
  return response.text.trim();
}
