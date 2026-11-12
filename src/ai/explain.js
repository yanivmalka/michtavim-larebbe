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
  sources: z.array(z.string()).default([]),
});

/** Shared rule: an answer in Hebrew (or any language) must not mix in letters of another script. */
export const SCRIPT_RULE = 'כתוב אך ורק באותיות של שפת היעד (עברית – באותיות עבריות בלבד). אל תשלב אותיות ערביות, פרסיות או תווים מכתב אחר, גם לא במילה בודדת; אם מילה אינה ידועה לך – השאר אותה כפי שהיא במקור.';

/** Translating an existing analysis to another language, and expanding abbreviations – small, shared prompts. */
export const TRANSLATE_SYSTEM = `אתה מתרגם. תקבל רשימת קטעי טקסט (הסבר ותרגום של עמוד מ"אגרות קודש" של הרבי מליובאוויטש) וקוד שפה. תרגם כל קטע לשפה המבוקשת בנאמנות ובלשון מכובדת, ושמור על מבנה הפסקאות והכותרות ("אגרת <מספר>"). ${SCRIPT_RULE} החזר JSON בלבד: { "items": [ ...הקטעים המתורגמים באותו סדר... ] }, באותו מספר קטעים בדיוק.`;
export const translateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: { items: { type: 'array', items: { type: 'string' }, description: 'הקטעים המתורגמים, באותו סדר' } },
};
export const TranslateSchema = z.object({ items: z.array(z.string()) });

export const ACRONYM_SYSTEM = `לפניך קטע (משפט או עמוד) מתוך "אגרות קודש" של הרבי מליובאוויטש ורשימת ראשי תיבות וקיצורים המופיעים בו. פענח כל אחד מהם כפי שהוא משמש בהקשר של הקטע, בעברית, "על דרך אפשר": תן את הפענוח הסביר ביותר ראשון, ואם יש כמה אפשרויות הגיוניות – תן עד 3, מהסביר לפחות סביר. קיצור שאינך מזהה – החזר לו רשימה ריקה. החזר JSON בלבד.`;
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
  required: ['sourceLanguage', 'replyLanguage', 'translation', 'explanation', 'keyQuote', 'sources'],
  properties: {
    sourceLanguage: { type: 'string', enum: ['hebrew', 'yiddish', 'english', 'russian', 'other'], description: 'השפה העיקרית של העמוד' },
    replyLanguage: { type: 'string', description: 'קוד השפה (ISO 639-1) שבה נכתבו translation, explanation ו-keyQuote' },
    translation: { type: 'string', description: 'תרגום מלא של כל מה שבעמוד לשפת המענה, אגרת אחר אגרת, עם כותרת "אגרת <מספר>" לפני כל אחת. אם הכול כבר בשפת המענה – מחרוזת ריקה' },
    explanation: { type: 'string', description: 'הסבר כיצד מה שבעמוד עשוי להתייחס למה שנכתב במכתב' },
    keyQuote: { type: 'string', description: 'משפט קצר מתוך העמוד (בשפת המענה) שהוא לב המענה' },
    sources: { type: 'array', items: { type: 'string' }, description: 'הקטעים שבעמוד שעליהם מושתת ההסבר: 2–6 ציטוטים קצרים (5–25 מילים), מועתקים מילה במילה מטקסט העמוד כפי שהוא, בשפת המקור ובלי שינוי' },
  },
};

