import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { config } from '../config.js';

export { SYSTEM, jsonSchema };
export const AnswerSchema = z.object({
  sourceLanguage: z.enum(['hebrew', 'yiddish', 'english', 'russian', 'other']),
  replyLanguage: z.string(),
  translation: z.string(),
  explanation: z.string(),
  keyQuote: z.string(),
});

/** Translating an existing analysis to another language, and expanding abbreviations – small, shared prompts. */
export const TRANSLATE_SYSTEM = `אתה מתרגם. תקבל רשימת קטעי טקסט (הסבר ותרגום של עמוד מ"אגרות קודש" של הרבי מליובאוויטש) וקוד שפה. תרגם כל קטע לשפה המבוקשת בנאמנות ובלשון מכובדת, ושמור על מבנה הפסקאות והכותרות ("אגרת <מספר>"). החזר JSON בלבד: { "items": [ ...הקטעים המתורגמים באותו סדר... ] }, באותו מספר קטעים בדיוק.`;
export const translateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: { items: { type: 'array', items: { type: 'string' }, description: 'הקטעים המתורגמים, באותו סדר' } },
};
export const TranslateSchema = z.object({ items: z.array(z.string()) });

export const ACRONYM_SYSTEM = `לפניך עמוד מתוך "אגרות קודש" של הרבי מליובאוויטש ורשימת ראשי תיבות וקיצורים המופיעים בו. פענח כל אחד מהם כפי שהוא משמש בהקשר של העמוד, בעברית, "על דרך אפשר": תן את הפענוח הסביר ביותר ראשון, ואם יש כמה אפשרויות הגיוניות – תן עד 3, מהסביר לפחות סביר. קיצור שאינך מזהה – החזר לו רשימה ריקה. החזר JSON בלבד.`;
export const acronymSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['word', 'options'],
        properties: { word: { type: 'string', description: 'הקיצור כפי שנשאל' }, options: { type: 'array', items: { type: 'string' }, description: 'פענוחים אפשריים, הסביר ביותר ראשון' } },
      },
    },
  },
};
export const AcronymSchema = z.object({ items: z.array(z.object({ word: z.string(), options: z.array(z.string()) })) });

export const FOLLOWUP_SYSTEM = `אתה ממשיך שיחה עם אדם שכתב מכתב לרבי מליובאוויטש ופתח עמוד ב"אגרות קודש". לפניך המכתב, העמוד שנפתח והניתוח שכבר נכתב. ענה על שאלת ההמשך שלו בחום ובענייניות, בשפה שבה שאל, בקצרה (עד 3 פסקאות קצרות). התבסס על מה שכתוב בעמוד; אם אינך יודע – אמור זאת. אל תפסוק הלכה; בשאלה הלכתית, רפואית או משפטית הפנה לרב או לאיש מקצוע. החזר טקסט רגיל.`;

const jsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sourceLanguage', 'replyLanguage', 'translation', 'explanation', 'keyQuote'],
  properties: {
    sourceLanguage: { type: 'string', enum: ['hebrew', 'yiddish', 'english', 'russian', 'other'], description: 'השפה העיקרית של העמוד' },
    replyLanguage: { type: 'string', description: 'קוד השפה (ISO 639-1) שבה נכתבו translation, explanation ו-keyQuote' },
    translation: { type: 'string', description: 'תרגום מלא של כל מה שבעמוד לשפת המענה, אגרת אחר אגרת, עם כותרת "אגרת <מספר>" לפני כל אחת. אם הכול כבר בשפת המענה – מחרוזת ריקה' },
    explanation: { type: 'string', description: 'הסבר כיצד מה שבעמוד עשוי להתייחס למה שנכתב במכתב' },
    keyQuote: { type: 'string', description: 'משפט קצר מתוך העמוד (בשפת המענה) שהוא לב המענה' },
  },
};

const SYSTEM = `אתה מסייע לאדם שכתב מכתב לרבי מליובאוויטש. כמנהג, המכתב הונח בכרך של "אגרות קודש" והספר נפתח באקראי; העמוד שנפתח מצורף.
בעמוד יכולות להופיע כמה אגרות: סוף אגרת שהתחילה בעמוד הקודם, אגרות שלמות, ותחילת אגרת שממשיכה בעמוד הבא. כל מה שבעמוד הוא חלק מהמענה.
המשימה:
1. אם העמוד אינו בשפת המענה (בפרט כשהוא באידיש) – תרגם את כל מה שבו, בנאמנות ובלשון מכובדת. ראשי תיבות – פתח אותם בתרגום.
2. כתוב הסבר חם, ענייני ולא מפריז: אילו נקודות בעמוד – מכל אחת מהאגרות שבו – עשויות להתייחס למה שהכותב שיתף, ואיזה כיוון מעשי עולה מהן. התבסס רק על מה שכתוב בעמוד, ואם הקשר אינו ישיר – אמור זאת בפשטות והצע איזו נקודה כללית אפשר לקחת. אל תציג פרשנות כנבואה ואל תפסוק הלכה; בשאלה הלכתית, רפואית או משפטית – הפנה בעדינות לרב, לרופא או לאיש מקצוע.
3. שמור על כבוד ודרך ארץ. ההסבר באורך של 2–4 פסקאות קצרות.
החזר JSON בלבד לפי הסכמה.`;

/** Skip the call entirely when no Claude credentials are configured. */
const hasCredentials = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

let client;
const getClient = () => (client ??= new Anthropic());

/**
 * Translates the opened page when needed and explains how it may answer what was written.
 * @param {{ letter: string, igeret: string, replyLanguage?: string, title: string }} input
 */
export const claudeAvailable = () => hasCredentials();

export async function explainAnswer({ letter, igeret, replyLanguage, title }) {
  if (!hasCredentials()) throw new Error('AI_NOT_CONFIGURED');
  const langLine = replyLanguage ? `שפת המענה: ${replyLanguage}.` : 'שפת המענה: השפה שבה נכתב המכתב.';

  const response = await getClient().beta.messages.create({
    model: config.claude.model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: {
      effort: config.claude.effort,
      format: { type: 'json_schema', schema: jsonSchema },
    },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'text', media_type: 'text/plain', data: igeret }, title },
        { type: 'text', text: `${langLine}\n\nהמכתב שנכתב לרבי:\n"""\n${letter}\n"""` },
      ],
    }],
  });

  if (response.stop_reason === 'refusal') throw new Error('AI_REFUSED');
  if (response.stop_reason === 'max_tokens') throw new Error('AI_TRUNCATED');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return AnswerSchema.parse(JSON.parse(text));
}

/** Claude: a follow-up question about an analysis. history = [{ q, a }, ...] */
export async function followUpClaude({ context, history, question }) {
  if (!hasCredentials()) throw new Error('AI_NOT_CONFIGURED');
  const messages = [{ role: 'user', content: context }, { role: 'assistant', content: 'הבנתי. אשמח לענות על שאלות על הניתוח.' }];
  for (const h of history) messages.push({ role: 'user', content: h.q }, { role: 'assistant', content: h.a });
  messages.push({ role: 'user', content: question });
  const response = await getClient().beta.messages.create({
    model: config.claude.model, max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    output_config: { effort: 'low' }, system: FOLLOWUP_SYSTEM, messages,
  });
  if (response.stop_reason === 'refusal') throw new Error('AI_REFUSED');
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

const jsonOf = (response) => {
  if (response.stop_reason === 'refusal') throw new Error('AI_REFUSED');
  if (response.stop_reason === 'max_tokens') throw new Error('AI_TRUNCATED');
  return JSON.parse(response.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
};

/** Claude: translates `items` (strings) to `language` (ISO 639-1), keeping their order. */
export async function translateClaude({ language, items }) {
  if (!hasCredentials()) throw new Error('AI_NOT_CONFIGURED');
  const response = await getClient().beta.messages.create({
    model: config.claude.model, max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: translateSchema } },
    system: TRANSLATE_SYSTEM,
    messages: [{ role: 'user', content: `שפת היעד: ${language}\n\n${JSON.stringify({ items })}` }],
  });
  return TranslateSchema.parse(jsonOf(response)).items;
}

/** Claude: expands abbreviations as used on the page. */
export async function acronymsClaude({ context, words }) {
  if (!hasCredentials()) throw new Error('AI_NOT_CONFIGURED');
  const response = await getClient().beta.messages.create({
    model: config.claude.model, max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: acronymSchema } },
    system: ACRONYM_SYSTEM,
    messages: [{ role: 'user', content: `העמוד:\n"""\n${context}\n"""\n\nראשי התיבות לפענוח: ${JSON.stringify(words)}` }],
  });
  return AcronymSchema.parse(jsonOf(response)).items;
}