const SYSTEM = `אתה מסייע לאדם שכתב מכתב לרבי מליובאוויטש. כמנהג, המכתב הונח בכרך של "אגרות קודש" והספר נפתח באקראי; העמוד שנפתח מצורף.
בעמוד יכולות להופיע כמה אגרות: סוף אגרת שהתחילה בעמוד הקודם, אגרות שלמות, ותחילת אגרת שממשיכה בעמוד הבא. כל מה שבעמוד הוא חלק מהמענה.
המשימה:
1. אם העמוד אינו בשפת המענה (בפרט כשהוא באידיש) – תרגם את כל מה שבו, בנאמנות ובלשון מכובדת. ראשי תיבות – פתח אותם בתרגום.
2. כתוב הסבר חם, ענייני ולא מפריז: אילו נקודות בעמוד – מכל אחת מהאגרות שבו – עשויות להתייחס למה שהכותב שיתף, ואיזה כיוון מעשי עולה מהן. התבסס רק על מה שכתוב בעמוד, ואם הקשר אינו ישיר – אמור זאת בפשטות והצע איזו נקודה כללית אפשר לקחת. אל תציג פרשנות כנבואה ואל תפסוק הלכה; בשאלה הלכתית, רפואית או משפטית – הפנה בעדינות לרב, לרופא או לאיש מקצוע.
3. שמור על כבוד ודרך ארץ. ההסבר באורך של 2–4 פסקאות קצרות.
4. ב-sources החזר את הקטעים שבעמוד שעליהם מושתת ההסבר: 2–6 ציטוטים קצרים (5–25 מילים כל אחד), מועתקים מילה במילה מטקסט העמוד כפי שהוא (בשפת המקור, בלי לתרגם ובלי לתקן), כדי שאפשר יהיה לסמן אותם על גבי העמוד.
${SCRIPT_RULE}
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
    messages: [{ role: 'user', content: `הקטע:\n"""\n${context}\n"""\n\nראשי התיבות לפענוח: ${JSON.stringify(words)}` }],
  });
  return AcronymSchema.parse(jsonOf(response)).items;
}

/** Reading a photo of a printed Igrot Kodesh page: only its numbers, not the text (the text comes from the library). */
export const PHOTO_SYSTEM = `לפניך צילום. בדוק אם הוא צילום של עמוד מהספר "אגרות קודש" של הרבי מליובאוויטש (או מספר אחר שאגרותיו ממוספרות באותו אופן). אל תעתיק את הטקסט – קרא רק את המספרים:
- volume: מספר הכרך (החלק) אם הוא מופיע בכותרת העמוד, אחרת מחרוזת ריקה.
- page: מספר העמוד המודפס (בספרות או באותיות), אחרת מחרוזת ריקה.
- letters: מספרי האגרות שכותרתן מופיעה בעמוד, לפי סדר הופעתן, כפי שהם מודפסים (באותיות עבריות, כולל גרש לאלפים וכוכבית אם יש, למשל "א'תתקסו" או "קמא*").
- continuesFromPrevious: true אם בראש העמוד ממשיכה אגרת שהתחילה בעמוד קודם (לפני כותרת האגרת הראשונה).
- isIgrot: false אם זה אינו עמוד מאגרות קודש. readable: false אם הצילום מטושטש או חתוך כך שאי אפשר לקרוא את מספרי האגרות.
החזר JSON בלבד.`;
export const photoSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['isIgrot', 'readable', 'volume', 'page', 'letters', 'continuesFromPrevious'],
  properties: {
    isIgrot: { type: 'boolean' },
    readable: { type: 'boolean' },
    volume: { type: 'string' },
    page: { type: 'string' },
    letters: { type: 'array', items: { type: 'string' } },
    continuesFromPrevious: { type: 'boolean' },
  },
};
export const PhotoSchema = z.object({
  isIgrot: z.boolean(),
  readable: z.boolean(),
  volume: z.string().default(''),
  page: z.string().default(''),
  letters: z.array(z.string()).default([]),
  continuesFromPrevious: z.boolean().default(false),
});

export const TRANSCRIBE_SYSTEM = `תמלל את ההקלטה מילה במילה, בשפה שבה דוברים (בדרך כלל עברית), עם פיסוק נכון. זהו מכתב שאדם מכתיב לרבי. אל תוסיף, אל תסכם ואל תתרגם. ${SCRIPT_RULE} אם אין בהקלטה דיבור ברור – החזר מחרוזת ריקה. החזר את התמליל בלבד.`;

/** Claude: the numbers on a photographed page. */
export async function readPhotoClaude({ data, mimeType }) {
  if (!hasCredentials()) throw new Error('AI_NOT_CONFIGURED');
  const response = await getClient().beta.messages.create({
    model: config.claude.model, max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: photoSchema } },
    system: PHOTO_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mimeType, data } }, { type: 'text', text: 'מה המספרים בעמוד?' }] }],
  });
  return PhotoSchema.parse(jsonOf(response));
}

/** A name for the chat and a one-line summary of a letter (shown when the letter is minimized). */
export const SUMMARY_SYSTEM = `לפניך מכתב שאדם כתב לרבי מליובאוויטש. החזר JSON בלבד:
- title: שם קצר לשיחה, 2–4 מילים, לפי נושא המכתב (למשל "ברכה לרפואה", "התלבטות בעבודה"). בלי פתיחות כבוד, בלי שמות פרטיים ובלי מירכאות.
- line: שורה אחת קצרה (עד 8 מילים) המתארת על מה המכתב, בגוף שלישי או כצירוף שמני.
כתוב בשפת המכתב. ${SCRIPT_RULE}`;
export const summarySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'line'],
  properties: { title: { type: 'string' }, line: { type: 'string' } },
};
export const SummarySchema = z.object({ title: z.string(), line: z.string() });

/** Aramaic in the letters (Zohar, Gemara, Tanya quotes): the phrase around a word, translated, and word by word. */
export const ARAMAIC_SYSTEM = `לפניך משפט מתוך "אגרות קודש" של הרבי מליובאוויטש, ומילה (או קטע) שהקורא סימן בו. מצא את הרצף הארמי המלא שהמילה שייכת אליו (ציטוט מהזוהר, מהגמרא, מהתרגום וכדומה) ותרגם אותו לשפת היעד.
החזר JSON בלבד:
- isAramaic: false אם המילה והרצף שסביבה אינם ארמית (ואז שאר השדות ריקים).
- phrase: הרצף הארמי כפי שהוא במשפט.
- translation: תרגום הרצף כמשפט אחד, נאמן וקריא.
- words: לכל מילה ברצף, לפי הסדר – המילה ופירושה הקצר בשפת היעד.
${SCRIPT_RULE}`;
export const aramaicSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['isAramaic', 'phrase', 'translation', 'words'],
  properties: {
    isAramaic: { type: 'boolean' },
    phrase: { type: 'string' },
    translation: { type: 'string' },
    words: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['word', 'meaning'], properties: { word: { type: 'string' }, meaning: { type: 'string' } } },
    },
  },
};
export const AramaicSchema = z.object({
  isAramaic: z.boolean(),
  phrase: z.string().default(''),
  translation: z.string().default(''),
  words: z.array(z.object({ word: z.string(), meaning: z.string() })).default([]),
});

/** Claude: a small JSON answer to a small prompt. */
export async function smallJsonClaude({ system, text, schema }) {
  if (!hasCredentials()) throw new Error('AI_NOT_CONFIGURED');
  const response = await getClient().beta.messages.create({
    model: config.claude.model, max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: text }],
  });
  return jsonOf(response);
}
